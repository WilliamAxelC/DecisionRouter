import { getModelPricing } from "../../src/config/loader.js";
import type { ProfileConfig, RouterConfig } from "../../src/config/schema.js";
import type { ClassifierDecision } from "../../src/router/gemini-classifier.js";
import {
  HARD_BENCHMARK_FAMILIES,
  type CascadeCheckRecord,
  type DecisionProbeCache,
  type HardBenchmarkFamily,
  type HardBenchTask,
  type LiveModelResponse,
  type SelfGradeRecord,
} from "./types.js";

export interface ArmMetricsRow {
  label: string;
  n: number;
  passed: number;
  accuracyPct: number;
  hydrogenRetentionPct: number;
  regretCount: number;
  bonusCount: number;
  selfCount: number;
  lightCount: number;
  highCount: number;
  cascadeCount: number;
  cascadeRecoveredCount: number;
  meanLatencyMs: number;
  p50LatencyMs: number;
  speedupVsHydrogen: number;
  totalCostUsd: number;
  costSavingsVsHydrogenPct: number;
}

export interface FamilyBreakdownRow {
  family: HardBenchmarkFamily;
  completedPairs: number;
  totalTasks: number;
  lightAccPct: number;
  hydrogenAccPct: number;
  oracleAccPct: number;
  qualityAccPct: number;
  balancedAccPct: number;
  ecoAccPct: number;
  avgRiskScore: number;
}

export interface ApiTelemetryRow {
  model: string;
  totalEvents: number;
  ok200: number;
  err429: number;
  err503: number;
  otherErrors: number;
  quarantinedKeys: number;
}

export interface HardBenchmarkReportData {
  generatedAt: string;
  totalTasks: number;
  decisionCompleted: number;
  lightCompleted: number;
  highCompleted: number;
  pairedCompleted: number;
  lightModel: string;
  highModel: string;
  decisionModel: string;
  arms: ArmMetricsRow[];
  familyBreakdown: FamilyBreakdownRow[];
  apiTelemetry: ApiTelemetryRow[];
  notableMisses: Array<{
    taskId: string;
    family: string;
    riskScore: number;
    lightPassed: boolean;
    highPassed: boolean;
    qualityTier: string;
    detail: string;
  }>;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Number(sorted[idx].toFixed(1));
}

function costForResponse(
  config: RouterConfig,
  modelLabel: string,
  res: LiveModelResponse,
): number {
  const baseModel = modelLabel.split("@")[0];
  const pricing = getModelPricing(config, "gemini", baseModel);
  return (
    (res.promptTokens * pricing.inputPer1M +
      (res.outputTokens + res.thinkingTokens) * pricing.outputPer1M) /
    1_000_000
  );
}

/**
 * Simulates DecisionRouter v2 profile routing (`auto:quality`, `auto:balanced`, `auto:eco`)
 * purely over cached live `gemini-decision-1` signals + live Flash/Hydrogen outputs + cascade.
 */
function routeWithCachedSignals(
  task: HardBenchTask,
  probe: DecisionProbeCache,
  profile: ProfileConfig,
): {
  tier: "self" | "light" | "high";
  riskScore: number;
  selfAnswer?: string;
} {
  const d: ClassifierDecision = probe.rawDecision;
  const riskScore = d.riskScore ?? 0.5;
  const sig = d.signals;

  const canSelf =
    profile.allowSelfAnswer &&
    (task.tools?.length ?? 0) === 0 &&
    Boolean(d.directAnswer) &&
    (sig?.selfAnswerConfidence ?? 0) >= profile.selfConfidenceMin &&
    riskScore < profile.selfMaxRisk;

  if (canSelf && d.directAnswer) {
    return { tier: "self", riskScore, selfAnswer: d.directAnswer };
  }

  // Note: live Bench config maps trivial+standard -> light (3.8-flash), complex+frontier -> high (4-hydrogen)
  if (riskScore >= profile.highRiskThreshold && profile.maxTier !== "trivial" && profile.maxTier !== "standard") {
    return { tier: "high", riskScore };
  }
  return { tier: "light", riskScore };
}

