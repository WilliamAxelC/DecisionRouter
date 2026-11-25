#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../src/config/loader.js";
import type { RouterConfig } from "../../src/config/schema.js";
import { DecisionEngine } from "../../src/router/engine.js";
import { createApp } from "../../src/server.js";
import { DecisionStore, type RouterStatsSummary } from "../../src/storage/db.js";
import { gradeResponse } from "./grader.js";
import { buildTextEvalSimConfig, startTextEvalMockServers } from "./mock-llms.js";
import { TEXT_EVAL_TASKS, type TextEvalTask, type TextTaskCategory } from "./tasks.js";

export type TextEvalMode = "simulated" | "live";

export interface ArmTaskOutcome {
  taskId: string;
  category: TextTaskCategory;
  turns: number;
  passed: boolean;
  turn1Passed: boolean;
  finalModel: string;
  totalMs: number;
  answer: string;
}

export interface ArmSummary {
  armName: "light-only" | "smart-only" | "decision-router";
  modelLabel: string;
  totalTasks: number;
  passedTasks: number;
  accuracyPct: number;
  totalLatencyMs: number;
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  estimatedCostUsd: number;
  sqliteStats: RouterStatsSummary;
  outcomes: ArmTaskOutcome[];
}

export interface RouterLogEntry {
  timestamp: string;
  taskId: string;
  category: TextTaskCategory;
  turn: number;
  tier: string;
  source: string;
  selfHandled: boolean;
  escalated: boolean;
  cacheSticky: boolean;
  switchedFrom: string | null;
  selectedModel: string;
  decisionMs: number;
  upstreamMs: number;
  totalMs: number;
  reason: string;
  answerPreview: string;
  passed: boolean;
  lightPassed?: boolean;
  smartPassed?: boolean;
  routerRegret?: boolean;
}

export interface SwitchEvent {
  taskId: string;
  turn: number;
  fromModel: string;
  toModel: string;
  reason: string;
  escalated: boolean;
}

