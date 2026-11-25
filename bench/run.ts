#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type { RouterConfig } from "../src/config/schema.js";
import { parseOpenAIRequest } from "../src/protocols/openai.js";
import { DecisionEngine } from "../src/router/engine.js";
import { tierRank } from "../src/router/session-store.js";
import type { CandidateRef, RoutingTier } from "../src/types/ir.js";
import { compareStrategyCosts, type TrajectoryStepBillingInput } from "./cost-model.js";
import { buildBenchRouterConfig, startBenchMockServers } from "./mock-upstreams.js";
import { AGENT_LOOP_SCENARIOS } from "./scenarios/agent-loops.js";
import { CONTEXT_TRAP_SCENARIOS } from "./scenarios/context-traps.js";
import {
  buildSingleTurnPayload,
  SINGLE_TURN_SCENARIOS,
} from "./scenarios/single-turn.js";
import {
  runProtocolAuditSuite,
  runStressSuite,
} from "./scenarios/stress-and-protocol.js";
import type {
  AgentLoopResult,
  AgentLoopSummary,
  BenchmarkMode,
  BenchmarkReport,
  BenchmarkSuiteName,
  ContextTrapResult,
  ContextTrapSummary,
  SingleTurnResult,
  SingleTurnSummary,
} from "./types.js";

function effectiveTierRank(tier: RoutingTier): number {
  if (tier === "specialist") return 2;
  return tierRank(tier);
}

function tierCandidateForNaive(config: RouterConfig, tier: RoutingTier): CandidateRef {
  if (tier === "specialist") {
    return config.tiers.specialists.coding[0] ?? config.tiers.complex[0];
  }
  if (tier === "self") {
    return config.tiers.trivial[0] ?? config.tiers.standard[0];
  }
  return config.tiers[tier][0] ?? config.tiers.standard[0];
}

async function runSingleTurnSuite(
  engine: DecisionEngine,
  paceMs: number,
): Promise<SingleTurnSummary> {
  const results: SingleTurnResult[] = [];
  for (const scenario of SINGLE_TURN_SCENARIOS) {
    const req = parseOpenAIRequest(buildSingleTurnPayload(scenario), {
      "x-router-session": `bench-single-${scenario.id}`,
    });
    const plan = await engine.decide(req);
    const actualTier = plan.decision.tier;
    const exactMatch =
      actualTier === scenario.idealTier &&
      (!scenario.specialist || plan.decision.specialist === scenario.specialist);

    const actualRank = effectiveTierRank(actualTier);
    const minRank = effectiveTierRank(scenario.minRequiredTier);
    const idealRank = effectiveTierRank(scenario.idealTier);

    const underRouted =
      scenario.idealTier === "specialist" &&
      (scenario.specialist === "vision" || scenario.specialist === "long_context")
        ? plan.decision.specialist !== scenario.specialist
        : actualRank < minRank;

    const overRouted = !underRouted && actualRank > idealRank;

    results.push({
      id: scenario.id,
      category: scenario.category,
      idealTier: scenario.idealTier,
      minRequiredTier: scenario.minRequiredTier,
      actualTier,
      actualSpecialist: plan.decision.specialist,
      selectedModel: `${plan.decision.selectedProvider}/${plan.decision.selectedModel}`,
      source: plan.decision.source,
      decisionMs: plan.decision.decisionMs,
      exactMatch,
      overRouted,
      underRouted,
      specialistMatch:
        !scenario.specialist || plan.decision.specialist === scenario.specialist,
    });

    if (paceMs > 0) {
      await new Promise((r) => setTimeout(r, paceMs));
    }
  }

  const total = results.length;
  const exactMatches = results.filter((r) => r.exactMatch).length;
  const overRoutedCount = results.filter((r) => r.overRouted).length;
  const underRoutedCount = results.filter((r) => r.underRouted).length;
  const avgDecisionMs =
    results.reduce((acc, r) => acc + r.decisionMs, 0) / Math.max(1, total);

  return {
    total,
    exactMatches,
    exactMatchPct: Number(((exactMatches / total) * 100).toFixed(1)),
    overRoutedCount,
    underRoutedCount,
    underRoutedPct: Number(((underRoutedCount / total) * 100).toFixed(1)),
    avgDecisionMs: Number(avgDecisionMs.toFixed(2)),
    results,
  };
}

