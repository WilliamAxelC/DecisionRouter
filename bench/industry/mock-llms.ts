import http from "node:http";
import { RouterConfigSchema, type RouterConfig } from "../../src/config/schema.js";
import { INDUSTRY_TASKS } from "./datasets.js";
import { HELDOUT_TASKS } from "./heldout.js";
import type { GradeSpec } from "../text-eval/grader.js";

const ALL_MOCK_TASKS = [...INDUSTRY_TASKS, ...HELDOUT_TASKS];

export interface IndustryMockServers {
  classifierUrl: string;
  geminiUrl: string;
  anthropicUrl: string;
  close: () => Promise<void>;
}

function formatExpectedAnswer(grade: GradeSpec): string {
  switch (grade.kind) {
    case "enum":
    case "exact":
      return `FINAL: ${grade.expected}`;
    case "number":
      return `FINAL: ${grade.expected}`;
    case "json":
      return JSON.stringify(grade.expected);
  }
}

// Deterministic calibrated wrong answers for realistic difficulty curves on the light model
const LIGHT_WRONG_OVERRIDES: Record<string, string> = {
  // medium MMLU / GSM8K / BBH / ARC / CRUXEVAL (~30% miss rate on medium)
  "mmlu-econ-elasticity": "FINAL: A",
  "mmlu-law-consideration": "FINAL: D",
  "gsm-discount-tax": "FINAL: 194.00",
  "gsm-avg-speed": "FINAL: 50",
  "bbh-boolean-nested": "FINAL: FALSE",
  "bbh-navigate": "FINAL: 7",
  "arc-ice-volume": "FINAL: A",
  "tqa-glass-liquid": "FINAL: A",
  "crux-regex-count": "FINAL: 4",
  "crux-js-closure": "FINAL: 3",
  "sglue-ifeval-json": '{"eligible":false,"reason_code":"OUT_OF_WINDOW"}',

  // hard tasks (light model misses ~80% of hard tasks)
  "mmlu-stats-independence": "FINAL: A",
  "mmlu-dist-quorum": "FINAL: A",
  "math-combo-committee": "FINAL: 35",
  "math-crt-remainder": "FINAL: 38",
  "math-bayes-servers": "FINAL: 90",
  "math-triangle-area": "FINAL: 65",
  "bbh-shuffled-objects": "FINAL: green",
  "bbh-seating-puzzle": "FINAL: Dan",
  "bbh-three-boxes": "FINAL: APPLES",
  "arc-antibiotic-resistance": "FINAL: A",
  "arc-series-circuit": "FINAL: B",
  "arc-centripetal": "FINAL: B",
  "tqa-penny-empire-state": "FINAL: A",
  "crux-py-mutable-arg": "FINAL: 7",
  "crux-binary-search-bug": "FINAL: 3",
  "crux-js-microtasks": "FINAL: 1,4,2,3",
  "crux-sql-left-join": "FINAL: 1",
  "crux-recursion-count": "FINAL: 5",

  // CRT Turn 1 intuition traps (light model falls for intuition on 4/4 + heldout CRT)
  "crt-bat-and-ball": "FINAL: 0.10",
  "crt-lily-pad": "FINAL: 24",
  "crt-percent-symmetry": "FINAL: 5",
  "crt-widgets-machines": "FINAL: 100",

  // Heldout 21-task calibrated light misses
  "ho-mmlu-hard": "FINAL: A",
  "ho-gsm-med": "FINAL: 76",
  "ho-gsm-hard": "FINAL: 630",
  "ho-bbh-hard": "FINAL: Casey",
  "ho-arc-hard": "FINAL: B",
  "ho-tqa-crt": "FINAL: 10",
  "ho-crux-med": "FINAL: 50",
  "ho-crux-hard": "FINAL: 7",
  "ho-sglue-hard": '{"grant":true,"reason":"ELIGIBLE"}',
};

function extractPlainTextFromBody(body: Record<string, unknown>): string {
  const chunks: string[] = [];
  if (typeof body.input === "string") chunks.push(body.input);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages as Array<{ content?: unknown }>) {
      if (typeof m.content === "string") chunks.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const b of m.content as Array<{ text?: unknown }>) {
          if (typeof b.text === "string") chunks.push(b.text);
        }
      }
    }
  }
  if (Array.isArray(body.contents)) {
    for (const c of body.contents as Array<{ parts?: unknown }>) {
      if (Array.isArray(c.parts)) {
        for (const p of c.parts as Array<{ text?: unknown }>) {
          if (typeof p.text === "string") chunks.push(p.text);
        }
      }
    }
  }
  return chunks.join("\n");
}

