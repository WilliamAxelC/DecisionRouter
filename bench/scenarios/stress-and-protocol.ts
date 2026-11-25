import http from "node:http";
import { RouterConfigSchema } from "../../src/config/schema.js";
import { parseAnthropicRequest, formatAnthropicStream } from "../../src/protocols/anthropic.js";
import { parseOpenAIRequest } from "../../src/protocols/openai.js";
import { parseSseStream } from "../../src/protocols/sse.js";
import { toAnthropicRequestBody } from "../../src/providers/anthropic-adapter.js";
import { toGeminiRequestBody } from "../../src/providers/gemini-adapter.js";
import { toOpenAIRequestBody } from "../../src/providers/openai-adapter.js";
import { DecisionEngine } from "../../src/router/engine.js";
import type { CanonicalStreamEvent } from "../../src/types/ir.js";
import type { ProtocolAuditItem, StressSummary } from "../types.js";

async function startTempServer(
  handler: (req: http.IncomingMessage, body: Record<string, unknown>, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      handler(req, parsed, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

/**
 * Stress-tests DecisionRouter under:
 * - 30 rapid requests against a 12 RPM free-tier classifier cap (429 beyond 12)
 * - 20% classifier latency spikes (>250ms exceeding 120ms budget)
 * - 25% upstream 503 injection on the primary model to verify pre-stream failover
 */
export async function runStressSuite(): Promise<StressSummary> {
  let classifierHits = 0;
  let upstreamHits = 0;

  const classifierSrv = await startTempServer((_req, _body, res) => {
    classifierHits += 1;
    // Simulate 12 RPM quota exhaustion
    if (classifierHits > 12) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Free tier RPM limit exceeded" } }));
      return;
    }

    const sendOk = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      tier: "standard",
                      confidence: 0.85,
                      reason: "stress test ok",
                    }),
                  },
                ],
              },
            },
          ],
        }),
      );
    };

    // Inject 20% slow tail responses exceeding timeoutMs (120ms)
    if (classifierHits % 5 === 0) {
      setTimeout(sendOk, 260);
      return;
    }
    sendOk();
  });

  const upstreamSrv = await startTempServer((_req, body, res) => {
    upstreamHits += 1;
    // Inject 503 on 25% of primary model requests
    if (body.model === "gpt-primary" && upstreamHits % 4 === 1) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "transient 503" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl_${upstreamHits}`,
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 5 },
      }),
    );
  });

  try {
    const config = RouterConfigSchema.parse({
      decisionModel: {
        baseUrl: classifierSrv.url,
        timeoutMs: 120,
        cacheTtlSec: 60,
        apiKeys: ["sim-key-1"],
        models: [
          { id: "gemini-2.5-flash-lite", rpm: 15, rpd: 1000 },
          { id: "gemini-2.5-flash", rpm: 10, rpd: 250 },
        ],
      },
      providers: {
        openai: {
          type: "openai",
          baseUrl: upstreamSrv.url,
          apiKey: "test",
          models: {
            "gpt-primary": { contextWindow: 128000, supportsTools: true, supportsVision: true },
            "gpt-backup": { contextWindow: 128000, supportsTools: true, supportsVision: true },
          },
        },
      },
      tiers: {
        trivial: [
          { provider: "openai", model: "gpt-primary" },
          { provider: "openai", model: "gpt-backup" },
        ],
        standard: [
          { provider: "openai", model: "gpt-primary" },
          { provider: "openai", model: "gpt-backup" },
        ],
        complex: [
          { provider: "openai", model: "gpt-primary" },
          { provider: "openai", model: "gpt-backup" },
        ],
        frontier: [{ provider: "openai", model: "gpt-backup" }],
      },
      circuitBreaker: { failureThreshold: 2, cooldownSec: 30 },
    });

    const engine = new DecisionEngine(config);
    const totalRequests = 30;
    const latencies: number[] = [];
    const sourceDistribution: Record<string, number> = {};
    let userFacingErrors = 0;
    let failoversTriggered = 0;

    for (let i = 0; i < totalRequests; i++) {
      // Mix unique prompts (misses decision cache) and repeated prompts (hits decision cache)
      const prompt =
        i % 3 === 0
          ? "Repeated helper prompt for cache hit"
          : `Unique request #${i}: write a TypeScript helper for task ${i}`;
      const req = parseOpenAIRequest({
        model: "auto",
        messages: [{ role: "user", content: prompt }],
      });
      try {
        const outcome = await engine.execute(req);
        latencies.push(outcome.decision.decisionMs);
        sourceDistribution[outcome.decision.source] =
          (sourceDistribution[outcome.decision.source] ?? 0) + 1;
        if (outcome.decision.failovers > 0) {
          failoversTriggered += outcome.decision.failovers;
        }
      } catch {
        userFacingErrors += 1;
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      totalRequests,
      userFacingErrors,
      failoversTriggered,
      p50DecisionMs: percentile(sorted, 50),
      p95DecisionMs: percentile(sorted, 95),
      p99DecisionMs: percentile(sorted, 99),
      sourceDistribution,
    };
  } finally {
    await Promise.all([classifierSrv.close(), upstreamSrv.close()]);
  }
}

/**
 * Honestly audits real-world MCP schema, Anthropic cache_control, thinking-block,
 * and cross-protocol SSE translation behaviors.
 */
