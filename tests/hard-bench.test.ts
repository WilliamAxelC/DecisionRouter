import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RouterConfigSchema } from "../src/config/schema.js";
import {
  gradeAime25,
  gradeBfclV4,
  gradeBigCodeBenchHard,
  gradeIFEval,
  gradeLiveBenchData,
  gradeLiveBenchExact,
  gradeSimpleQA,
} from "../bench/hard/graders.js";
import {
  buildHardBenchmarkReportData,
  renderHardBenchmarkReport,
} from "../bench/hard/report.js";
import {
  computeBackoffTransition,
  ResilientGeminiPool,
} from "../bench/hard/resilient-client.js";
import type { HardBenchTask, LiveModelResponse } from "../bench/hard/types.js";

describe("Hard benchmark programmatic graders", () => {
  it("executes real Python unittest suite via BigCodeBench-Hard grader", () => {
    const graderSpec = {
      kind: "bigcodebench" as const,
      entryPoint: "task_func",
      codePrompt: "import numpy as np\ndef task_func(xs):",
      testCode: `
import unittest
class TestCases(unittest.TestCase):
    def test_basic(self):
        self.assertAlmostEqual(task_func([1, 2, 3, 4]), 2.5)
`,
      libs: ["numpy"],
    };

    const good = gradeBigCodeBenchHard(
      "Here is the solution:\n```python\nimport numpy as np\ndef task_func(xs):\n    return float(np.mean(xs))\n```",
      graderSpec,
    );
    expect(good.passed).toBe(true);

    const wrong = gradeBigCodeBenchHard(
      "```python\ndef task_func(xs):\n    return sum(xs)\n```",
      graderSpec,
    );
    expect(wrong.passed).toBe(false);
    expect(wrong.detail).toContain("python test failed");
  });

  it("grades AIME 2025 boxed integers, LiveBench data/exact, IFEval, and BFCL v4 calls", async () => {
    expect(gradeAime25("Workings... \\boxed{070}", "70").passed).toBe(true);
    expect(gradeAime25("Therefore \\boxed{71}", "70").passed).toBe(false);

    expect(
      gradeLiveBenchExact("Final order:\n**1, a, b, c**", "1, a, b, c").passed,
    ).toBe(true);

    expect(
      gradeLiveBenchData(
        '```json\n{"row1":{"val":1.50001,"name":"alpha"}}\n```',
        '{"row1":{"name":"alpha","val":1.5}}',
        "tablereformat",
      ).passed,
    ).toBe(true);

    expect(
      gradeIFEval(
        "<<Ocean Breeze>>\nThe quick fox jumps gracefully over calm waves.\nP.S. Bring sunscreen.",
        [
          "punctuation:no_comma",
          "detectable_format:title",
          "keywords:existence",
          "detectable_content:postscript",
        ],
        [
          {},
          {},
          { keywords: ["ocean", "waves"] },
          { postscript_marker: "P.S." },
        ],
      ).passed,
    ).toBe(true);

    expect(
      gradeIFEval(
        "Hello, world!",
        ["punctuation:no_comma"],
        [{}],
      ).passed,
    ).toBe(false);

    expect(
      gradeBfclV4(
        [
          {
            name: "ChaDri__change_drink",
            arguments: { drink_id: "Latte", size: "large" },
          },
        ],
        [
          {
            "ChaDri.change_drink": {
              drink_id: ["latte"],
              size: ["large", "L"],
            },
          },
        ],
      ).passed,
    ).toBe(true);

    expect((await gradeSimpleQA("120,000 euros", "120000 euros")).passed).toBe(true);
  });
});

