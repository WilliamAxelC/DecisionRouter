import { describe, expect, it } from "vitest";
import { runTextEvalBenchmark } from "../bench/text-eval/run.js";

describe("General text-out LLM benchmark suite", () => {
  it("evaluates Light-Only vs Smart-Only vs DecisionRouter with self-answering, speedups, escalations, and complete router logs", async () => {
    const report = await runTextEvalBenchmark({
      mode: "simulated",
      fast: true,
      saveArtifacts: false,
    });

    expect(report.taskCount).toBe(30);
    expect(report.arms.decisionRouter.accuracyPct).toBeGreaterThan(
      report.arms.lightOnly.accuracyPct,
    );
    expect(report.arms.decisionRouter.totalLatencyMs).toBeLessThan(
      report.arms.smartOnly.totalLatencyMs,
    );
    expect(report.comparisons.speedupVsSmart).toBeGreaterThan(1);

    // Self-answering ("self" tier) & SQLite telemetry
    expect(report.routerLog.selfHandledCount).toBeGreaterThan(0);
    expect(report.routerLog.selfHandledAccuracyPct).toBeGreaterThanOrEqual(80);
    expect(report.arms.decisionRouter.sqliteStats.selfHandledCount).toBe(
      report.routerLog.selfHandledCount,
    );

    // Escalation & model switch tracking on multi-turn deception traps
    expect(report.routerLog.escalationCount).toBeGreaterThan(0);
    expect(report.routerLog.escalationRecoveredCount).toBeGreaterThan(0);
    expect(report.routerLog.switchEvents.length).toBeGreaterThan(0);
    expect(report.routerLog.entries.length).toBeGreaterThanOrEqual(30);
  });
});