export async function runProtocolAuditSuite(): Promise<ProtocolAuditItem[]> {
  const items: ProtocolAuditItem[] = [];

  // 1. Messy real-world MCP JSON Schema -> Gemini functionDeclarations
  const mcpReq = parseOpenAIRequest({
    model: "auto",
    messages: [{ role: "user", content: "Search issues" }],
    tools: [
      {
        type: "function",
        function: {
          name: "mcp_search_issues",
          description: "Search GitHub issues",
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
              assignee: { anyOf: [{ type: "string" }, { type: "null" }] },
              labels: { type: "object", properties: {} },
            },
            required: ["query"],
          },
        },
      },
    ],
  });
  const gemBody = toGeminiRequestBody(mcpReq);
  const gemStr = JSON.stringify(gemBody.tools ?? []);
  const unsupportedFound: string[] = [];
  if (gemStr.includes('"$schema"')) unsupportedFound.push("$schema");
  if (gemStr.includes('"additionalProperties"')) unsupportedFound.push("additionalProperties");
  if (gemStr.includes('"anyOf"')) unsupportedFound.push("anyOf");

  items.push({
    id: "audit-gemini-mcp-schema",
    name: "Gemini MCP JSON Schema sanitization",
    status: unsupportedFound.length === 0 ? "PASS" : "GAP",
    detail:
      unsupportedFound.length === 0
        ? "Unsupported JSON Schema keywords stripped before Gemini call."
        : `Gemini-rejected keywords still passed through unmodified: ${unsupportedFound.join(", ")}.`,
  });

  // 2. Anthropic thinking block & signature preservation vs stripping
  const thinkingReq = parseAnthropicRequest({
    model: "auto",
    max_tokens: 512,
    messages: [
      { role: "user", content: "Solve X" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step 1", signature: "sig_real" },
          { type: "text", text: "Done" },
        ],
      },
      { role: "user", content: "Verify" },
    ],
  });
  const antOut = JSON.stringify(toAnthropicRequestBody(thinkingReq, "claude-sonnet-4-6"));
  const oaOut = JSON.stringify(toOpenAIRequestBody(thinkingReq, "gpt-4.1"));
  const gemOut = JSON.stringify(toGeminiRequestBody(thinkingReq));
  const thinkingOk =
    antOut.includes('"signature":"sig_real"') &&
    !oaOut.includes('"thinking"') &&
    !gemOut.includes('"thinking"');
  items.push({
    id: "audit-thinking-isolation",
    name: "Anthropic thinking signature isolation",
    status: thinkingOk ? "PASS" : "GAP",
    detail: thinkingOk
      ? "Preserved for Anthropic upstream; stripped cleanly for OpenAI and Gemini."
      : "Thinking blocks leaked across providers or dropped signature.",
  });

  // 3. Anthropic cache_control breakpoint preservation
  const cacheReq = parseAnthropicRequest({
    model: "auto",
    max_tokens: 512,
    system: [
      {
        type: "text",
        text: "Large static repo prompt",
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: "Hello" }],
  });
  const cacheOut = JSON.stringify(toAnthropicRequestBody(cacheReq, "claude-sonnet-4-6"));
  const hasCacheControl = cacheOut.includes("cache_control");
  items.push({
    id: "audit-anthropic-cache-control",
    name: "Anthropic cache_control breakpoint passthrough",
    status: hasCacheControl ? "PASS" : "GAP",
    detail: hasCacheControl
      ? "cache_control breakpoints preserved through Canonical IR."
      : "parseAnthropicRequest flattens system blocks to string, dropping cache_control breakpoints.",
  });

  // 4. Cross-protocol SSE streaming (Canonical -> Anthropic SSE tool_use lifecycle)
  async function* gen(): AsyncGenerator<CanonicalStreamEvent> {
    yield { type: "message_start", id: "m1", model: "openai/gpt-4.1", inputTokens: 20 };
    yield { type: "text_delta", text: "Calling tool" };
    yield { type: "tool_use_start", index: 0, id: "call_1", name: "grep_search" };
    yield { type: "tool_use_delta", index: 0, partialJson: '{"query":"auth"}' };
    yield { type: "tool_use_stop", index: 0 };
    yield { type: "message_delta", stopReason: "tool_use", usage: { inputTokens: 20, outputTokens: 10 } };
    yield { type: "message_stop" };
  }
  const sseStream = formatAnthropicStream(gen(), "openai/gpt-4.1");
  const seenEvents: string[] = [];
  for await (const frame of parseSseStream(sseStream)) {
    if (frame.event) seenEvents.push(frame.event);
  }
  const sseOk =
    seenEvents[0] === "message_start" &&
    seenEvents.includes("content_block_start") &&
    seenEvents.includes("content_block_stop") &&
    seenEvents[seenEvents.length - 1] === "message_stop";

  items.push({
    id: "audit-cross-protocol-sse",
    name: "Cross-protocol Anthropic SSE tool_use lifecycle",
    status: sseOk ? "PASS" : "GAP",
    detail: sseOk
      ? `Valid ${seenEvents.length}-frame Anthropic SSE lifecycle emitted.`
      : `Malformed SSE lifecycle: ${seenEvents.join(",")}`,
  });

  return items;
}