export function buildHardBenchmarkReportData(params: {
  config: RouterConfig;
  tasks: HardBenchTask[];
  decisions: Map<string, DecisionProbeCache>;
  lightResponses: Map<string, LiveModelResponse>;
  highResponses: Map<string, LiveModelResponse>;
  selfGrades: Map<string, SelfGradeRecord>;
  cascadeChecks: Map<string, CascadeCheckRecord>;
  apiTelemetry: ApiTelemetryRow[];
  lightModel: string;
  highModel: string;
  decisionModel: string;
}): HardBenchmarkReportData {
  const {
    config,
    tasks,
    decisions,
    lightResponses,
    highResponses,
    selfGrades,
    cascadeChecks,
    apiTelemetry,
    lightModel,
    highModel,
    decisionModel,
  } = params;

  const pairedTasks = tasks.filter(
    (t) =>
      decisions.has(t.id) &&
      lightResponses.has(t.id) &&
      highResponses.has(t.id),
  );

  const n = pairedTasks.length;
  const highPassedTotal = pairedTasks.filter((t) => highResponses.get(t.id)!.passed).length;
  const highMeanLat =
    n > 0
      ? pairedTasks.reduce((s, t) => s + highResponses.get(t.id)!.latencyMs, 0) / n
      : 0;
  const highTotalCost = pairedTasks.reduce(
    (s, t) => s + costForResponse(config, highModel, highResponses.get(t.id)!),
    0,
  );

  const buildFixedArm = (
    label: string,
    role: "light" | "high",
    modelName: string,
  ): ArmMetricsRow => {
    const map = role === "light" ? lightResponses : highResponses;
    const lats = pairedTasks.map((t) => map.get(t.id)!.latencyMs);
    const passed = pairedTasks.filter((t) => map.get(t.id)!.passed).length;
    const cost = pairedTasks.reduce(
      (s, t) => s + costForResponse(config, modelName, map.get(t.id)!),
      0,
    );
    const meanLat = n > 0 ? lats.reduce((a, b) => a + b, 0) / n : 0;
    let regret = 0;
    let bonus = 0;
    if (role === "light") {
      for (const t of pairedTasks) {
        const lp = lightResponses.get(t.id)!.passed;
        const hp = highResponses.get(t.id)!.passed;
        if (hp && !lp) regret++;
        if (lp && !hp) bonus++;
      }
    }
    return {
      label,
      n,
      passed,
      accuracyPct: n > 0 ? Number(((passed / n) * 100).toFixed(1)) : 0,
      hydrogenRetentionPct:
        highPassedTotal > 0 ? Number(((passed / highPassedTotal) * 100).toFixed(1)) : 0,
      regretCount: regret,
      bonusCount: bonus,
      selfCount: 0,
      lightCount: role === "light" ? n : 0,
      highCount: role === "high" ? n : 0,
      cascadeCount: 0,
      cascadeRecoveredCount: 0,
      meanLatencyMs: Number(meanLat.toFixed(1)),
      p50LatencyMs: percentile(lats, 50),
      speedupVsHydrogen: meanLat > 0 && highMeanLat > 0 ? Number((highMeanLat / meanLat).toFixed(2)) : 1,
      totalCostUsd: Number(cost.toFixed(6)),
      costSavingsVsHydrogenPct:
        highTotalCost > 0
          ? Number((((highTotalCost - cost) / highTotalCost) * 100).toFixed(1))
          : 0,
    };
  };

  // Oracle router: picks cheapest tier that actually passed (light < high)
  const buildOracleArm = (): ArmMetricsRow => {
    let passed = 0;
    let lightCount = 0;
    let highCount = 0;
    let cost = 0;
    const lats: number[] = [];
    for (const t of pairedTasks) {
      const l = lightResponses.get(t.id)!;
      const h = highResponses.get(t.id)!;
      if (l.passed) {
        passed++;
        lightCount++;
        lats.push(l.latencyMs);
        cost += costForResponse(config, lightModel, l);
      } else if (h.passed) {
        passed++;
        highCount++;
        lats.push(h.latencyMs);
        cost += costForResponse(config, highModel, h);
      } else {
        lightCount++;
        lats.push(l.latencyMs);
        cost += costForResponse(config, lightModel, l);
      }
    }
    const meanLat = n > 0 ? lats.reduce((a, b) => a + b, 0) / n : 0;
    return {
      label: "Oracle Router (Ceiling)",
      n,
      passed,
      accuracyPct: n > 0 ? Number(((passed / n) * 100).toFixed(1)) : 0,
      hydrogenRetentionPct:
        highPassedTotal > 0 ? Number(((passed / highPassedTotal) * 100).toFixed(1)) : 0,
      regretCount: 0,
      bonusCount: passed - highPassedTotal,
      selfCount: 0,
      lightCount,
      highCount,
      cascadeCount: 0,
      cascadeRecoveredCount: 0,
      meanLatencyMs: Number(meanLat.toFixed(1)),
      p50LatencyMs: percentile(lats, 50),
      speedupVsHydrogen: meanLat > 0 && highMeanLat > 0 ? Number((highMeanLat / meanLat).toFixed(2)) : 1,
      totalCostUsd: Number(cost.toFixed(6)),
      costSavingsVsHydrogenPct:
        highTotalCost > 0
          ? Number((((highTotalCost - cost) / highTotalCost) * 100).toFixed(1))
          : 0,
    };
  };

  const evaluateProfileArm = (profileName: string, label: string): ArmMetricsRow => {
    const profile =
      config.profiles[profileName] ??
      config.profiles.auto ??
      Object.values(config.profiles)[0];

    let passed = 0;
    let regret = 0;
    let bonus = 0;
    let selfCount = 0;
    let lightCount = 0;
    let highCount = 0;
    let cascadeCount = 0;
    let cascadeRecoveredCount = 0;
    let totalCost = 0;
    const lats: number[] = [];

    for (const t of pairedTasks) {
      const probe = decisions.get(t.id)!;
      const light = lightResponses.get(t.id)!;
      const high = highResponses.get(t.id)!;
      const route = routeWithCachedSignals(t, probe, profile);

      let taskPassed = false;
      let taskLat = probe.latencyMs;
      let taskCost = 0;

      if (route.tier === "self") {
        selfCount++;
        const sg = selfGrades.get(`${t.id}:${profileName}`) ?? selfGrades.get(t.id);
        taskPassed = sg ? sg.passed : false;
        lats.push(taskLat);
      } else if (route.tier === "high") {
        highCount++;
        taskPassed = high.passed;
        taskLat += high.latencyMs;
        taskCost += costForResponse(config, highModel, high);
        lats.push(taskLat);
      } else {
        // Check non-streaming cascade verification if enabled
        const cas = cascadeChecks.get(t.id);
        const triggered =
          profile.cascadeVerifyEnabled &&
          cas &&
          (cas.structuralTriggered || cas.decisionTriggered);

        if (triggered && profile.maxTier !== "trivial" && profile.maxTier !== "standard") {
          cascadeCount++;
          taskPassed = high.passed;
          if (!light.passed && high.passed) cascadeRecoveredCount++;
          taskLat += light.latencyMs + (cas?.verifyMs ?? 0) + high.latencyMs;
          taskCost +=
            costForResponse(config, lightModel, light) +
            costForResponse(config, highModel, high);
          lats.push(taskLat);
        } else {
          lightCount++;
          taskPassed = light.passed;
          taskLat += light.latencyMs;
          taskCost += costForResponse(config, lightModel, light);
          lats.push(taskLat);
        }
      }

      if (taskPassed) passed++;
      if (high.passed && !taskPassed) regret++;
      if (taskPassed && !high.passed) bonus++;
      totalCost += taskCost;
    }

    const meanLat = n > 0 ? lats.reduce((a, b) => a + b, 0) / n : 0;
    return {
      label,
      n,
      passed,
      accuracyPct: n > 0 ? Number(((passed / n) * 100).toFixed(1)) : 0,
      hydrogenRetentionPct:
        highPassedTotal > 0 ? Number(((passed / highPassedTotal) * 100).toFixed(1)) : 0,
      regretCount: regret,
      bonusCount: bonus,
      selfCount,
      lightCount,
      highCount,
      cascadeCount,
      cascadeRecoveredCount,
      meanLatencyMs: Number(meanLat.toFixed(1)),
      p50LatencyMs: percentile(lats, 50),
      speedupVsHydrogen: meanLat > 0 && highMeanLat > 0 ? Number((highMeanLat / meanLat).toFixed(2)) : 1,
      totalCostUsd: Number(totalCost.toFixed(6)),
      costSavingsVsHydrogenPct:
        highTotalCost > 0
          ? Number((((highTotalCost - totalCost) / highTotalCost) * 100).toFixed(1))
          : 0,
    };
  };

  const arms: ArmMetricsRow[] = [
    buildFixedArm(`Light-Only (${lightModel})`, "light", lightModel),
    buildFixedArm(`Smart-Only (${highModel})`, "high", highModel),
    buildOracleArm(),
    evaluateProfileArm("auto:quality", "DecisionRouter v2 (auto:quality)"),
    evaluateProfileArm("auto:balanced", "DecisionRouter v2 (auto:balanced)"),
    evaluateProfileArm("auto:eco", "DecisionRouter v2 (auto:eco)"),
  ];

  const qProfile = config.profiles["auto:quality"] ?? config.profiles.auto;
  const bProfile = config.profiles["auto:balanced"] ?? config.profiles.auto;
  const eProfile = config.profiles["auto:eco"] ?? config.profiles.auto;

  const evalSingleForProfile = (
    t: HardBenchTask,
    profile: ProfileConfig,
    profileName: string,
  ): { passed: boolean; tier: string } => {
    const r = routeWithCachedSignals(t, decisions.get(t.id)!, profile);
    if (r.tier === "self") {
      const sg = selfGrades.get(`${t.id}:${profileName}`) ?? selfGrades.get(t.id);
      return { passed: sg ? sg.passed : false, tier: "self" };
    }
    if (r.tier === "high") return { passed: highResponses.get(t.id)!.passed, tier: "high" };
    const cas = cascadeChecks.get(t.id);
    if (profile.cascadeVerifyEnabled && cas && (cas.structuralTriggered || cas.decisionTriggered)) {
      return { passed: highResponses.get(t.id)!.passed, tier: "cascade->high" };
    }
    return { passed: lightResponses.get(t.id)!.passed, tier: "light" };
  };

  const familyBreakdown: FamilyBreakdownRow[] = HARD_BENCHMARK_FAMILIES.map((fam) => {
    const allInFam = tasks.filter((t) => t.family === fam);
    const doneInFam = pairedTasks.filter((t) => t.family === fam);
    const k = doneInFam.length;
    const pct = (cnt: number) => (k > 0 ? Number(((cnt / k) * 100).toFixed(1)) : 0);

    let lPass = 0;
    let hPass = 0;
    let oPass = 0;
    let qPass = 0;
    let bPass = 0;
    let ePass = 0;
    let riskSum = 0;

    for (const t of doneInFam) {
      const l = lightResponses.get(t.id)!.passed;
      const h = highResponses.get(t.id)!.passed;
      if (l) lPass++;
      if (h) hPass++;
      if (l || h) oPass++;
      if (evalSingleForProfile(t, qProfile, "auto:quality").passed) qPass++;
      if (evalSingleForProfile(t, bProfile, "auto:balanced").passed) bPass++;
      if (evalSingleForProfile(t, eProfile, "auto:eco").passed) ePass++;
      riskSum += decisions.get(t.id)!.rawDecision.riskScore ?? 0.5;
    }

    return {
      family: fam,
      completedPairs: k,
      totalTasks: allInFam.length,
      lightAccPct: pct(lPass),
      hydrogenAccPct: pct(hPass),
      oracleAccPct: pct(oPass),
      qualityAccPct: pct(qPass),
      balancedAccPct: pct(bPass),
      ecoAccPct: pct(ePass),
      avgRiskScore: k > 0 ? Number((riskSum / k).toFixed(3)) : 0,
    };
  });

  const notableMisses: HardBenchmarkReportData["notableMisses"] = [];
  for (const t of pairedTasks) {
    const l = lightResponses.get(t.id)!;
    const h = highResponses.get(t.id)!;
    const qRes = evalSingleForProfile(t, qProfile, "auto:quality");
    if (!h.passed || (h.passed && !qRes.passed)) {
      notableMisses.push({
        taskId: t.id,
        family: t.family,
        riskScore: decisions.get(t.id)!.rawDecision.riskScore ?? 0,
        lightPassed: l.passed,
        highPassed: h.passed,
        qualityTier: qRes.tier,
        detail: `${!h.passed ? "HighMissed: " + h.gradeDetail : "RouterRegret: " + l.gradeDetail}`,
      });
    }
    if (notableMisses.length >= 20) break;
  }

  return {
    generatedAt: new Date().toISOString(),
    totalTasks: tasks.length,
    decisionCompleted: decisions.size,
    lightCompleted: lightResponses.size,
    highCompleted: highResponses.size,
    pairedCompleted: n,
    lightModel,
    highModel,
    decisionModel,
    arms,
    familyBreakdown,
    apiTelemetry,
    notableMisses,
  };
}

