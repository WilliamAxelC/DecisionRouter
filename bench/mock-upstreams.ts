import http from "node:http";
import { RouterConfigSchema, type RouterConfig } from "../src/config/schema.js";

export interface MockBenchServers {
  classifierUrl: string;
  openaiUrl: string;
  anthropicUrl: string;
  geminiUrl: string;
  close: () => Promise<void>;
}

/**
 * Simulates a realistic fast Gemini Flash-Lite classifier reading ONLY the compact
 * payload sent by GeminiDecisionClassifier (no access to hidden full history).
 */
function simulateFastClassifier(compactPayloadJson: string): {
  tier: "trivial" | "standard" | "complex" | "frontier" | "specialist";
  specialist?: "vision" | "long_context" | "coding" | "reasoning";
  confidence: number;
  reason: string;
} {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(compactPayloadJson) as Record<string, unknown>;
  } catch {
    return { tier: "standard", confidence: 0.5, reason: "parse fallback" };
  }

  const recentTurn = String(payload.recentTurn ?? "");
  const hasImages = Boolean(payload.hasImages);
  const estTotal = Number(payload.estimatedTotalTokens ?? 0);

  if (hasImages) {
    return { tier: "specialist", specialist: "vision", confidence: 0.96, reason: "image input" };
  }
  if (estTotal >= 80_000) {
    return {
      tier: "specialist",
      specialist: "long_context",
      confidence: 0.94,
      reason: "long context input",
    };
  }

  if (/\b(prove|invariant|optimal substructure|dp recurrence|linearizability)\b/i.test(recentTurn)) {
    if (/\b(raft|lease-read|oauth2|pkce|dpop|multi-region|active-active|ledger|threat model)\b/i.test(recentTurn)) {
      return { tier: "frontier", confidence: 0.92, reason: "critical distributed/security design" };
    }
    return {
      tier: "specialist",
      specialist: "reasoning",
      confidence: 0.9,
      reason: "formal/algorithmic proof",
    };
  }

  if (/\b(raft|pkce|dpop|multi-region|active-active|threat model|confused-deputy)\b/i.test(recentTurn)) {
    return { tier: "frontier", confidence: 0.91, reason: "high-stakes architecture/security" };
  }

  if (
    /\b(stale closure|abortcontroller|fencing-token|deadlock|40p01|zero-downtime|memory leak|heap-snapshot|race condition|idempotent|advisory lock|refresh token rotation|refactor.*middleware)\b/i.test(
      recentTurn,
    )
  ) {
    return { tier: "complex", confidence: 0.88, reason: "multi-factor bug or architecture" };
  }

  if (
    /\b(type guard|vitest|unit tests|row_number|postgresql query|rate-limit middleware|keyerror|indexerror|pagination)\b/i.test(
      recentTurn,
    )
  ) {
    return { tier: "standard", confidence: 0.87, reason: "standard coding task" };
  }

  // Short isolated follow-ups with no context keywords naturally look trivial/standard to a stateless classifier
  if (recentTurn.length < 130 && !/\b(error|bug|fix|security|race|migration)\b/i.test(recentTurn)) {
    return { tier: "trivial", confidence: 0.84, reason: "short simple turn" };
  }

  return { tier: "standard", confidence: 0.78, reason: "general request" };
}

async function startServer(
  handler: (req: http.IncomingMessage, body: Record<string, unknown>, res: http.ServerResponse) => void,
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

export async function startBenchMockServers(opts?: {
  classifierLatencyMs?: number;
}): Promise<MockBenchServers> {
  const latencyMs = opts?.classifierLatencyMs ?? 12;

  const classifier = await startServer((_req, body, res) => {
    const contents = Array.isArray(body.contents) ? body.contents : [];
    const first = (contents[0] ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(first.parts) ? first.parts : [];
    const inputText = String((parts[0] as { text?: unknown } | undefined)?.text ?? "{}");
    const result = simulateFastClassifier(inputText);

    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(result) }],
              },
            },
          ],
        }),
      );
    }, latencyMs);
  });

  const openai = await startServer((_req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl_bench",
        model: body.model ?? "gpt-4.1-mini",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      }),
    );
  });

  const anthropic = await startServer((_req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_bench",
        type: "message",
        role: "assistant",
        model: body.model ?? "claude-sonnet-4-6",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 20 },
      }),
    );
  });

  const gemini = await startServer((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        responseId: "gem_bench",
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: "ok" }] } },
        ],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
      }),
    );
  });

  return {
    classifierUrl: classifier.url,
    openaiUrl: openai.url,
    anthropicUrl: anthropic.url,
    geminiUrl: gemini.url,
    close: async () => {
      await Promise.all(
        [classifier.server, openai.server, anthropic.server, gemini.server].map(
          (s) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      );
    },
  };
}

