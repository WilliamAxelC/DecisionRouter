import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RouterConfigSchema } from "../src/config/schema.js";
import { DecisionEngine } from "../src/router/engine.js";
import { createApp } from "../src/server.js";
import { DecisionStore } from "../src/storage/db.js";

const serversToClose: http.Server[] = [];
const storesToClose: DecisionStore[] = [];

afterEach(async () => {
  await Promise.all(
    serversToClose.splice(0).map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
  for (const st of storesToClose.splice(0)) {
    st.close();
  }
});

async function startMockServer(
  handler: (req: http.IncomingMessage, body: Record<string, unknown>, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      handler(req, parsed, res);
    });
  });
  serversToClose.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

describe("DecisionRouter end-to-end proxy integration", () => {
  it("routes Anthropic client <-> OpenAI/Gemini upstreams, streams SSE, tracks cache-stickiness, escalates on tool errors, fails over on 503, and logs to SQLite + dashboard", async () => {
    let failoverProbe = 0;

    // Mock Gemini (acts as both free decision classifier and Gemini upstream)
    const geminiUrl = await startMockServer((req, body, res) => {
      const url = req.url ?? "";
      // Classifier calls use responseSchema in generationConfig
      const genCfg = (body.generationConfig ?? {}) as Record<string, unknown>;
      if (genCfg.responseSchema) {
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
                        confidence: 0.9,
                        reason: "standard coding task",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        );
        return;
      }

      if (url.includes("streamGenerateContent")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            responseId: "gem_s1",
            candidates: [{ content: { parts: [{ text: "Gemini " }] } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            candidates: [{ finishReason: "STOP", content: { parts: [{ text: "stream!" }] } }],
            usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 8 },
          })}\n\n`,
        );
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          responseId: "gem_1",
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "Hello from Gemini" }] },
            },
          ],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
        }),
      );
    });

    // Mock OpenAI upstream (with simulated 503 on gpt-failover model)
    const openaiUrl = await startMockServer((_req, body, res) => {
      if (body.model === "gpt-failover") {
        failoverProbe += 1;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream overloaded" } }));
        return;
      }

      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl_s1",
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_oa_1",
                      type: "function",
                      function: { name: "run_test", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl_s1",
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"suite":"unit"}' } }],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl_s1",
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 50, completion_tokens: 15 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl_1",
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `OpenAI(${body.model}) reply` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 10 },
        }),
      );
    });

    // Mock Anthropic upstream
    const anthropicUrl = await startMockServer((_req, body, res) => {
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { id: "msg_s1", model: body.model, usage: { input_tokens: 30 } },
          })}\n\n`,
        );
        res.write(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Claude streamed!" },
          })}\n\n`,
        );
        res.write(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 12 },
          })}\n\n`,
        );
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: `Anthropic(${body.model}) reply` }],
          stop_reason: "end_turn",
          usage: { input_tokens: 45, output_tokens: 14 },
        }),
      );
    });

    const config = RouterConfigSchema.parse({
      decisionModel: {
        baseUrl: geminiUrl,
        timeoutMs: 2000,
        apiKeys: ["gem-key"],
        models: [{ id: "gemini-2.5-flash-lite", rpm: 30, rpd: 1000 }],
      },
      providers: {
        openai: {
          type: "openai",
          baseUrl: openaiUrl,
          apiKey: "oa-key",
          models: {
            "gpt-failover": { contextWindow: 128000, supportsTools: true, supportsVision: true },
            "gpt-4.1-mini": { contextWindow: 128000, supportsTools: true, supportsVision: true },
          },
        },
        anthropic: {
          type: "anthropic",
          baseUrl: anthropicUrl,
          apiKey: "ant-key",
          models: {
            "claude-sonnet-4-6": { contextWindow: 200000, supportsTools: true, supportsVision: true },
          },
        },
        gemini: {
          type: "gemini",
          baseUrl: geminiUrl,
          apiKey: "gem-key",
          models: {
            "gemini-2.5-flash": { contextWindow: 1000000, supportsTools: true, supportsVision: true },
          },
        },
      },
      tiers: {
        trivial: [{ provider: "openai", model: "gpt-4.1-mini" }],
        standard: [
          { provider: "openai", model: "gpt-failover" },
          { provider: "openai", model: "gpt-4.1-mini" },
        ],
        complex: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
        frontier: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
      },
    });

    const store = new DecisionStore(":memory:");
    storesToClose.push(store);
    const engine = new DecisionEngine(config);
    const app = createApp({ config, engine, store });

    // 1. Anthropic client -> standard tier -> fails over from gpt-failover (503) to gpt-4.1-mini (stream with tool_use)
    const r1 = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-router-session": "sess-loop-1",
      },
      body: JSON.stringify({
        model: "auto",
        max_tokens: 512,
        stream: true,
        messages: [{ role: "user", content: "Run the unit test suite" }],
      }),
    });
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-router-model")).toBe("openai/gpt-4.1-mini");
    expect(r1.headers.get("x-router-source")).toBe("gemini");
    expect(r1.headers.get("x-router-failovers")).toBe("1");
    expect(failoverProbe).toBe(1);
    const r1Body = await r1.text();
    expect(r1Body).toContain("event: message_start");
    expect(r1Body).toContain('"type":"tool_use"');
    expect(r1Body).toContain('"name":"run_test"');

    // 2. Step 2 in same session (tool_result continuation) -> cache-sticky on openai/gpt-4.1-mini!
    const r2 = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-router-session": "sess-loop-1",
      },
      body: JSON.stringify({
        model: "auto",
        max_tokens: 512,
        stream: false,
        messages: [
          { role: "user", content: "Run the unit test suite" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_oa_1", name: "run_test", input: { suite: "unit" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_oa_1", content: "passed 10/10" }],
          },
        ],
      }),
    });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("x-router-cache-sticky")).toBe("true");
    expect(r2.headers.get("x-router-model")).toBe("openai/gpt-4.1-mini");

    // 3. Consecutive tool errors trigger immediate escalation to complex (anthropic/claude-sonnet-4-6)
    const r3 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-router-session": "sess-loop-1",
      },
      body: JSON.stringify({
        model: "auto",
        stream: true,
        messages: [
          { role: "user", content: "Fix test" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "t1", type: "function", function: { name: "run", arguments: '{"a":1}' } }],
          },
          { role: "tool", tool_call_id: "t1", content: "Error: exit code 1" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "t2", type: "function", function: { name: "run", arguments: '{"a":2}' } }],
          },
          { role: "tool", tool_call_id: "t2", content: "Traceback: fail" },
        ],
      }),
    });
    expect(r3.status).toBe(200);
    expect(r3.headers.get("x-router-escalated")).toBe("true");
    expect(r3.headers.get("x-router-tier")).toBe("complex");
    expect(r3.headers.get("x-router-model")).toBe("anthropic/claude-sonnet-4-6");
    const r3Text = await r3.text();
    expect(r3Text).toContain("Claude streamed!");
    expect(r3Text).toContain("[DONE]");

    // 4. OpenAI client -> direct/gemini/gemini-2.5-flash passthrough (stream + non-stream)
    const r4 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "direct/gemini/gemini-2.5-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(r4.status).toBe(200);
    expect(r4.headers.get("x-router-source")).toBe("passthrough");
    expect(r4.headers.get("x-router-model")).toBe("gemini/gemini-2.5-flash");
    const r4Text = await r4.text();
    expect(r4Text).toContain("Gemini ");
    expect(r4Text).toContain("stream!");

    // 5. X-Router-Tier header override
    const r5 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-router-tier": "trivial",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(r5.status).toBe(200);
    expect(r5.headers.get("x-router-source")).toBe("header");
    expect(r5.headers.get("x-router-tier")).toBe("trivial");

    // 6. Verify SQLite persistence & dashboard endpoints
    const statsRes = await app.request("/_router/api/stats?hours=24");
    const statsJson = (await statsRes.json()) as {
      totalRequests: number;
      cacheStickyCount: number;
      escalatedCount: number;
      failoverCount: number;
    };
    expect(statsJson.totalRequests).toBe(5);
    expect(statsJson.cacheStickyCount).toBe(1);
    expect(statsJson.escalatedCount).toBe(1);
    expect(statsJson.failoverCount).toBe(1);

    const recentRes = await app.request("/_router/api/recent?limit=10");
    const recentJson = (await recentRes.json()) as { items: unknown[] };
    expect(recentJson.items).toHaveLength(5);

    const dashRes = await app.request("/_router");
    expect(dashRes.status).toBe(200);
    const html = await dashRes.text();
    expect(html).toContain("DecisionRouter");
  });
});
