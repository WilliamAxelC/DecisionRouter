import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RouterConfigSchema } from "../src/config/schema.js";
import { parseOpenAIRequest } from "../src/protocols/openai.js";
import { CircuitBreaker } from "../src/providers/circuit-breaker.js";
import { DecisionEngine } from "../src/router/engine.js";
import { extractFeatures } from "../src/router/features.js";
import { shouldStayCacheSticky } from "../src/router/session-store.js";

const serversToClose: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    serversToClose.splice(0).map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
});

async function startHttpServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, Buffer.concat(chunks).toString("utf8"), res));
  });
  serversToClose.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

describe("Feature extraction & escalation signals", () => {
  it("detects consecutive tool errors and repeated tool loops", () => {
    const req = parseOpenAIRequest({
      model: "auto",
      messages: [
        { role: "user", content: "Run tests" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "run_cmd", arguments: '{"cmd":"npm test"}' } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "Error: exit code 1" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c2", type: "function", function: { name: "run_cmd", arguments: '{"cmd":"npm test"}' } },
          ],
        },
        { role: "tool", tool_call_id: "c2", content: "Traceback: still failing" },
      ],
    });

    const f = extractFeatures(req, 1800);
    expect(f.isToolLoopContinuation).toBe(true);
    expect(f.consecutiveToolErrors).toBe(2);
    expect(f.repeatedToolLoop).toBe(true);
  });

  it("detects user correction signal and trims recent turn to maxContextChars", () => {
    const huge = "x".repeat(5000);
    const req = parseOpenAIRequest({
      model: "auto",
      messages: [
        { role: "system", content: huge },
        { role: "user", content: huge },
        { role: "assistant", content: "Done." },
        { role: "user", content: "No, that's wrong, try again." },
      ],
    });
    const f = extractFeatures(req, 500);
    expect(f.userCorrectionSignal).toBe(true);
    expect(f.trimmedRecentTurn.length).toBeLessThanOrEqual(500);
  });
});

describe("Cache-stickiness cost math", () => {
  it("keeps warm mid-tier model when switching to a cheaper uncached model loses money on prefill, and allows switching when context is small", () => {
    const config = RouterConfigSchema.parse({
      providers: {
        anthropic: {
          type: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          models: {
            "claude-sonnet-4-6": { inputPer1M: 3, cachedInputPer1M: 0.3, outputPer1M: 15 },
            "claude-haiku-4-5": { inputPer1M: 1, cachedInputPer1M: 0.1, outputPer1M: 5 },
          },
        },
      },
    });
    const profile = config.profiles.auto;

    // Large warm prefix (~80k tokens): cached sonnet ($0.3/1M) beats uncached haiku ($1.0/1M)
    const largeReq = parseOpenAIRequest({
      model: "auto",
      messages: [{ role: "user", content: "a".repeat(320_000) }],
    });
    const largeFeatures = extractFeatures(largeReq);
    const largeSession = {
      sessionId: "s1",
      lastProvider: "anthropic",
      lastModel: "claude-sonnet-4-6",
      lastTier: "complex" as const,
      lastUpdatedAt: Date.now(),
      estimatedCachedTokens: 79_500,
    };

    const keepRes = shouldStayCacheSticky(
      largeSession,
      "anthropic",
      "claude-haiku-4-5",
      "trivial",
      largeFeatures,
      config,
      profile,
    );
    expect(keepRes.staySticky).toBe(true);

    // Small prefix (~1k tokens): uncached haiku is significantly cheaper than staying on sonnet
    const smallReq = parseOpenAIRequest({
      model: "auto",
      messages: [{ role: "user", content: "a".repeat(4_000) }],
    });
    const smallFeatures = extractFeatures(smallReq);
    const smallSession = {
      ...largeSession,
      estimatedCachedTokens: 800,
    };

    const switchRes = shouldStayCacheSticky(
      smallSession,
      "anthropic",
      "claude-haiku-4-5",
      "trivial",
      smallFeatures,
      config,
      profile,
    );
    expect(switchRes.staySticky).toBe(false);
  });
});