export interface TextEvalReport {
  runId: string;
  timestamp: string;
  mode: TextEvalMode;
  taskCount: number;
  arms: {
    lightOnly: ArmSummary;
    smartOnly: ArmSummary;
    decisionRouter: ArmSummary;
  };
  comparisons: {
    accuracyDeltaVsLightPct: number;
    accuracyRetentionVsSmartPct: number;
    routerRegretCount: number;
    speedupVsSmart: number;
    speedupVsLight: number;
    costSavingsVsSmartPct: number;
  };
  categoryBreakdown: Array<{
    category: TextTaskCategory;
    count: number;
    lightAccPct: number;
    smartAccPct: number;
    routerAccPct: number;
    lightAvgMs: number;
    smartAvgMs: number;
    routerAvgMs: number;
  }>;
  routerLog: {
    entries: RouterLogEntry[];
    tierCounts: Record<string, number>;
    sourceCounts: Record<string, number>;
    selfHandledCount: number;
    selfHandledAccuracyPct: number;
    selfHandledAvgMs: number;
    escalationCount: number;
    escalationRecoveredCount: number;
    switchEvents: SwitchEvent[];
    logFilePath?: string;
    reportFilePath?: string;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Number(sorted[idx].toFixed(2));
}

function resolveDefaultLiveModels(config: RouterConfig): {
  light: string;
  smart: string;
} {
  const hasKey = (p: string) => Boolean(config.providers[p]?.apiKey);
  const tierTrivial = config.tiers.trivial[0];
  const tierFrontier = config.tiers.frontier[0] ?? config.tiers.complex[0];

  const light =
    tierTrivial && hasKey(tierTrivial.provider)
      ? `${tierTrivial.provider}/${tierTrivial.model}`
      : hasKey("gemini")
        ? "gemini/gemini-2.5-flash-lite"
        : hasKey("openai")
          ? "openai/gpt-4.1-mini"
          : "anthropic/claude-haiku-4-5";

  const smart =
    tierFrontier && hasKey(tierFrontier.provider)
      ? `${tierFrontier.provider}/${tierFrontier.model}`
      : hasKey("anthropic")
        ? "anthropic/claude-sonnet-4-6"
        : hasKey("openai")
          ? "openai/gpt-4.1"
          : "gemini/gemini-2.5-pro";

  return { light, smart };
}

function selectStratifiedSample(
  tasks: TextEvalTask[],
  sampleCount: number,
): TextEvalTask[] {
  if (sampleCount >= tasks.length) return tasks;
  if (sampleCount === 6) {
    const preferredIds = [
      "dec-sentiment",
      "dec-support-route",
      "easy-leap-date",
      "med-js-reduce",
      "hard-seating-puzzle",
      "mt-bat-and-ball",
    ];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const picked = preferredIds
      .map((id) => byId.get(id))
      .filter((t): t is TextEvalTask => Boolean(t));
    if (picked.length === 6) return picked;
  }

  const categories: TextTaskCategory[] = [
    "decision-triage",
    "easy-text",
    "medium-reasoning",
    "hard-reasoning",
    "multi-turn-escalation",
  ];
  const buckets = categories.map((cat) =>
    tasks.filter((t) => t.category === cat),
  );
  const picked: TextEvalTask[] = [];
  let round = 0;
  while (picked.length < sampleCount) {
    let added = false;
    for (const b of buckets) {
      if (round < b.length && picked.length < sampleCount) {
        picked.push(b[round]);
        added = true;
      }
    }
    if (!added) break;
    round += 1;
  }
  return picked;
}

function getModelRpmLimit(
  config: RouterConfig,
  providerModelRef: string,
): number | undefined {
  const slash = providerModelRef.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = providerModelRef.slice(0, slash);
  const model = providerModelRef.slice(slash + 1);
  return config.providers[provider]?.models[model]?.rpm;
}

function extractResponseText(json: Record<string, unknown>): string {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const msg = (first.message ?? {}) as Record<string, unknown>;
  return typeof msg.content === "string" ? msg.content : "";
}

async function runArm(opts: {
  armName: "light-only" | "smart-only" | "decision-router";
  modelParam: string;
  tasks: TextEvalTask[];
  config: RouterConfig;
  liveMode: boolean;
  lastCallByModel: Map<string, number>;
  baselineArmLogs?: {
    lightByTask?: Map<string, boolean>;
    smartByTask?: Map<string, boolean>;
  };
}): Promise<{
  summary: ArmSummary;
  logs: RouterLogEntry[];
  switches: SwitchEvent[];
}> {
  const store = new DecisionStore(":memory:");
  const engine = new DecisionEngine(opts.config);
  const app = createApp({ config: opts.config, engine, store });

  const outcomes: ArmTaskOutcome[] = [];
  const logs: RouterLogEntry[] = [];
  const switches: SwitchEvent[] = [];
  const taskLatencies: number[] = [];

  try {
    for (const task of opts.tasks) {
      const sessionId = `eval-${opts.armName}-${task.id}`;
      const messages: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: task.prompt },
      ];

      let taskTotalMs = 0;
      let prevModel: string | null = null;
      let turn1Passed = false;
      let finalPassed = false;
      let finalModel = "";
      let finalAnswer = "";
      let turnsExecuted = 0;

      const maxTurns =
        task.category === "multi-turn-escalation" && task.correctionPrompt
          ? 2
          : 1;

      for (let turn = 1; turn <= maxTurns; turn++) {
        turnsExecuted = turn;

        // Per-model RPM pacing in live mode happens BEFORE starting the latency timer
        if (opts.liveMode) {
          let requiredWaitMs = 0;
          if (opts.modelParam.startsWith("direct/")) {
            const targetRef = opts.modelParam.slice("direct/".length);
            const rpm = getModelRpmLimit(opts.config, targetRef);
            if (rpm && rpm <= 10) {
              const minGapMs = Math.ceil(60_000 / rpm) + 500;
              const lastTs = opts.lastCallByModel.get(targetRef) ?? 0;
              requiredWaitMs = Math.max(0, minGapMs - (Date.now() - lastTs));
            }
          } else {
            // For routed arm, respect cooldown of any recently called low-RPM model
            for (const [modelRef, lastTs] of opts.lastCallByModel.entries()) {
              const rpm = getModelRpmLimit(opts.config, modelRef);
              if (rpm && rpm <= 10) {
                const minGapMs = Math.ceil(60_000 / rpm) + 500;
                const w = minGapMs - (Date.now() - lastTs);
                if (w > requiredWaitMs) requiredWaitMs = w;
              }
            }
          }
          if (requiredWaitMs > 0) {
            await new Promise((r) => setTimeout(r, requiredWaitMs));
          }
        }

        const retryBackoffs = [4000, 8000];
        let res!: Response;
        let totalMs = 0;

        for (let attempt = 0; attempt <= (opts.liveMode ? retryBackoffs.length : 0); attempt++) {
          const t0 = performance.now();
          res = await app.request("/v1/chat/completions", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-router-session": sessionId,
            },
            body: JSON.stringify({
              model: opts.modelParam,
              temperature: 0,
              messages,
            }),
          });
          totalMs = Number((performance.now() - t0).toFixed(2));

          const transient = res.status === 502 || res.status === 503 || res.status === 504;
          if (!opts.liveMode || res.ok || !transient || attempt === retryBackoffs.length) {
            break;
          }
          const waitMs = retryBackoffs[attempt];
          console.error(
            `[live] ${opts.armName} ${task.id} t${turn} -> HTTP ${res.status}, retrying in ${waitMs}ms...`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }

        taskTotalMs += totalMs;

        let answerText = "";
        let passed = false;
        let selectedModel = res.headers.get("x-router-model") ?? opts.modelParam;
        let tier = res.headers.get("x-router-tier") ?? "unknown";
        let source = res.headers.get("x-router-source") ?? "unknown";
        let reason = res.headers.get("x-router-reason") ?? "";
        const decisionMs = Number(res.headers.get("x-router-decision-ms") ?? 0);
        const selfHandled = res.headers.get("x-router-self-handled") === "true";
        const escalated = res.headers.get("x-router-escalated") === "true";
        const cacheSticky = res.headers.get("x-router-cache-sticky") === "true";

        if (!res.ok) {
          const errTxt = await res.text();
          if (!opts.liveMode || (res.status !== 429 && res.status < 500)) {
            throw new Error(
              `Arm ${opts.armName} task ${task.id} HTTP ${res.status}: ${errTxt}`,
            );
          }
          answerText = `[ERROR HTTP ${res.status}]`;
          passed = false;
          if (opts.modelParam.startsWith("direct/")) {
            selectedModel = opts.modelParam.slice("direct/".length);
          }
          tier = "error";
          source = "error";
          reason = `HTTP ${res.status}: ${errTxt.slice(0, 80)}`;
        } else {
          const json = (await res.json()) as Record<string, unknown>;
          answerText = extractResponseText(json);
          passed = gradeResponse(answerText, task.grade);
        }

        if (opts.liveMode && !selectedModel.startsWith("decision-model/") && selectedModel !== "error") {
          opts.lastCallByModel.set(selectedModel, Date.now());
        }
        const upstreamMs = Number(Math.max(0, totalMs - decisionMs).toFixed(2));

        if (opts.liveMode) {
          console.error(
            `[live] ${opts.armName} ${task.id} t${turn} -> ${selectedModel} (${tier}/${source}) ${res.ok ? (passed ? "pass" : "fail") : "err"} ${totalMs}ms`,
          );
        }

        if (prevModel && prevModel !== selectedModel) {
          switches.push({
            taskId: task.id,
            turn,
            fromModel: prevModel,
            toModel: selectedModel,
            reason,
            escalated,
          });
        }

        const lightPassed = opts.baselineArmLogs?.lightByTask?.get(task.id);
        const smartPassed = opts.baselineArmLogs?.smartByTask?.get(task.id);

        logs.push({
          timestamp: new Date().toISOString(),
          taskId: task.id,
          category: task.category,
          turn,
          tier,
          source,
          selfHandled,
          escalated,
          cacheSticky,
          switchedFrom: prevModel && prevModel !== selectedModel ? prevModel : null,
          selectedModel,
          decisionMs,
          upstreamMs,
          totalMs,
          reason,
          answerPreview: answerText.replace(/\s+/g, " ").slice(0, 80),
          passed,
          ...(turn === maxTurns && lightPassed !== undefined ? { lightPassed } : {}),
          ...(turn === maxTurns && smartPassed !== undefined ? { smartPassed } : {}),
          ...(turn === maxTurns && smartPassed !== undefined
            ? { routerRegret: Boolean(smartPassed && !passed) }
            : {}),
        });

        if (turn === 1) turn1Passed = passed;
        finalPassed = passed;
        finalModel = selectedModel;
        finalAnswer = answerText;
        prevModel = selectedModel;

        if (turn === 1 && maxTurns === 2) {
          if (passed) break;
          messages.push({ role: "assistant", content: answerText });
          messages.push({ role: "user", content: task.correctionPrompt! });
        }
      }