describe("ResilientGeminiPool backoff & state persistence", () => {
  it("computes safe backoff transitions for 401/403 quarantine, 429 daily vs RPM, and 503 exponential backoff", () => {
    const now = 1_700_000_000_000;

    const auth = computeBackoffTransition({
      status: 403,
      errorBody: "PERMISSION_DENIED",
      prevConsecutiveErrors: 0,
      nowMs: now,
      jitterMs: 0,
    });
    expect(auth.quarantine).toBe(true);

    const daily429 = computeBackoffTransition({
      status: 429,
      errorBody: "GenerateRequestsPerDayPerProjectPerModel exceeded",
      prevConsecutiveErrors: 1,
      nowMs: now,
      jitterMs: 0,
    });
    expect(daily429.isDailyQuota).toBe(true);
    expect(daily429.delayMs).toBe(30 * 60_000);

    const rpm429 = computeBackoffTransition({
      status: 429,
      errorBody: '{"error":{"details":[{"retryDelay":"72s"}]}}',
      prevConsecutiveErrors: 0,
      nowMs: now,
      jitterMs: 0,
    });
    expect(rpm429.isDailyQuota).toBe(false);
    expect(rpm429.delayMs).toBe(72_000);

    const s503_1 = computeBackoffTransition({
      status: 503,
      errorBody: "UNAVAILABLE high demand",
      prevConsecutiveErrors: 0,
      nowMs: now,
      jitterMs: 0,
    });
    const s503_3 = computeBackoffTransition({
      status: 503,
      errorBody: "UNAVAILABLE high demand",
      prevConsecutiveErrors: 2,
      nowMs: now,
      jitterMs: 0,
    });
    expect(s503_1.delayMs).toBe(30_000);
    expect(s503_3.delayMs).toBe(120_000);
  });

  it("quarantines bad keys in SQLite and gates shared 503 outage across keys", () => {
    const db = new DatabaseSync(":memory:");
    const cfg = RouterConfigSchema.parse({
      decisionModel: { apiKeys: ["k1", "k2"], models: [{ id: "gemini-decision-1", api: "decisions" }] },
      providers: {
        gemini: {
          type: "gemini",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKeys: ["k1", "k2"],
          models: {
            "gemini-4-hydrogen": { contextWindow: 1000000, supportsTools: true },
          },
        },
      },
    });

    const pool = new ResilientGeminiPool(db, cfg);
    pool.markFailure(0, "gemini-4-hydrogen", 401, "API_KEY_INVALID");
    expect(pool.getSlot(0, "gemini-4-hydrogen").status).toBe("quarantined");

    // Key 1 (remaining active key) hits 503 -> model enters global cooldown
    pool.markFailure(1, "gemini-4-hydrogen", 503, "high demand", 10_000);
    const next = pool.getNextReadyAtMs("gemini-4-hydrogen", 15_000);
    expect(next.keyIdx).toBe(1);
    expect(next.readyAtMs).toBeGreaterThan(35_000);

    // HTTP 200 clears consecutive error counter
    pool.markSuccess(1, "gemini-4-hydrogen", 1200);
    expect(pool.getSlot(1, "gemini-4-hydrogen").consecutiveErrors).toBe(0);
    db.close();
  });

  it("computes Oracle ceiling, Router Regret, Bonus, and partial completion in report", () => {
    const cfg = RouterConfigSchema.parse({});
    const tasks: HardBenchTask[] = [
      {
        id: "t1",
        family: "aime25",
        sourceDataset: "math-ai/aime25",
        sourceId: "1",
        messages: [{ role: "user", content: "hard problem" }],
        grader: { kind: "aime25", expectedAnswer: "42" },
      },
      {
        id: "t2",
        family: "simpleqa-verified",
        sourceDataset: "google/simpleqa-verified",
        sourceId: "2",
        messages: [{ role: "user", content: "fact" }],
        grader: { kind: "simpleqa", expectedAnswer: "Paris", topic: "Geo", answerType: "String" },
      },
    ];

    const decisions = new Map([
      [
        "t1",
        {
          taskId: "t1",
          latencyMs: 250,
          updatedAtMs: 1,
          rawDecision: {
            tier: "complex" as const,
            confidence: 0.9,
            reason: "risk=0.80",
            classifierModel: "gemini-decision-1",
            riskScore: 0.8,
            signals: { errorRisk: 0.9, needsReasoning: 0.9, difficultyScore: 3, riskScore: 0.8 },
          },
        },
      ],
      [
        "t2",
        {
          taskId: "t2",
          latencyMs: 200,
          updatedAtMs: 1,
          rawDecision: {
            tier: "trivial" as const,
            confidence: 0.9,
            reason: "risk=0.10",
            classifierModel: "gemini-decision-1",
            riskScore: 0.1,
            signals: { errorRisk: 0.1, needsReasoning: 0.1, difficultyScore: 0, riskScore: 0.1 },
          },
        },
      ],
    ]);

    const mkRes = (
      taskId: string,
      role: "light" | "high",
      passed: boolean,
      latencyMs: number,
    ): LiveModelResponse => ({
      taskId,
      modelRole: role,
      modelName: role === "light" ? "gemini-3.8-flash" : "gemini-4-hydrogen",
      text: passed ? "42" : "wrong",
      finishReason: "STOP",
      httpStatus: 200,
      latencyMs,
      promptTokens: 100,
      outputTokens: 50,
      thinkingTokens: role === "high" ? 400 : 50,
      passed,
      gradeDetail: "test",
      updatedAtMs: 1,
    });

    const data = buildHardBenchmarkReportData({
      config: cfg,
      tasks,
      decisions,
      lightResponses: new Map([
        ["t1", mkRes("t1", "light", false, 1000)],
        ["t2", mkRes("t2", "light", true, 900)],
      ]),
      highResponses: new Map([
        ["t1", mkRes("t1", "high", true, 12000)],
        ["t2", mkRes("t2", "high", false, 11000)],
      ]),
      selfGrades: new Map(),
      cascadeChecks: new Map(),
      apiTelemetry: [],
      lightModel: "gemini-3.8-flash",
      highModel: "gemini-4-hydrogen",
      decisionModel: "gemini-decision-1",
    });

    const oracle = data.arms.find((a) => a.label.includes("Oracle"))!;
    const quality = data.arms.find((a) => a.label.includes("auto:quality"))!;
    expect(oracle.passed).toBe(2);
    expect(quality.passed).toBe(2);
    expect(quality.regretCount).toBe(0);
    expect(quality.bonusCount).toBe(1);
    const md = renderHardBenchmarkReport(data);
    expect(md).toContain("Oracle Router (Ceiling)");
  });
});