export function renderHardBenchmarkReport(data: HardBenchmarkReportData): string {
  const pctDone =
    data.totalTasks > 0
      ? ((data.pairedCompleted / data.totalTasks) * 100).toFixed(1)
      : "0.0";

  const lines: string[] = [
    `# DecisionRouter v2 — Hard Real-World Live Benchmark Report`,
    ``,
    `- **Generated:** ${data.generatedAt}`,
    `- **Dataset Scope:** ${data.totalTasks} real unsaturated tasks across 9 public benchmarks (\`BigCodeBench-Hard\`, \`AIME 2025\`, \`LiveBench Reasoning/Math/Data\`, \`SimpleQA Verified\`, \`IFEval\`, \`BFCL v4\`, \`MultiChallenge\`)`,
    `- **Live Models:** Classifier \`${data.decisionModel}\` (\`POST /v1beta/decisions\`) | Light \`${data.lightModel}\` | Smart \`${data.highModel}\``,
    `- **Live Completion Status:** Decision \`${data.decisionCompleted}/${data.totalTasks}\` | Light \`${data.lightCompleted}/${data.totalTasks}\` | Smart \`${data.highCompleted}/${data.totalTasks}\` | **Paired Graded Pairs:** \`${data.pairedCompleted}/${data.totalTasks} (${pctDone}%)\``,
    ``,
  ];

  if (data.pairedCompleted === 0) {
    lines.push(
      `> **Waiting for first completed Light + Smart + Decision pair.** Runner is actively draining queued jobs cleanly across API backoffs/cooldowns.`,
      ``,
    );
  } else {
    lines.push(
      `## 1. End-to-End Live Comparison (${data.pairedCompleted} Completed Task Pairs)`,
      ``,
      `| Arm / Profile | Accuracy | Hydrogen Retained | Regret | Bonus | Tier Split (\`self\` / \`light\` / \`cas\` / \`high\`) | Mean / p50 Latency | Speedup vs Hydrogen | Cost USD (Savings) |`,
      `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    );

    for (const a of data.arms) {
      lines.push(
        `| ${a.label} | **${a.passed}/${a.n} (${a.accuracyPct}%)** | ${a.hydrogenRetentionPct}% | ${a.regretCount} | ${a.bonusCount} | ${a.selfCount} / ${a.lightCount} / ${a.cascadeCount} (${a.cascadeRecoveredCount} rec) / ${a.highCount} | ${a.meanLatencyMs}ms / ${a.p50LatencyMs}ms | **${a.speedupVsHydrogen}x** | $${a.totalCostUsd.toFixed(6)} (${a.costSavingsVsHydrogenPct}%) |`,
      );
    }
    lines.push(``);
  }

  lines.push(
    `## 2. Per-Benchmark Breakdown (9 Real Families)`,
    ``,
    `| Benchmark Family | Pairs Done | Light (\`${data.lightModel}\`) | Smart (\`${data.highModel}\`) | Oracle Ceiling | \`auto:quality\` | \`auto:balanced\` | \`auto:eco\` | Avg \`riskScore\` |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  );

  for (const row of data.familyBreakdown) {
    lines.push(
      `| \`${row.family}\` | ${row.completedPairs}/${row.totalTasks} | ${row.lightAccPct}% | **${row.hydrogenAccPct}%** | ${row.oracleAccPct}% | **${row.qualityAccPct}%** | ${row.balancedAccPct}% | ${row.ecoAccPct}% | ${row.avgRiskScore.toFixed(3)} |`,
    );
  }
  lines.push(``);

  lines.push(
    `## 3. Free API Resilience & Backoff Telemetry`,
    ``,
    `| Model | Total Calls | HTTP 200 | HTTP 429 | HTTP 503 | Other/Timeout | Quarantined Keys |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
  );
  for (const t of data.apiTelemetry) {
    lines.push(
      `| \`${t.model}\` | ${t.totalEvents} | ${t.ok200} | ${t.err429} | ${t.err503} | ${t.otherErrors} | ${t.quarantinedKeys} |`,
    );
  }
  lines.push(``);

  if (data.notableMisses.length > 0) {
    lines.push(
      `## 4. Notable Failure Modes (Where Hydrogen or Router Missed)`,
      ``,
      `| Task ID | Family | Risk | Light | Hydrogen | \`auto:quality\` Tier | Detail |`,
      `| --- | --- | --- | --- | --- | --- | --- |`,
    );
    for (const m of data.notableMisses) {
      lines.push(
        `| \`${m.taskId}\` | \`${m.family}\` | ${m.riskScore.toFixed(2)} | ${m.lightPassed ? "PASS" : "FAIL"} | ${m.highPassed ? "PASS" : "FAIL"} | ${m.qualityTier} | ${m.detail.replace(/\|/g, "/").slice(0, 90)} |`,
      );
    }
    lines.push(``);
  }

  return lines.join("\n");
}
