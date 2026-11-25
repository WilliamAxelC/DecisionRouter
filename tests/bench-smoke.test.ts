import { describe, expect, it } from "vitest";
import { runBenchmark } from "../bench/run.js";

describe("Benchmark suite smoke test", () => {
  it("runs all simulated benchmark suites cleanly with 0 stress errors, 100% escalation recall, and honest cost/gap surfacing", async () => {
    const report = await runBenchmark({ mode: "simulated", suite: "all" });

    expect(report.mode).toBe("simulated");
    expect(report.singleTurn?.total).toBe(20);
    expect(report.contextTraps?.total).toBe(5);
    expect(report.agentLoops?.totalLoops).toBe(5);
    expect(report.agentLoops?.escalationRecallPct).toBe(100);

    const featureLoop = report.agentLoops?.results.find(
      (r) => r.id === "feature-loop-12step",
    );
    expect(featureLoop).toBeDefined();
    expect(featureLoop!.costs.decisionRouterUsd).toBeLessThan(
      featureLoop!.costs.alwaysFrontierUsd,
    );
    expect(featureLoop!.costs.decisionRouterUsd).toBeLessThan(
      featureLoop!.costs.alwaysComplexUsd,
    );

    const oscLoop = report.agentLoops?.results.find(
      (r) => r.id === "oscillating-cache-thrash-8step",
    );
    expect(oscLoop).toBeDefined();
    expect(oscLoop!.costs.decisionRouterUsd).toBeLessThan(
      oscLoop!.costs.naiveStatelessUsd,
    );
    expect(oscLoop!.costs.decisionRouterUsd).toBeLessThan(
      oscLoop!.costs.alwaysFrontierUsd,
    );

    expect(report.stress?.totalRequests).toBe(30);
    expect(report.stress?.userFacingErrors).toBe(0);
    expect(report.protocolAudit?.length).toBeGreaterThanOrEqual(4);
    expect(report.gapsSurfaced.length).toBeGreaterThanOrEqual(3);
  });
});