describe("Gemini free-tier decision waterfall & circuit breaker", () => {
  it("rotates across Gemini models/keys on 429 and falls back to heuristics on exhaustion/timeout", async () => {
    const calls: Array<{ url: string; key: string | undefined }> = [];
    const baseUrl = await startHttpServer((req, _body, res) => {
      calls.push({ url: req.url ?? "", key: req.headers["x-goog-api-key"] as string | undefined });
      // First model returns 429, second model succeeds!
      if ((req.url ?? "").includes("gemini-2.5-flash-lite")) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "quota exceeded" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      tier: "complex",
                      confidence: 0.91,
                      reason: "distributed concurrency fix",
                    }),
                  },
                ],
              },
            },
          ],
        }),
      );
    });

    const config = RouterConfigSchema.parse({
      decisionModel: {
        baseUrl,
        timeoutMs: 2000,
        apiKeys: ["key-1"],
        models: [
          { id: "gemini-2.5-flash-lite", rpm: 15, rpd: 1000 },
          { id: "gemini-2.5-flash", rpm: 10, rpd: 250 },
        ],
      },
      providers: {
        anthropic: { type: "anthropic", baseUrl: "http://localhost:1", models: {} },
      },
      tiers: {
        complex: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
        frontier: [{ provider: "anthropic", model: "claude-opus-4-6" }],
      },
    });

    const engine = new DecisionEngine(config);
    const req = parseOpenAIRequest({
      model: "auto",
      messages: [{ role: "user", content: "Design a distributed lock manager" }],
    });
    const plan = await engine.decide(req);

    expect(calls).toHaveLength(2);
    expect(plan.decision.source).toBe("gemini");
    expect(plan.decision.tier).toBe("complex");
    expect(plan.decision.selectedModel).toBe("claude-sonnet-4-6");
  });

  it("falls back silently to heuristics when decision model times out", async () => {
    const baseUrl = await startHttpServer((_req, _body, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("{}");
      }, 400);
    });

    const config = RouterConfigSchema.parse({
      decisionModel: {
        baseUrl,
        timeoutMs: 60,
        apiKeys: ["key-1"],
        models: [{ id: "gemini-2.5-flash-lite", rpm: 15, rpd: 1000 }],
      },
      providers: {
        openai: { type: "openai", baseUrl: "http://localhost:1", models: {} },
      },
      tiers: {
        trivial: [{ provider: "openai", model: "gpt-4.1-mini" }],
        standard: [{ provider: "openai", model: "gpt-4.1-mini" }],
      },
    });

    const engine = new DecisionEngine(config);
    const req = parseOpenAIRequest({
      model: "auto",
      messages: [{ role: "user", content: 'Format JSON: {"a":1}' }],
    });
    const plan = await engine.decide(req);
    expect(plan.decision.source).toBe("heuristic");
    expect(plan.decision.tier).toBe("trivial");
  });

  it("trips circuit breaker after threshold failures and recovers after cooldown", () => {
    const cb = new CircuitBreaker(2, 10);
    const t0 = 1_000_000;
    expect(cb.isAvailable("openai", "gpt-4.1", t0)).toBe(true);
    cb.recordFailure("openai", "gpt-4.1", "503", t0);
    expect(cb.isAvailable("openai", "gpt-4.1", t0 + 100)).toBe(true);
    cb.recordFailure("openai", "gpt-4.1", "503", t0 + 200);
    expect(cb.isAvailable("openai", "gpt-4.1", t0 + 1000)).toBe(false);
    expect(cb.isAvailable("openai", "gpt-4.1", t0 + 10_500)).toBe(true);
  });
});