async function runContextTrapSuite(
  engine: DecisionEngine,
  paceMs: number,
): Promise<ContextTrapSummary> {
  const results: ContextTrapResult[] = [];

  for (const trap of CONTEXT_TRAP_SCENARIOS) {
    const sessionId = `bench-trap-${trap.id}`;

    // Execute Turn 1 through engine.execute() so session state is populated realistically
    const turn1Req = parseOpenAIRequest(
      {
        model: "auto",
        messages: [trap.turns[0]],
      },
      { "x-router-session": sessionId },
    );
    const turn1Exec = await engine.execute(turn1Req);
    if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));

    // Evaluate Turn 3 (short ambiguous follow-up with prior 2 turns in conversation)
    const turn3Req = parseOpenAIRequest(
      {
        model: "auto",
        messages: trap.turns,
      },
      { "x-router-session": sessionId },
    );
    const turn3Exec = await engine.execute(turn3Req);
    if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));

    const minRank = effectiveTierRank(trap.minRequiredTier);
    const actualRank = effectiveTierRank(turn3Exec.decision.tier);
    const survived = actualRank >= minRank;

    results.push({
      id: trap.id,
      name: trap.name,
      minRequiredTier: trap.minRequiredTier,
      turn1Tier: turn1Exec.decision.tier,
      turn3Tier: turn3Exec.decision.tier,
      turn3Model: `${turn3Exec.decision.selectedProvider}/${turn3Exec.decision.selectedModel}`,
      turn3Source: turn3Exec.decision.source,
      cacheSticky: turn3Exec.decision.cacheSticky,
      survived,
      reason: turn3Exec.decision.reason,
    });
  }

  const total = results.length;
  const survived = results.filter((r) => r.survived).length;
  return {
    total,
    survived,
    survivalPct: Number(((survived / total) * 100).toFixed(1)),
    results,
  };
}