      taskLatencies.push(taskTotalMs);
      outcomes.push({
        taskId: task.id,
        category: task.category,
        turns: turnsExecuted,
        passed: finalPassed,
        turn1Passed,
        finalModel,
        totalMs: Number(taskTotalMs.toFixed(2)),
        answer: finalAnswer,
      });
    }

    const stats = store.getStats(24);
    const totalTasks = outcomes.length;
    const passedTasks = outcomes.filter((o) => o.passed).length;
    const totalLatencyMs = Number(
      taskLatencies.reduce((a, b) => a + b, 0).toFixed(2),
    );
    const sorted = [...taskLatencies].sort((a, b) => a - b);

    return {
      summary: {
        armName: opts.armName,
        modelLabel: opts.modelParam,
        totalTasks,
        passedTasks,
        accuracyPct:
          totalTasks > 0
            ? Number(((passedTasks / totalTasks) * 100).toFixed(1))
            : 0,
        totalLatencyMs,
        meanLatencyMs:
          totalTasks > 0 ? Number((totalLatencyMs / totalTasks).toFixed(2)) : 0,
        p50LatencyMs: percentile(sorted, 50),
        p95LatencyMs: percentile(sorted, 95),
        estimatedCostUsd: Number(stats.totalCostUsd.toFixed(6)),
        sqliteStats: stats,
        outcomes,
      },
      logs,
      switches,
    };
  } finally {
    store.close();
  }
}