describe("Inline self-answering tier ('self')", () => {
  it("answers pure decision tasks directly from the decision model with 0 upstream calls (JSON & SSE)", async () => {
    let upstreamHits = 0;
    const classifierUrl = await startHttpServer((_req, _body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      tier: "self",
                      confidence: 0.98,
                      reason: "binary triage decision",
                      directAnswer: "FINAL: PHISHING",
                    }),
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    const upstreamUrl = await startHttpServer((_req, _body, res) => {
      upstreamHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });

    const config = RouterConfigSchema.parse({
      decisionModel: {
        baseUrl: classifierUrl,
        timeoutMs: 2000,
        cacheTtlSec: 0,
        allowSelfAnswer: true,
        apiKeys: ["key-1"],
        models: [{ id: "gemini-2.5-flash-lite", rpm: 15, rpd: 1000 }],
      },
      providers: {
        openai: { type: "openai", baseUrl: upstreamUrl, apiKey: "oa", models: {} },
      },
      tiers: {
        trivial: [{ provider: "openai", model: "gpt-4.1-mini" }],
      },
    });

    const engine = new DecisionEngine(config);

    // Non-streaming self answer
    const req1 = parseOpenAIRequest({
      model: "auto",
      messages: [{ role: "user", content: "Is this email SAFE or PHISHING?" }],
    });
    const out1 = await engine.execute(req1);
    expect(out1.decision.tier).toBe("self");
    expect(out1.decision.source).toBe("self_answer");
    expect(out1.decision.selfHandled).toBe(true);
    expect(out1.decision.selectedProvider).toBe("decision-model");
    expect(out1.result.kind).toBe("response");
    if (out1.result.kind === "response") {
      expect(out1.result.response.content[0]).toEqual({
        type: "text",
        text: "FINAL: PHISHING",
      });
    }

    // Streaming self answer
    const req2 = parseOpenAIRequest({
      model: "auto",
      stream: true,
      messages: [{ role: "user", content: "Is this email SAFE or PHISHING?" }],
    });
    const out2 = await engine.execute(req2);
    expect(out2.decision.selfHandled).toBe(true);
    expect(out2.result.kind).toBe("stream");
    if (out2.result.kind === "stream") {
      const texts: string[] = [];
      for await (const ev of out2.result.stream) {
        if (ev.type === "text_delta") texts.push(ev.text);
      }
      expect(texts.join("")).toBe("FINAL: PHISHING");
    }

    expect(upstreamHits).toBe(0);
  });

  it("omits 'self' from Gemini responseSchema when tools or images are present, and downgrades empty directAnswer to trivial", async () => {
    const capturedSchemas: Array<{ tierEnum: string[]; hasDirectAnswer: boolean }> = [];
    let mode: "tools" | "empty_self" = "tools";

    const classifierUrl = await startHttpServer((_req, bodyStr, res) => {
      const parsed = JSON.parse(bodyStr) as {
        generationConfig?: {
          responseSchema?: {
            properties?: {
              tier?: { enum?: string[] };
              directAnswer?: unknown;
            };
          };
        };
      };
      const props = parsed.generationConfig?.responseSchema?.properties;
      capturedSchemas.push({
        tierEnum: props?.tier?.enum ?? [],
        hasDirectAnswer: Boolean(props?.directAnswer),
      });

      res.writeHead(200, { "content-type": "application/json" });
      if (mode === "tools") {
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        tier: "standard",
                        confidence: 0.9,
                        reason: "tool call needed",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        tier: "self",
                        confidence: 0.8,
                        reason: "forgot answer",
                        directAnswer: "   ",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        );
      }
    });

    const config = RouterConfigSchema.parse({
      decisionModel: {
        baseUrl: classifierUrl,
        timeoutMs: 2000,
        cacheTtlSec: 0,
        allowSelfAnswer: true,
        apiKeys: ["key-1"],
        models: [{ id: "gemini-2.5-flash-lite", rpm: 15, rpd: 1000 }],
      },
      providers: {
        openai: { type: "openai", baseUrl: "http://localhost:1", models: {} },
      },
      tiers: {
        trivial: [{ provider: "openai", model: "gpt-4.1-mini" }],
        standard: [{ provider: "openai", model: "gpt-4.1-mini" }],
      },
    });

    const engine = new DecisionEngine(config);

    // Request with tools must exclude "self" and "directAnswer" from classifier schema
    const toolReq = parseOpenAIRequest({
      model: "auto",
      messages: [{ role: "user", content: "Check file" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    });
    await engine.decide(toolReq);
    expect(capturedSchemas[0].tierEnum).not.toContain("self");
    expect(capturedSchemas[0].hasDirectAnswer).toBe(false);

    // Request where classifier returns tier:"self" with blank directAnswer falls back to trivial
    mode = "empty_self";
    const plainReq = parseOpenAIRequest({
      model: "auto",
      messages: [{ role: "user", content: "Classify this ticket" }],
    });
    const plan2 = await engine.decide(plainReq);
    expect(capturedSchemas[1].tierEnum).toContain("self");
    expect(capturedSchemas[1].hasDirectAnswer).toBe(true);
    expect(plan2.decision.selfHandled).toBe(false);
    expect(plan2.decision.tier).toBe("trivial");
    expect(plan2.decision.selectedModel).toBe("gpt-4.1-mini");
  });

  it("supports Gemini Decisions API (/v1beta/decisions) for gemini-decision-1 self-answer and non-choice routing", async () => {
    const requestsSeen: Array<{ url: string; body: Record<string, unknown> }> = [];
    let upstreamHits = 0;

    const baseUrl = await startHttpServer((req, bodyStr, res) => {
      const parsed = JSON.parse(bodyStr) as Record<string, unknown>;
      requestsSeen.push({ url: req.url ?? "", body: parsed });

      const questions = (parsed.questions ?? {}) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      if (questions.self_answer) {
        res.end(
          JSON.stringify({
            answers: {
              route: { choice: "self", confidence: 0.91, type: "choice" },
              self_answer: { choice: "SECURITY", confidence: 0.95, type: "choice" },
            },
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            answers: {
              route: { choice: "complex", confidence: 0.88, type: "choice" },
            },
          }),
        );
      }
    });

    const upstreamUrl = await startHttpServer((_req, _body, res) => {
      upstreamHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          responseId: "gem_hi",
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "FINAL: Cara" }] } }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
        }),
      );
    });

    const config = RouterConfigSchema.parse({
      decisionModel: {
        baseUrl,
        timeoutMs: 2000,
        cacheTtlSec: 0,
        allowSelfAnswer: true,
        apiKeys: ["key-1"],
        models: [{ id: "gemini-decision-1", api: "decisions", rpm: 200, tpm: 50000, rpd: 10000 }],
      },
      providers: {
        gemini: { type: "gemini", baseUrl: upstreamUrl, apiKey: "gem", models: {} },
      },
      tiers: {
        trivial: [{ provider: "gemini", model: "gemini-3.8-flash" }],
        complex: [{ provider: "gemini", model: "gemini-4-hydrogen" }],
      },
    });

    const engine = new DecisionEngine(config);

    // 1. Discrete choice classification -> handled inline via Decisions API self_answer with 0 upstream calls
    const reqChoice = parseOpenAIRequest({
      model: "auto",
      messages: [
        {
          role: "user",
          content:
            'Route this support ticket (BILLING, TECHNICAL, SECURITY, or SALES): "Unauthorized SSO login." End with ONLY FINAL: <QUEUE>.',
        },
      ],
    });
    const out1 = await engine.execute(reqChoice);
    expect(requestsSeen[0].url).toBe("/decisions");
    expect(out1.decision.tier).toBe("self");
    expect(out1.decision.selfHandled).toBe(true);
    expect(out1.decision.selectedModel).toBe("gemini-decision-1");
    expect(out1.result.kind).toBe("response");
    if (out1.result.kind === "response") {
      expect(out1.result.response.content[0]).toEqual({
        type: "text",
        text: "FINAL: SECURITY",
      });
    }
    expect(upstreamHits).toBe(0);

    // 2. Open-ended reasoning puzzle -> no self_answer question sent, routes to complex (gemini-4-hydrogen)
    const reqReasoning = parseOpenAIRequest({
      model: "auto",
      messages: [
        {
          role: "user",
          content:
            "Four engineers sit in seats 1..4. Who sits in seat 4? End with ONLY FINAL: <Name>.",
        },
      ],
    });
    const out2 = await engine.execute(reqReasoning);
    expect((requestsSeen[1].body.questions as Record<string, unknown>).self_answer).toBeUndefined();
    expect(out2.decision.selfHandled).toBe(false);
    expect(out2.decision.tier).toBe("complex");
    expect(out2.decision.selectedModel).toBe("gemini-4-hydrogen");
    expect(upstreamHits).toBe(1);
  });

  it("permanently quarantines invalid auth keys on DecisionClassifier & GeminiAdapter without spamming", async () => {
    const classifierHits: Record<string, number> = {};
    const classifierUrl = await startHttpServer((req, _bodyStr, res) => {
      const k = String(req.headers["x-goog-api-key"] ?? "none");
      classifierHits[k] = (classifierHits[k] ?? 0) + 1;
      if (k === "bad-key") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "API_KEY_INVALID" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          answers: { route: { choice: "standard", confidence: 0.9, type: "choice" } },
        }),
      );
    });

    const upstreamHits: Record<string, number> = {};
    const upstreamUrl = await startHttpServer((req, _bodyStr, res) => {
      const k = String(req.headers["x-goog-api-key"] ?? "none");
      upstreamHits[k] = (upstreamHits[k] ?? 0) + 1;
      if (k === "bad-key") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "PERMISSION_DENIED" } }));
        return;
      }
      if (k === "rl-key") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rate limit" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          responseId: "gem_ok",
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        }),
      );
    });

    const config = RouterConfigSchema.parse({
      decisionModel: {
        baseUrl: classifierUrl,
        timeoutMs: 2000,
        cacheTtlSec: 0,
        apiKeys: ["bad-key", "good-key"],
        models: [{ id: "gemini-decision-1", api: "decisions", rpm: 200, rpd: 10000 }],
      },
      providers: {
        gemini: {
          type: "gemini",
          baseUrl: upstreamUrl,
          apiKeys: ["bad-key", "rl-key", "good-key"],
          models: {},
        },
      },
      tiers: {
        standard: [{ provider: "gemini", model: "gemini-3.8-flash" }],
      },
    });

    const engine = new DecisionEngine(config);

    // Call 1: bad-key quarantined on both classifier & upstream; rl-key gets 429 cooldown; good-key succeeds
    const r1 = await engine.execute(
      parseOpenAIRequest({ model: "auto", messages: [{ role: "user", content: "Explain HTTP 200" }] }),
    );
    expect(r1.decision.selectedModel).toBe("gemini-3.8-flash");
    expect(classifierHits["bad-key"]).toBe(1);
    expect(classifierHits["good-key"]).toBe(1);
    expect(upstreamHits["bad-key"]).toBe(1);
    expect(upstreamHits["rl-key"]).toBe(1);
    expect(upstreamHits["good-key"]).toBe(1);

    // Call 2: bad-key is NEVER hit again (no spamming!)
    await engine.execute(
      parseOpenAIRequest({ model: "auto", messages: [{ role: "user", content: "Explain HTTP 201" }] }),
    );
    expect(classifierHits["bad-key"]).toBe(1);
    expect(classifierHits["good-key"]).toBe(2);
    expect(upstreamHits["bad-key"]).toBe(1);
    expect(upstreamHits["rl-key"]).toBe(1);
    expect(upstreamHits["good-key"]).toBe(2);

    // Quota status exposes disabled=true for quarantined key #1
    const status = engine.classifier.getQuotaStatus(config.decisionModel);
    expect(status.find((s) => s.keyIndex === 0)?.disabled).toBe(true);
    expect(status.find((s) => s.keyIndex === 1)?.disabled).toBe(false);
  });
});