async function runAgentLoopSuite(
  engine: DecisionEngine,
  config: RouterConfig,
  paceMs: number,
): Promise<AgentLoopSummary> {
  const loopResults: AgentLoopResult[] = [];
  const allBillingSteps: TrajectoryStepBillingInput[] = [];
  const allDrChoices: CandidateRef[] = [];
  const allNaiveChoices: CandidateRef[] = [];

  for (const loop of AGENT_LOOP_SCENARIOS) {
    const sessionId = `bench-loop-${loop.id}`;
    const drChoices: CandidateRef[] = [];
    const naiveChoices: CandidateRef[] = [];
    const billingSteps: TrajectoryStepBillingInput[] = [];

    let cacheStickyHits = 0;
    let cacheStickyEligible = 0;
    let expectedEscalations = 0;
    let caughtEscalations = 0;
    let firstEscalationIndex: number | null = null;
    let escalationStepIndex: number | null = null;
    let underRoutedSteps = 0;

    for (let i = 0; i < loop.steps.length; i++) {
      const step = loop.steps[i];
      const req = parseOpenAIRequest(
        {
          model: "auto",
          messages: step.messages,
          ...(step.tools ? { tools: step.tools } : {}),
        },
        { "x-router-session": sessionId },
      );

      const exec = await engine.execute(req);
      if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));

      const drChoice: CandidateRef = {
        provider: exec.decision.selectedProvider,
        model: exec.decision.selectedModel,
      };
      const naiveChoice = tierCandidateForNaive(config, step.minRequiredTier);

      drChoices.push(drChoice);
      naiveChoices.push(naiveChoice);

      const billingStep: TrajectoryStepBillingInput = {
        inputTokens: exec.decision.estimatedInputTokens,
        outputTokens: step.expectedOutputTokens,
      };
      billingSteps.push(billingStep);

      allBillingSteps.push(billingStep);
      allDrChoices.push(drChoice);
      allNaiveChoices.push(naiveChoice);

      if (step.expectCacheSticky) {
        cacheStickyEligible += 1;
        if (exec.decision.cacheSticky) cacheStickyHits += 1;
      }

      if (step.expectEscalated) {
        expectedEscalations += 1;
        if (firstEscalationIndex === null) firstEscalationIndex = i;
        if (exec.decision.escalated) {
          caughtEscalations += 1;
          if (escalationStepIndex === null) escalationStepIndex = i;
        }
      }

      if (
        effectiveTierRank(exec.decision.tier) <
        effectiveTierRank(step.minRequiredTier)
      ) {
        underRoutedSteps += 1;
      }
    }

    const costs = compareStrategyCosts(
      billingSteps,
      drChoices,
      naiveChoices,
      config,
    );

    loopResults.push({
      id: loop.id,
      name: loop.name,
      stepsCount: loop.steps.length,
      cacheStickyHits,
      cacheStickyEligible,
      expectedEscalations,
      caughtEscalations,
      stepsToEscalate:
        firstEscalationIndex !== null && escalationStepIndex !== null
          ? escalationStepIndex - firstEscalationIndex + 1
          : null,
      underRoutedSteps,
      costs,
    });
  }

  const totalStickyEligible = loopResults.reduce(
    (s, r) => s + r.cacheStickyEligible,
    0,
  );
  const totalStickyHits = loopResults.reduce((s, r) => s + r.cacheStickyHits, 0);
  const totalExpEsc = loopResults.reduce((s, r) => s + r.expectedEscalations, 0);
  const totalCaughtEsc = loopResults.reduce((s, r) => s + r.caughtEscalations, 0);
  const totalSteps = loopResults.reduce((s, r) => s + r.stepsCount, 0);

  return {
    totalLoops: loopResults.length,
    totalSteps,
    cacheStickyRatePct:
      totalStickyEligible > 0
        ? Number(((totalStickyHits / totalStickyEligible) * 100).toFixed(1))
        : 100,
    escalationRecallPct:
      totalExpEsc > 0
        ? Number(((totalCaughtEsc / totalExpEsc) * 100).toFixed(1))
        : 100,
    results: loopResults,
    aggregateCosts: compareStrategyCosts(
      allBillingSteps,
      allDrChoices,
      allNaiveChoices,
      config,
    ),
  };
}

function collectGaps(report: Omit<BenchmarkReport, "gapsSurfaced">): string[] {
  const gaps: string[] = [];

  if (report.singleTurn && report.singleTurn.underRoutedCount > 0) {
    const failed = report.singleTurn.results
      .filter((r) => r.underRouted)
      .map((r) => `${r.id} (${r.actualTier} < ${r.minRequiredTier})`)
      .join(", ");
    gaps.push(
      `Single-turn under-routing on ${report.singleTurn.underRoutedCount}/${report.singleTurn.total} scenarios: ${failed}`,
    );
  }

  if (report.contextTraps && report.contextTraps.survived < report.contextTraps.total) {
    const failed = report.contextTraps.results
      .filter((r) => !r.survived)
      .map((r) => `${r.id} (dropped ${r.turn1Tier} -> ${r.turn3Tier})`)
      .join(", ");
    gaps.push(
      `Short-follow-up context trap failures (${report.contextTraps.total - report.contextTraps.survived}/${report.contextTraps.total}): ${failed}`,
    );
  }

  if (report.agentLoops) {
    if (report.agentLoops.escalationRecallPct < 100) {
      gaps.push(
        `Agent escalation recall below 100% (${report.agentLoops.escalationRecallPct}%)`,
      );
    }
    const totalUnder = report.agentLoops.results.reduce(
      (s, r) => s + r.underRoutedSteps,
      0,
    );
    if (totalUnder > 0) {
      gaps.push(`Agent trajectories had ${totalUnder} under-routed step(s).`);
    }
    for (const r of report.agentLoops.results) {
      if (r.costs.decisionRouterUsd > r.costs.naiveStatelessUsd) {
        gaps.push(
          `Mid-loop over-stickiness on ${r.id}: stayed sticky ($${r.costs.decisionRouterUsd.toFixed(4)}) instead of one-time switch to cheaper tier ($${r.costs.naiveStatelessUsd.toFixed(4)}).`,
        );
      }
    }
  }

  if (report.stress && report.stress.userFacingErrors > 0) {
    gaps.push(
      `Stress suite produced ${report.stress.userFacingErrors} user-facing error(s).`,
    );
  }

  if (report.protocolAudit) {
    for (const item of report.protocolAudit) {
      if (item.status !== "PASS") {
        gaps.push(`[${item.status}] ${item.name}: ${item.detail}`);
      }
    }
  }

  return gaps;
}