function findTaskForText(text: string) {
  // Prefer full prompt match first to avoid prefix collisions on shared templates
  for (const t of ALL_MOCK_TASKS) {
    if (text.includes(t.prompt)) return t;
  }
  for (const t of ALL_MOCK_TASKS) {
    const key = t.prompt.slice(0, 64);
    if (text.includes(key)) return t;
  }
  // Check correctionPrompts for Turn 2 CRT
  for (const t of ALL_MOCK_TASKS) {
    if (t.correctionPrompt && text.includes(t.correctionPrompt.slice(0, 40))) {
      return t;
    }
  }
  return null;
}

function getAnswerForModel(isSmart: boolean, bodyText: string): string {
  const task = findTaskForText(bodyText);
  if (!task) return "FINAL: UNKNOWN";
  if (isSmart) {
    // Smart model gets 83/84 (~98.8% realistic accuracy — slight imperfection on 1 tricky item)
    if (task.id === "crux-recursion-count") return "FINAL: 9";
    return formatExpectedAnswer(task.grade);
  }
  if (LIGHT_WRONG_OVERRIDES[task.id]) {
    return LIGHT_WRONG_OVERRIDES[task.id];
  }
  return formatExpectedAnswer(task.grade);
}

function simulateDecisionsApi(
  inputText: string,
  questions: Record<string, { criteria?: Record<string, string> }>,
): Record<string, unknown> {
  const task = findTaskForText(inputText);
  const hasSelfAnswer = Boolean(questions.self_answer);

  if (!task) {
    return {
      answers: {
        route: { choice: "standard", confidence: 0.75, type: "choice" },
      },
    };
  }

  // Self-eligible discrete choice tasks: decision model handles inline!
  if (
    hasSelfAnswer &&
    task.selfEligible &&
    (task.grade.kind === "enum" || task.grade.kind === "exact")
  ) {
    const opts = Object.keys(questions.self_answer?.criteria ?? {});
    const expected = String(task.grade.expected);
    // Simulate 1 realistic slip out of self-eligible tasks (~95% self-accuracy)
    const chosenAns =
      task.id === "sglue-boolq-sla" && opts.includes("YES")
        ? "YES"
        : opts.includes(expected)
          ? expected
          : opts[0] ?? expected;

    return {
      answers: {
        error_risk: { noul: 0.12, confidence: 0.88, type: "noul" },
        needs_reasoning: { noul: 0.08, confidence: 0.92, type: "noul" },
        difficulty: { score: 0.4, confidence: 0.85, type: "score" },
        self_answer: { choice: chosenAns, confidence: 0.94, type: "choice" },
      },
    };
  }

  if (task.difficulty === "hard" && !task.id.startsWith("crt-") && task.id !== "ho-tqa-crt") {
    return {
      answers: {
        error_risk: { noul: 0.86, confidence: 0.86, type: "noul" },
        needs_reasoning: { noul: 0.91, confidence: 0.91, type: "noul" },
        difficulty: { score: 3.1, confidence: 0.72, type: "score" },
      },
    };
  }
  if (task.difficulty === "medium") {
    return {
      answers: {
        error_risk: { noul: 0.42, confidence: 0.58, type: "noul" },
        needs_reasoning: { noul: 0.48, confidence: 0.52, type: "noul" },
        difficulty: { score: 1.9, confidence: 0.65, type: "score" },
      },
    };
  }
  return {
    answers: {
      error_risk: { noul: 0.14, confidence: 0.86, type: "noul" },
      needs_reasoning: { noul: 0.12, confidence: 0.88, type: "noul" },
      difficulty: { score: 0.7, confidence: 0.8, type: "score" },
    },
  };
}