describe("DecisionRouter v2 multi-probe, smart escalation, inertia & cascade retry", () => {
  it("dual-gates 'self' tier using multi-probe riskScore + self_answer confidence", async () => {
    let scenario: "safe_self" | "risky_self" = "safe_self";
    const classifierUrl = await startHttpServer((_req, _bodyStr, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (scenario === "safe_self") {
        res.end(
          JSON.stringify({
            answers: {
              error_risk: { noul: 0.1, type: "noul" },
              needs_reasoning: { noul: 0.08, type: "noul" },
              difficulty: { score: 0.5, type: "score" },
              self_answer: { choice: "NEGATIVE", confidence: 0.94, type: "choice" },
            },
          }),
        );
      } else {
        // High self_answer confidence, but riskScore is high (> selfMaxRisk) -> reject self & route complex
        res.end(
          JSON.stringify({
            answers: {
              error_risk: { noul: 0.65, type: "noul" },
              needs_reasoning: { noul: 0.70, type: "noul" },
              difficulty: { score: 2.8, type: "score" },
              self_answer: { choice: "VALID", confidence: 0.91, type: "choice" },
            },
          }),
        );
      }
    });

    const config = RouterConfigSchema.parse({
      decisionModel: {
        baseUrl: classifierUrl,
        timeoutMs: 2000,
        cacheTtlSec: 0,
        allowSelfAnswer: true,
        apiKeys: ["key-1"],
        models: [{ id: "gemini-decision-1", api: "decisions", rpm: 200, rpd: 10000 }],
      },
      providers: {
        gemini: { type: "gemini", baseUrl: "http://localhost:1", models: {} },
      },
      tiers: {
        trivial: [{ provider: "gemini", model: "gemini-3.8-flash" }],
        complex: [{ provider: "gemini", model: "gemini-4-hydrogen" }],
      },
    });

    const engine = new DecisionEngine(config);

    const p1 = await engine.decide(
      parseOpenAIRequest({
        model: "auto",
        messages: [{ role: "user", content: "Sentiment (POSITIVE or NEGATIVE): broken!" }],
      }),
    );
    expect(p1.decision.tier).toBe("self");
    expect(p1.decision.selfHandled).toBe(true);
    expect(p1.decision.selfAnswer).toBe("NEGATIVE");

    scenario = "risky_self";
    const p2 = await engine.decide(
      parseOpenAIRequest({
        model: "auto",
        messages: [{ role: "user", content: "Is this logic VALID or INVALID?" }],
      }),
    );
    expect(p2.decision.selfHandled).toBe(false);
    expect(p2.decision.tier).toBe("complex");
    expect(p2.decision.selectedModel).toBe("gemini-4-hydrogen");
  });

  it("escalates on subtle pushback noul probe, locks floor for 2 turns, detects edit-fail oscillation & context inertia, and cascade-retries malformed JSON", async () => {
    let userCorrectingProb = 0.05;
    let riskOverride = 0.1;

    const classifierUrl = await startHttpServer((_req, _bodyStr, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          answers: {
            error_risk: { noul: riskOverride, type: "noul" },
            needs_reasoning: { noul: riskOverride, type: "noul" },
            difficulty: { score: riskOverride * 4, type: "score" },
            user_is_correcting: { noul: userCorrectingProb, type: "noul" },
          },
        }),
      );
    });

    let upstreamCalls = 0;
    const upstreamUrl = await startHttpServer((_req, bodyStr, res) => {
      upstreamCalls += 1;
      const body = JSON.parse(bodyStr) as { model?: string };
      res.writeHead(200, { "content-type": "application/json" });
      // Light model outputs malformed JSON; complex model outputs valid JSON
      const content =
        body.model === "gpt-light"
          ? "Sorry, here is broken json {not_valid"
          : '{"eligible":false,"reason_code":"EXPIRED"}';
      res.end(
        JSON.stringify({
          id: `cmpl_${upstreamCalls}`,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      );
    });

    const config = RouterConfigSchema.parse({
      decisionModel: {
        baseUrl: classifierUrl,
        timeoutMs: 2000,
        cacheTtlSec: 0,
        apiKeys: ["key-1"],
        models: [{ id: "gemini-decision-1", api: "decisions", rpm: 200, rpd: 10000 }],
      },
      providers: {
        openai: { type: "openai", baseUrl: upstreamUrl, apiKey: "oa", models: {} },
      },
      tiers: {
        trivial: [{ provider: "openai", model: "gpt-light" }],
        standard: [{ provider: "openai", model: "gpt-light" }],
        complex: [{ provider: "openai", model: "gpt-smart" }],
        frontier: [{ provider: "openai", model: "gpt-smart" }],
      },
    });

    const engine = new DecisionEngine(config);

    // 1. Subtle pushback ("hmm wait, check that again") -> escalates to complex & sets sticky lock (2 turns)
    userCorrectingProb = 0.85;
    const out1 = await engine.execute(
      parseOpenAIRequest({
        model: "auto",
        messages: [
          { role: "user", content: "Compute total" },
          { role: "assistant", content: "10" },
          { role: "user", content: "Hmm wait, check that math one more time carefully." },
        ],
      }),
      // explicit session via headers below
    );
    expect(out1.decision.escalated).toBe(true);
    expect(out1.decision.tier).toBe("complex");

    // 2. Sticky escalation lock + context inertia keep follow-up elevated even when risk drops
    userCorrectingProb = 0.05;
    const out2 = await engine.execute(
      parseOpenAIRequest(
        {
          model: "auto",
          messages: [
            { role: "user", content: "Fix auth race condition" },
            { role: "assistant", content: "Fixed" },
            { role: "user", content: "ok do the same for billing" },
          ],
        },
        { "x-router-session": out1.decision.sessionId },
      ),
    );
    expect(out2.decision.tier).toBe("complex");

    // 3. Fuzzy edit-fail oscillation (same file edited twice with different args + error) triggers escalation
    const oscPlan = await engine.decide(
      parseOpenAIRequest({
        model: "auto",
        messages: [
          { role: "user", content: "Fix lock.ts" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "edit_file", arguments: '{"path":"lock.ts","replacement":"v1"}' } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "Error: test failed" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c2", type: "function", function: { name: "edit_file", arguments: '{"path":"lock.ts","replacement":"v2"}' } },
            ],
          },
          { role: "tool", tool_call_id: "c2", content: "ok" },
        ],
      }),
    );
    expect(oscPlan.features.editFailOscillation).toBe(true);
    expect(oscPlan.decision.escalated).toBe(true);
    expect(oscPlan.decision.tier).toBe("complex");

    // 4. Non-streaming structural cascade retry: Light returns invalid JSON -> auto-escalates to gpt-smart
    riskOverride = 0.05;
    const cascadeOut = await engine.execute(
      parseOpenAIRequest({
        model: "auto",
        messages: [{ role: "user", content: "Return ONLY JSON for policy eligibility." }],
      }),
    );
    expect(cascadeOut.decision.cascadeRetried).toBe(true);
    expect(cascadeOut.decision.escalated).toBe(true);
    expect(cascadeOut.decision.selectedModel).toBe("gpt-smart");
  });
});