export async function runBenchmark(opts?: {
  mode?: BenchmarkMode;
  suite?: BenchmarkSuiteName;
}): Promise<BenchmarkReport> {
  loadDotenv({ quiet: true } as Parameters<typeof loadDotenv>[0]);
  const mode: BenchmarkMode = opts?.mode ?? "simulated";
  const suite: BenchmarkSuiteName = opts?.suite ?? "all";

  const liveKey = process.env.GEMINI_API_KEY?.trim();
  if (mode === "live-classifier" && !liveKey) {
    throw new Error(
      "GEMINI_API_KEY is required in .env or environment for --mode live-classifier.",
    );
  }

  const paceMs = mode === "live-classifier" ? 4200 : 0;
  const mocks = await startBenchMockServers();

  try {
    const config = buildBenchRouterConfig(mocks, mode, liveKey);
    const engine = new DecisionEngine(config);

    const partial: Omit<BenchmarkReport, "gapsSurfaced"> = {
      timestamp: new Date().toISOString(),
      mode,
      suite,
    };

    if (suite === "all" || suite === "single") {
      partial.singleTurn = await runSingleTurnSuite(engine, paceMs);
    }
    if (suite === "all" || suite === "traps") {
      partial.contextTraps = await runContextTrapSuite(engine, paceMs);
    }
    if (suite === "all" || suite === "agent") {
      partial.agentLoops = await runAgentLoopSuite(engine, config, paceMs);
    }
    if (suite === "all" || suite === "stress") {
      partial.stress = await runStressSuite();
    }
    if (suite === "all" || suite === "protocol") {
      partial.protocolAudit = await runProtocolAuditSuite();
    }

    return {
      ...partial,
      gapsSurfaced: collectGaps(partial),
    };
  } finally {
    await mocks.close();
  }
}

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function printReport(report: BenchmarkReport): void {
  console.log(`\n=== DecisionRouter Benchmark (${report.mode} | suite=${report.suite}) ===`);

  if (report.singleTurn) {
    const st = report.singleTurn;
    console.log(
      `\n[1] Single-Turn Routing (${st.total} prompts) — Exact: ${st.exactMatches}/${st.total} (${st.exactMatchPct}%), Over-routed: ${st.overRoutedCount}, Under-routed: ${st.underRoutedCount} (${st.underRoutedPct}%), Avg Decision: ${st.avgDecisionMs}ms`,
    );
    console.log(
      `  ${pad("ID", 24)} ${pad("Ideal", 11)} ${pad("Actual", 14)} ${pad("Source", 11)} ${pad("Status", 12)} Model`,
    );
    for (const r of st.results) {
      const actualLabel = r.actualSpecialist
        ? `${r.actualTier}:${r.actualSpecialist}`
        : r.actualTier;
      const status = r.underRouted
        ? "UNDER-ROUTED"
        : r.overRouted
          ? "OVER-ROUTED"
          : r.exactMatch
            ? "EXACT"
            : "OK";
      console.log(
        `  ${pad(r.id, 24)} ${pad(r.idealTier, 11)} ${pad(actualLabel, 14)} ${pad(r.source, 11)} ${pad(status, 12)} ${r.selectedModel}`,
      );
    }
  }

  if (report.contextTraps) {
    const ct = report.contextTraps;
    console.log(
      `\n[2] Short-Follow-Up Context Traps — Survived: ${ct.survived}/${ct.total} (${ct.survivalPct}%)`,
    );
    console.log(
      `  ${pad("ID", 22)} ${pad("MinReq", 9)} ${pad("T1->T3", 19)} ${pad("Source", 13)} ${pad("Sticky", 7)} Result`,
    );
    for (const r of ct.results) {
      console.log(
        `  ${pad(r.id, 22)} ${pad(r.minRequiredTier, 9)} ${pad(`${r.turn1Tier}->${r.turn3Tier}`, 19)} ${pad(r.turn3Source, 13)} ${pad(String(r.cacheSticky), 7)} ${r.survived ? "PASS" : "FAIL (TRAP)"}`,
      );
    }
  }

  if (report.agentLoops) {
    const al = report.agentLoops;
    const agg = al.aggregateCosts;
    console.log(
      `\n[3] Multi-Step Agent Loops (${al.totalLoops} trajectories, ${al.totalSteps} steps) — Sticky Rate: ${al.cacheStickyRatePct}%, Escalation Recall: ${al.escalationRecallPct}%`,
    );
    console.log(
      `  Aggregate True Cache-Aware Cost: Opus=$${agg.alwaysFrontierUsd.toFixed(4)} | Sonnet=$${agg.alwaysComplexUsd.toFixed(4)} | Naive-Stateless=$${agg.naiveStatelessUsd.toFixed(4)} | DecisionRouter=$${agg.decisionRouterUsd.toFixed(4)}`,
    );
    console.log(
      `  Savings vs Opus: ${agg.savingsVsFrontierPct}% | vs Sonnet: ${agg.savingsVsComplexPct}% | vs Naive-Stateless: ${agg.savingsVsNaivePct}%`,
    );
    for (const r of al.results) {
      console.log(
        `  - ${r.id} (${r.stepsCount} steps): DR=$${r.costs.decisionRouterUsd.toFixed(4)} vs Naive=$${r.costs.naiveStatelessUsd.toFixed(4)} vs Sonnet=$${r.costs.alwaysComplexUsd.toFixed(4)} | sticky=${r.cacheStickyHits}/${r.cacheStickyEligible} | esc=${r.caughtEscalations}/${r.expectedEscalations}`,
      );
    }
  }

  if (report.stress) {
    const s = report.stress;
    console.log(
      `\n[4] Free-Tier Quota & Failover Stress (${s.totalRequests} requests)`,
    );
    console.log(
      `  User Errors: ${s.userFacingErrors} | Failovers: ${s.failoversTriggered} | Latency p50=${s.p50DecisionMs}ms p95=${s.p95DecisionMs}ms p99=${s.p99DecisionMs}ms`,
    );
    console.log(`  Sources: ${JSON.stringify(s.sourceDistribution)}`);
  }

  if (report.protocolAudit) {
    console.log(`\n[5] Real-World Protocol & MCP Audit`);
    for (const item of report.protocolAudit) {
      console.log(`  [${pad(item.status, 4)}] ${item.name} — ${item.detail}`);
    }
  }

  console.log(`\n[6] Real-World Gaps Surfaced (${report.gapsSurfaced.length})`);
  if (report.gapsSurfaced.length === 0) {
    console.log("  None.");
  } else {
    for (const g of report.gapsSurfaced) {
      console.log(`  - ${g}`);
    }
  }
  console.log("");
}

function parseCliArgs(argv: string[]) {
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
  path.resolve(process.argv[1]).endsWith(`${path.sep}bench${path.sep}run.ts`);

if (isMain) {
  const flags = parseCliArgs(process.argv.slice(2));
  const mode = (flags.mode ?? "simulated") as BenchmarkMode;
  const suite = (flags.suite ?? "all") as BenchmarkSuiteName;

  runBenchmark({ mode, suite })
    .then((report) => {
      if (flags.out) {
        fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
        fs.writeFileSync(flags.out, JSON.stringify(report, null, 2));
      }
      if (flags.json === "true") {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReport(report);
      }
    })
    .catch((err) => {
      console.error("[Bench] Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
