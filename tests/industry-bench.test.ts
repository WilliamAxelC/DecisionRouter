import { describe, expect, it } from "vitest";
import {
  INDUSTRY_BENCHMARK_NAMES,
  INDUSTRY_TASKS,
} from "../bench/industry/datasets.js";
import { PersistentRateLimitQueue } from "../bench/industry/queue.js";
import { renderIndustryReportMarkdown } from "../bench/industry/report.js";
import { runIndustryBenchmark } from "../bench/industry/run.js";

describe("Industry benchmark suite & persistent SQLite queue", () => {
  it("contains 84 unique tasks across all 7 industry benchmark families", () => {
    expect(INDUSTRY_TASKS).toHaveLength(84);
    const ids = new Set(INDUSTRY_TASKS.map((t) => t.id));
    expect(ids.size).toBe(84);

    for (const bench of INDUSTRY_BENCHMARK_NAMES) {
      const subset = INDUSTRY_TASKS.filter((t) => t.benchmark === bench);
      expect(subset).toHaveLength(12);
    }
  });

  it("handles rate limits (429/503) with non-head-of-line blocking and exponential backoff in PersistentRateLimitQueue", async () => {
    const q = new PersistentRateLimitQueue(":memory:", {
      "slow-bucket": { rpm: 120, rpd: 100 },
      "fast-bucket": { rpm: 600, rpd: 100 },
    });

    q.enqueue([
      {
        id: "j1",
        arm: "test",
        taskId: "t1",
        modelBucket: "slow-bucket",
        payload: {},
        maxAttempts: 3,
      },
      {
        id: "j2",
        arm: "test",
        taskId: "t2",
        modelBucket: "fast-bucket",
        payload: {},
        maxAttempts: 3,
      },
    ]);

    const order: string[] = [];
    let slowAttempts = 0;

    const telemetry = await q.drain(
      async (job) => {
        order.push(job.id);
        if (job.id === "j1") {
          slowAttempts += 1;
          if (slowAttempts === 1) {
            return {
              ok: false,
              statusCode: 429,
              retryAfterMs: 40,
              errorMessage: "rate limited",
            };
          }
        }
        return { ok: true, result: { done: true } };
      },
      { arm: "test", baseBackoffMs: 25, maxWaitSec: 5 },
    );

    q.close();
    expect(telemetry.completedJobs).toBe(2);
    expect(telemetry.failedJobs).toBe(0);
    expect(telemetry.rateLimitedRetries).toBe(1);
    expect(telemetry.http429Count).toBe(1);
    // j1 hits 429 first -> j2 runs next without waiting on j1's backoff -> j1 retries and completes
    expect(order).toEqual(["j1", "j2", "j1"]);
  });

  it("runs all 84 tasks across 3 arms with fault injection, escalation, self-answering, and generates markdown report", async () => {
    const report = await runIndustryBenchmark({
      mode: "simulated",
      fast: true,
      injectFaults: true,
      saveArtifacts: false,
    });

    expect(report.taskCount).toBe(84);
    expect(report.arms.lightOnly.completedTasks).toBe(84);
    expect(report.arms.smartOnly.completedTasks).toBe(84);
    expect(report.arms.decisionRouter.completedTasks).toBe(84);

    expect(report.arms.decisionRouter.accuracyPct).toBeGreaterThan(
      report.arms.lightOnly.accuracyPct,
    );
    expect(report.arms.decisionRouter.totalLatencyMs).toBeLessThan(
      report.arms.smartOnly.totalLatencyMs,
    );
    expect(report.routerLog.selfHandledCount).toBeGreaterThan(0);
    expect(report.routerLog.escalationCount).toBeGreaterThan(0);
    expect(report.routerLog.escalationRecoveredCount).toBeGreaterThan(0);
    expect(report.routerLog.switchEvents.length).toBeGreaterThan(0);

    // Fault injection triggered queue retries yet completed 100% of jobs
    expect(
      report.arms.lightOnly.queueTelemetry.rateLimitedRetries +
        report.arms.smartOnly.queueTelemetry.rateLimitedRetries,
    ).toBeGreaterThan(0);

    const md = renderIndustryReportMarkdown({ primary: report });
    expect(md).toContain("# DecisionRouter — Industry Benchmark Report");
    expect(md).toContain("mmlu-pro");
    expect(md).toContain("superglue-nlu");
  }, 15000);
});