export function buildBenchRouterConfig(
  mocks: MockBenchServers,
  mode: "simulated" | "heuristic" | "live-classifier",
  liveGeminiKey?: string,
): RouterConfig {
  const decisionModel =
    mode === "heuristic"
      ? {
          baseUrl: mocks.classifierUrl,
          timeoutMs: 600,
          cacheTtlSec: 0,
          apiKeys: [] as string[],
          models: [{ id: "gemini-2.5-flash-lite", rpm: 15, rpd: 1000 }],
        }
      : mode === "live-classifier"
        ? {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            timeoutMs: 2500,
            cacheTtlSec: 0,
            apiKeys: liveGeminiKey ? [liveGeminiKey] : [],
            models: [
              { id: "gemini-2.5-flash-lite", rpm: 15, rpd: 1000 },
              { id: "gemini-2.5-flash", rpm: 10, rpd: 250 },
            ],
          }
        : {
            baseUrl: mocks.classifierUrl,
            timeoutMs: 600,
            cacheTtlSec: 0,
            apiKeys: ["sim-gemini-key"],
            models: [{ id: "gemini-2.5-flash-lite", rpm: 500, rpd: 10000 }],
          };

  return RouterConfigSchema.parse({
    decisionModel,
    providers: {
      anthropic: {
        type: "anthropic",
        baseUrl: mocks.anthropicUrl,
        apiKey: "bench-ant",
        models: {
          "claude-haiku-4-5": {
            contextWindow: 200000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 1.0,
            cachedInputPer1M: 0.1,
            outputPer1M: 5.0,
          },
          "claude-sonnet-4-6": {
            contextWindow: 200000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 3.0,
            cachedInputPer1M: 0.3,
            outputPer1M: 15.0,
          },
          "claude-opus-4-6": {
            contextWindow: 200000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 15.0,
            cachedInputPer1M: 1.5,
            outputPer1M: 75.0,
          },
        },
      },
      openai: {
        type: "openai",
        baseUrl: mocks.openaiUrl,
        apiKey: "bench-oa",
        models: {
          "gpt-4.1-mini": {
            contextWindow: 1047576,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 0.4,
            cachedInputPer1M: 0.1,
            outputPer1M: 1.6,
          },
          "gpt-4.1": {
            contextWindow: 1047576,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 2.0,
            cachedInputPer1M: 0.5,
            outputPer1M: 8.0,
          },
          "o4-mini": {
            contextWindow: 200000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 1.1,
            cachedInputPer1M: 0.275,
            outputPer1M: 4.4,
          },
        },
      },
      gemini: {
        type: "gemini",
        baseUrl: mocks.geminiUrl,
        apiKey: "bench-gem",
        models: {
          "gemini-2.5-flash-lite": {
            contextWindow: 1000000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 0.1,
            cachedInputPer1M: 0.025,
            outputPer1M: 0.4,
          },
          "gemini-2.5-flash": {
            contextWindow: 1000000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 0.3,
            cachedInputPer1M: 0.075,
            outputPer1M: 2.5,
          },
          "gemini-2.5-pro": {
            contextWindow: 1000000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 1.25,
            cachedInputPer1M: 0.31,
            outputPer1M: 10.0,
          },
        },
      },
    },
    tiers: {
      trivial: [
        { provider: "gemini", model: "gemini-2.5-flash-lite" },
        { provider: "openai", model: "gpt-4.1-mini" },
      ],
      standard: [
        { provider: "gemini", model: "gemini-2.5-flash" },
        { provider: "anthropic", model: "claude-haiku-4-5" },
      ],
      complex: [
        { provider: "anthropic", model: "claude-sonnet-4-6" },
        { provider: "openai", model: "gpt-4.1" },
      ],
      frontier: [
        { provider: "anthropic", model: "claude-opus-4-6" },
        { provider: "anthropic", model: "claude-sonnet-4-6" },
      ],
      specialists: {
        vision: [{ provider: "gemini", model: "gemini-2.5-flash" }],
        long_context: [{ provider: "gemini", model: "gemini-2.5-pro" }],
        coding: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
        reasoning: [{ provider: "openai", model: "o4-mini" }],
      },
    },
  });
}