export async function runTextEvalBenchmark(opts?: {
  mode?: TextEvalMode;
  fast?: boolean;
  lightModel?: string;
  smartModel?: string;
  configPath?: string;
  limit?: number;
  sample?: number;
  outDir?: string;
  saveArtifacts?: boolean;
}): Promise<TextEvalReport> {
  const mode: TextEvalMode = opts?.mode ?? "simulated";
  const saveArtifacts = opts?.saveArtifacts ?? true;
  let tasks = TEXT_EVAL_TASKS;
  if (opts?.sample && opts.sample > 0) {
    tasks = selectStratifiedSample(tasks, opts.sample);
  } else if (opts?.limit && opts.limit > 0) {
    tasks = tasks.slice(0, opts.limit);
  }

  let config: RouterConfig;
  let closeMocks: (() => Promise<void>) | null = null;
  let lightRef: string;
  let smartRef: string;

  if (mode === "simulated") {
    const mocks = await startTextEvalMockServers({ fast: opts?.fast });
    closeMocks = mocks.close;
    config = buildTextEvalSimConfig(mocks);
    lightRef = opts?.lightModel ?? "gemini/gemini-2.5-flash-lite";
    smartRef = opts?.smartModel ?? "anthropic/claude-sonnet-4-6";
  } else {
    const loaded = loadConfig(opts?.configPath);
    config = loaded.config;
    // Disable decision cache during eval so each task is evaluated freshly
    config.decisionModel.cacheTtlSec = 0;
    const defaults = resolveDefaultLiveModels(config);
    lightRef = opts?.lightModel ?? defaults.light;
    smartRef = opts?.smartModel ?? defaults.smart;
    if (config.decisionModel.apiKeys.length === 0) {
      throw new Error(
        "GEMINI_API_KEY is required for --mode live so the decision model can classify and self-answer.",
      );
    }
  }

  const lastCallByModel = new Map<string, number>();

  try {
    const lightArm = await runArm({
      armName: "light-only",
      modelParam: `direct/${lightRef}`,
      tasks,
      config,
      liveMode: mode === "live",
      lastCallByModel,
    });

    const smartArm = await runArm({
      armName: "smart-only",
      modelParam: `direct/${smartRef}`,
      tasks,
      config,
      liveMode: mode === "live",
      lastCallByModel,
    });

    const lightByTask = new Map(
      lightArm.summary.outcomes.map((o) => [o.taskId, o.passed]),
    );
    const smartByTask = new Map(
      smartArm.summary.outcomes.map((o) => [o.taskId, o.passed]),
    );

    const routerArm = await runArm({
      armName: "decision-router",
      modelParam: "auto",
      tasks,
      config,
      liveMode: mode === "live",
      lastCallByModel,
      baselineArmLogs: { lightByTask, smartByTask },
    });

    const lSum = lightArm.summary;
    const sSum = smartArm.summary;
    const rSum = routerArm.summary;

    const routerRegretCount = rSum.outcomes.filter(
      (o) => smartByTask.get(o.taskId) === true && !o.passed,
    ).length;

    const categories: TextTaskCategory[] = [
      "decision-triage",
      "easy-text",
      "medium-reasoning",
      "hard-reasoning",
      "multi-turn-escalation",
    ];

    const categoryBreakdown = categories
      .map((cat) => {
        const lCat = lSum.outcomes.filter((o) => o.category === cat);
        const sCat = sSum.outcomes.filter((o) => o.category === cat);
        const rCat = rSum.outcomes.filter((o) => o.category === cat);
        if (rCat.length === 0) return null;
        const pct = (arr: ArmTaskOutcome[]) =>
          Number(
            (
              (arr.filter((x) => x.passed).length / Math.max(1, arr.length)) *
              100
            ).toFixed(1),
          );
        const avg = (arr: ArmTaskOutcome[]) =>
          Number(
            (
              arr.reduce((sum, x) => sum + x.totalMs, 0) /
              Math.max(1, arr.length)
            ).toFixed(1),
          );
        return {
          category: cat,
          count: rCat.length,
          lightAccPct: pct(lCat),
          smartAccPct: pct(sCat),
          routerAccPct: pct(rCat),
          lightAvgMs: avg(lCat),
          smartAvgMs: avg(sCat),
          routerAvgMs: avg(rCat),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const tierCounts: Record<string, number> = {};
    const sourceCounts: Record<string, number> = {};
    for (const entry of routerArm.logs) {
      tierCounts[entry.tier] = (tierCounts[entry.tier] ?? 0) + 1;
      sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
    }

    const selfEntries = routerArm.logs.filter((e) => e.selfHandled);
    const selfPassed = selfEntries.filter((e) => e.passed).length;
    const selfAvgMs =
      selfEntries.length > 0
        ? Number(
            (
              selfEntries.reduce((a, e) => a + e.totalMs, 0) /
              selfEntries.length
            ).toFixed(2),
          )
        : 0;

    const escalatedEntries = routerArm.logs.filter((e) => e.escalated);
    const escalatedTaskIds = new Set(escalatedEntries.map((e) => e.taskId));
    const escalationRecoveredCount = rSum.outcomes.filter(
      (o) => escalatedTaskIds.has(o.taskId) && o.passed,
    ).length;

    const runId = `text-eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let logFilePath: string | undefined;
    let reportFilePath: string | undefined;

    const report: TextEvalReport = {
      runId,
      timestamp: new Date().toISOString(),
      mode,
      taskCount: tasks.length,
      arms: {
        lightOnly: lSum,
        smartOnly: sSum,
        decisionRouter: rSum,
      },
      comparisons: {
        accuracyDeltaVsLightPct: Number(
          (rSum.accuracyPct - lSum.accuracyPct).toFixed(1),
        ),
        accuracyRetentionVsSmartPct:
          sSum.accuracyPct > 0
            ? Number(((rSum.accuracyPct / sSum.accuracyPct) * 100).toFixed(1))
            : 100,
        routerRegretCount,
        speedupVsSmart:
          rSum.totalLatencyMs > 0
            ? Number((sSum.totalLatencyMs / rSum.totalLatencyMs).toFixed(2))
            : 1,
        speedupVsLight:
          rSum.totalLatencyMs > 0
            ? Number((lSum.totalLatencyMs / rSum.totalLatencyMs).toFixed(2))
            : 1,
        costSavingsVsSmartPct:
          sSum.estimatedCostUsd > 0
            ? Number(
                (
                  ((sSum.estimatedCostUsd - rSum.estimatedCostUsd) /
                    sSum.estimatedCostUsd) *
                  100
                ).toFixed(1),
              )
            : 0,
      },
      categoryBreakdown,
      routerLog: {
        entries: routerArm.logs,
        tierCounts,
        sourceCounts,
        selfHandledCount: selfEntries.length,
        selfHandledAccuracyPct:
          selfEntries.length > 0
            ? Number(((selfPassed / selfEntries.length) * 100).toFixed(1))
            : 0,
        selfHandledAvgMs: selfAvgMs,
        escalationCount: escalatedEntries.length,
        escalationRecoveredCount,
        switchEvents: routerArm.switches,
      },
    };

    if (saveArtifacts) {
      const outDir = path.resolve(opts?.outDir ?? "data/benchmarks");
      fs.mkdirSync(outDir, { recursive: true });
      logFilePath = path.join(outDir, `${runId}-router-log.jsonl`);
      reportFilePath = path.join(outDir, `${runId}-report.json`);
      report.routerLog.logFilePath = logFilePath;
      report.routerLog.reportFilePath = reportFilePath;

      const jsonl = routerArm.logs.map((l) => JSON.stringify(l)).join("\n") + "\n";
      fs.writeFileSync(logFilePath, jsonl, "utf8");
      fs.writeFileSync(reportFilePath, JSON.stringify(report, null, 2), "utf8");
    }

    return report;
  } finally {
    if (closeMocks) await closeMocks();
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function printTextEvalReport(r: TextEvalReport): void {
  const { lightOnly: l, smartOnly: s, decisionRouter: d } = r.arms;
  const c = r.comparisons;

  console.log(`\n=== General Text-Out LLM Benchmark (${r.mode} | tasks=${r.taskCount}) ===`);

  console.log(`\n[1] 3-Way Accuracy, Speed & Cost Comparison`);
  console.log(
    `  ${pad("Arm", 18)} ${pad("Accuracy", 15)} ${pad("Total ms", 11)} ${pad("Mean ms", 10)} ${pad("p50/p95 ms", 15)} Cost (USD)`,
  );
  for (const arm of [l, s, d]) {
    console.log(
      `  ${pad(arm.armName, 18)} ${pad(`${arm.passedTasks}/${arm.totalTasks} (${arm.accuracyPct}%)`, 15)} ${pad(String(arm.totalLatencyMs), 11)} ${pad(String(arm.meanLatencyMs), 10)} ${pad(`${arm.p50LatencyMs}/${arm.p95LatencyMs}`, 15)} $${arm.estimatedCostUsd.toFixed(6)}`,
    );
  }
  console.log(
    `  Deltas: Accuracy vs Light = ${c.accuracyDeltaVsLightPct >= 0 ? "+" : ""}${c.accuracyDeltaVsLightPct} pts | Retention vs Smart = ${c.accuracyRetentionVsSmartPct}% | Router Regret = ${c.routerRegretCount}`,
  );
  console.log(
    `  Speed & Cost: Speedup vs Smart = ${c.speedupVsSmart}x | vs Light = ${c.speedupVsLight}x | Cost Savings vs Smart = ${c.costSavingsVsSmartPct}%`,
  );

  console.log(`\n[2] Per-Category Breakdown`);
  console.log(
    `  ${pad("Category", 24)} ${pad("N", 4)} ${pad("Light Acc/ms", 16)} ${pad("Smart Acc/ms", 16)} Router Acc/ms`,
  );
  for (const row of r.categoryBreakdown) {
    console.log(
      `  ${pad(row.category, 24)} ${pad(String(row.count), 4)} ${pad(`${row.lightAccPct}% / ${row.lightAvgMs}ms`, 16)} ${pad(`${row.smartAccPct}% / ${row.smartAvgMs}ms`, 16)} ${row.routerAccPct}% / ${row.routerAvgMs}ms`,
    );
  }

  const rl = r.routerLog;
  console.log(`\n[3] Router Decision, Self-Answer, Switching & Escalation Log`);
  console.log(`  Tier distribution:   ${JSON.stringify(rl.tierCounts)}`);
  console.log(`  Source distribution: ${JSON.stringify(rl.sourceCounts)}`);
  console.log(
    `  Self-handled ("self"): ${rl.selfHandledCount} calls | Accuracy = ${rl.selfHandledAccuracyPct}% | Avg Latency = ${rl.selfHandledAvgMs}ms (0 upstream hops)`,
  );
  console.log(
    `  Escalations: ${rl.escalationCount} triggered | Recovered on Turn 2 = ${rl.escalationRecoveredCount}`,
  );

  if (rl.switchEvents.length > 0) {
    console.log(`  Model Switch Log (${rl.switchEvents.length}):`);
    for (const sw of rl.switchEvents) {
      console.log(
        `    - ${sw.taskId} (turn ${sw.turn}): ${sw.fromModel} -> ${sw.toModel} [esc=${sw.escalated}] (${sw.reason})`,
      );
    }
  }

  console.log(`\n  Sample Decision Trace (first 12 calls):`);
  console.log(
    `  ${pad("Task", 22)} ${pad("T", 2)} ${pad("Tier", 9)} ${pad("Source", 12)} ${pad("Model", 26)} ${pad("ms", 7)} Pass`,
  );
  for (const e of rl.entries.slice(0, 12)) {
    console.log(
      `  ${pad(e.taskId, 22)} ${pad(String(e.turn), 2)} ${pad(e.tier, 9)} ${pad(e.source, 12)} ${pad(e.selectedModel, 26)} ${pad(String(e.totalMs), 7)} ${e.passed ? "PASS" : "FAIL"}`,
    );
  }

  if (rl.logFilePath) {
    console.log(`\n  Saved JSONL router log: ${rl.logFilePath}`);
    console.log(`  Saved JSON report:      ${rl.reportFilePath}`);
  }
  console.log("");
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i += 1;
        } else {
          flags[a.slice(2)] = "true";
        }
      }
    }
  }
  return flags;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).endsWith(
    `${path.sep}bench${path.sep}text-eval${path.sep}run.ts`,
  );

if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  const mode = (flags.mode ?? "simulated") as TextEvalMode;
  const limit = flags.limit ? Number(flags.limit) : undefined;
  const sample = flags.sample ? Number(flags.sample) : undefined;

  runTextEvalBenchmark({
    mode,
    fast: flags.fast === "true",
    lightModel: flags.light,
    smartModel: flags.smart,
    configPath: flags.config,
    limit: Number.isFinite(limit) ? limit : undefined,
    sample: Number.isFinite(sample) ? sample : undefined,
    outDir: flags["out-dir"],
    saveArtifacts: flags["no-save"] !== "true",
  })
    .then((report) => {
      if (flags.json === "true") {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printTextEvalReport(report);
      }
    })
    .catch((err) => {
      console.error(
        "[TextEvalBench] Error:",
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    });
}