async function startHttpServer(
  handler: (
    req: http.IncomingMessage,
    body: Record<string, unknown>,
    res: http.ServerResponse,
  ) => void,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      handler(req, parsed, res);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

export async function startIndustryMockServers(opts?: {
  fast?: boolean;
  injectFaults?: boolean;
}): Promise<IndustryMockServers> {
  const fast = Boolean(opts?.fast);
  const injectFaults = Boolean(opts?.injectFaults);

  const decisionDelay = fast ? 3 : 65;
  const lightDelay = fast ? 6 : 150;
  const smartDelay = fast ? 32 : 760;

  let lightCalls = 0;
  let smartCalls = 0;

  const classifier = await startHttpServer((_req, body, res) => {
    const input = String(body.input ?? "");
    const questions = (body.questions ?? {}) as Record<
      string,
      { criteria?: Record<string, string> }
    >;
    const resp = simulateDecisionsApi(input, questions);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(resp));
    }, decisionDelay);
  });

  const gemini = await startHttpServer((_req, body, res) => {
    lightCalls += 1;
    if (injectFaults && lightCalls % 7 === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { code: 429, message: "simulated 429" } }));
      return;
    }

    const ans = getAnswerForModel(false, extractPlainTextFromBody(body));
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          responseId: `gem_${lightCalls}`,
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: ans }] },
            },
          ],
          usageMetadata: { promptTokenCount: 95, candidatesTokenCount: 18 },
        }),
      );
    }, lightDelay);
  });

  const anthropic = await startHttpServer((_req, body, res) => {
    smartCalls += 1;
    if (injectFaults && smartCalls % 8 === 1) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "overloaded", message: "simulated 503" } }));
      return;
    }

    const ans = getAnswerForModel(true, extractPlainTextFromBody(body));
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_${smartCalls}`,
          type: "message",
          role: "assistant",
          model: body.model ?? "gemini-4-hydrogen",
          content: [{ type: "text", text: ans }],
          stop_reason: "end_turn",
          usage: { input_tokens: 95, output_tokens: 55 },
        }),
      );
    }, smartDelay);
  });

  return {
    classifierUrl: classifier.url,
    geminiUrl: gemini.url,
    anthropicUrl: anthropic.url,
    close: async () => {
      await Promise.all(
        [classifier.server, gemini.server, anthropic.server].map(
          (s) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      );
    },
  };
}

export function buildIndustrySimConfig(
  mocks: IndustryMockServers,
  liveClassifierConfig?: RouterConfig["decisionModel"],
  profilesOverride?: RouterConfig["profiles"],
): RouterConfig {
  return RouterConfigSchema.parse({
    server: { dashboardEnabled: false },
    decisionModel: liveClassifierConfig ?? {
      provider: "gemini",
      baseUrl: mocks.classifierUrl,
      timeoutMs: 1500,
      cacheTtlSec: 0,
      allowSelfAnswer: true,
      selfAnswerMaxInputTokens: 1500,
      apiKeys: ["sim-decision-key"],
      models: [
        {
          id: "gemini-decision-1",
          api: "decisions",
          rpm: 600,
          tpm: 200000,
          rpd: 10000,
        },
      ],
    },
    providers: {
      gemini: {
        type: "gemini",
        baseUrl: mocks.geminiUrl,
        apiKey: "sim-gem",
        models: {
          "gemini-3.8-flash": {
            contextWindow: 1048576,
            supportsVision: true,
            supportsTools: true,
            rpm: 600,
            tpm: 250000,
            rpd: 10000,
            inputPer1M: 0.3,
            cachedInputPer1M: 0.075,
            outputPer1M: 2.5,
          },
        },
      },
      smart: {
        type: "anthropic",
        baseUrl: mocks.anthropicUrl,
        apiKey: "sim-smart",
        models: {
          "gemini-4-hydrogen": {
            contextWindow: 1048576,
            supportsVision: true,
            supportsTools: true,
            rpm: 600,
            tpm: 250000,
            rpd: 10000,
            inputPer1M: 3.0,
            cachedInputPer1M: 0.75,
            outputPer1M: 15.0,
          },
        },
      },
    },
    tiers: {
      trivial: [{ provider: "gemini", model: "gemini-3.8-flash" }],
      standard: [{ provider: "gemini", model: "gemini-3.8-flash" }],
      complex: [{ provider: "smart", model: "gemini-4-hydrogen" }],
      frontier: [{ provider: "smart", model: "gemini-4-hydrogen" }],
    },
    profiles: profilesOverride ?? {
      auto: {
        defaultTier: "standard",
        minTier: "trivial",
        maxTier: "frontier",
        cacheStickyEnabled: true,
        cacheTtlSec: 300,
        escalationEnabled: true,
        allowSelfAnswer: true,
        baselineModel: "smart/gemini-4-hydrogen",
      },
    },
  });
}
