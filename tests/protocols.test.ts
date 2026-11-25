import { describe, expect, it } from "vitest";
import {
  formatAnthropicResponse,
  formatAnthropicStream,
  parseAnthropicRequest,
} from "../src/protocols/anthropic.js";
import {
  formatOpenAIResponse,
  formatOpenAIStream,
  parseOpenAIRequest,
} from "../src/protocols/openai.js";
import { parseSseStream } from "../src/protocols/sse.js";
import { toAnthropicRequestBody } from "../src/providers/anthropic-adapter.js";
import {
  fromGeminiResponse,
  toGeminiRequestBody,
} from "../src/providers/gemini-adapter.js";
import { toOpenAIRequestBody } from "../src/providers/openai-adapter.js";
import type { CanonicalStreamEvent } from "../src/types/ir.js";

describe("Cross-protocol translation", () => {
  it("translates OpenAI request -> Canonical -> Anthropic & Gemini with tool_use/tool_result mapping", () => {
    const req = parseOpenAIRequest({
      model: "auto",
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Check status of file a.ts" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "a.ts" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: "export const x = 1;",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Reads a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
      stream: false,
    });

    expect(req.system).toBe("You are concise.");
    expect(req.tools).toHaveLength(1);

    const anthropicBody = toAnthropicRequestBody(req, "claude-sonnet-4-6");
    expect(anthropicBody.system).toBe("You are concise.");
    const aMsgs = anthropicBody.messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(aMsgs[1].role).toBe("assistant");
    expect(aMsgs[1].content[0].type).toBe("tool_use");
    expect(aMsgs[2].role).toBe("user");
    expect(aMsgs[2].content[0].type).toBe("tool_result");

    const geminiBody = toGeminiRequestBody(req);
    const gContents = geminiBody.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(gContents[1].role).toBe("model");
    expect((gContents[1].parts[0].functionCall as { name: string }).name).toBe("read_file");
    expect(
      (gContents[2].parts[0].functionResponse as { name: string }).name,
    ).toBe("read_file");
  });

  it("preserves Anthropic thinking blocks & signatures only for Anthropic upstreams, stripping them for OpenAI/Gemini", () => {
    const req = parseAnthropicRequest({
      model: "auto",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Solve this" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal thought", signature: "sig_abc" },
            { type: "text", text: "Answer is 42." },
          ],
        },
        { role: "user", content: "Explain why" },
      ],
    });

    const anthropicBody = toAnthropicRequestBody(req, "claude-sonnet-4-6");
    const assistantAnthropic = (
      anthropicBody.messages as Array<{ content: Array<{ type: string; signature?: string }> }>
    )[1];
    expect(assistantAnthropic.content[0]).toEqual({
      type: "thinking",
      thinking: "internal thought",
      signature: "sig_abc",
    });

    const openaiBody = toOpenAIRequestBody(req, "gpt-4.1");
    const assistantOpenAI = (
      openaiBody.messages as Array<{ role: string; content: string }>
    )[1];
    expect(assistantOpenAI.content).toBe("Answer is 42.");

    const geminiBody = toGeminiRequestBody(req);
    const assistantGemini = (
      geminiBody.contents as Array<{ parts: Array<{ text?: string }> }>
    )[1];
    expect(assistantGemini.parts).toEqual([{ text: "Answer is 42." }]);
  });

  it("parses multimodal images across OpenAI data URLs and Anthropic base64", () => {
    const req = parseOpenAIRequest({
      model: "auto",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe image" },
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,QUJD" },
            },
          ],
        },
      ],
    });
    const geminiBody = toGeminiRequestBody(req);
    const parts = (
      geminiBody.contents as Array<{ parts: Array<Record<string, unknown>> }>
    )[0].parts;
    expect(parts[1]).toEqual({
      inlineData: { mimeType: "image/jpeg", data: "QUJD" },
    });

    const anthropicBody = toAnthropicRequestBody(req, "claude-sonnet-4-6");
    const aParts = (
      anthropicBody.messages as Array<{ content: Array<Record<string, unknown>> }>
    )[0].content;
    expect(aParts[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
    });
  });

  it("formats Gemini functionCall response to OpenAI & Anthropic formats", () => {
    const canonical = fromGeminiResponse(
      {
        responseId: "resp_1",
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { text: "Let me inspect that." },
                { functionCall: { name: "grep", args: { query: "TODO" } } },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 30,
          cachedContentTokenCount: 40,
        },
      },
      "gemini-2.5-flash",
    );

    expect(canonical.stopReason).toBe("tool_use");
    const oa = formatOpenAIResponse(canonical, "gemini/gemini-2.5-flash");
    const oaMsg = (oa.choices as Array<{ message: Record<string, unknown>; finish_reason: string }>)[0];
    expect(oaMsg.finish_reason).toBe("tool_calls");
    expect((oaMsg.message.tool_calls as Array<unknown>)).toHaveLength(1);

    const ant = formatAnthropicResponse(canonical, "gemini/gemini-2.5-flash");
    expect(ant.stop_reason).toBe("tool_use");
    expect((ant.usage as { cache_read_input_tokens: number }).cache_read_input_tokens).toBe(40);
  });

  it("separates Gemini thought=true parts into thinking blocks instead of user-facing text", () => {
    const canonical = fromGeminiResponse(
      {
        responseId: "gem_thought_1",
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { thought: true, text: "Internal reasoning chain..." },
                { text: "FINAL: 130" },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15 },
      },
      "gemini-4-hydrogen",
    );

    expect(canonical.content).toEqual([
      { type: "thinking", thinking: "Internal reasoning chain...", provider: "gemini" },
      { type: "text", text: "FINAL: 130" },
    ]);

    const oa = formatOpenAIResponse(canonical, "gemini/gemini-4-hydrogen");
    const oaMsg = (oa.choices as Array<{ message: { content: string } }>)[0].message;
    expect(oaMsg.content).toBe("FINAL: 130");
  });

  it("emits valid Anthropic SSE lifecycle and OpenAI SSE chunks from CanonicalStreamEvents", async () => {
    async function* mockEvents(): AsyncGenerator<CanonicalStreamEvent> {
      yield { type: "message_start", id: "msg_1", model: "test", inputTokens: 100 };
      yield { type: "thinking_delta", thinking: "hmm", provider: "anthropic" };
      yield { type: "text_delta", text: "Hello " };
      yield { type: "tool_use_start", index: 0, id: "call_1", name: "echo" };
      yield { type: "tool_use_delta", index: 0, partialJson: '{"x":1}' };
      yield { type: "tool_use_stop", index: 0 };
      yield {
        type: "message_delta",
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 25 },
      };
      yield { type: "message_stop" };
    }

    const antStream = formatAnthropicStream(mockEvents(), "anthropic/claude-sonnet-4-6");
    const antEvents: string[] = [];
    for await (const frame of parseSseStream(antStream)) {
      antEvents.push(frame.event ?? "");
    }
    expect(antEvents).toEqual([
      "message_start",
      "content_block_start", // thinking idx 0
      "content_block_delta", // thinking_delta
      "content_block_stop",  // thinking stop
      "content_block_start", // text idx 1
      "content_block_delta", // text_delta
      "content_block_stop",  // text stop
      "content_block_start", // tool_use idx 2
      "content_block_delta", // input_json_delta
      "content_block_stop",  // tool_use stop
      "message_delta",
      "message_stop",
    ]);

    const oaStream = formatOpenAIStream(mockEvents(), "openai/gpt-4.1");
    const oaPayloads: string[] = [];
    for await (const frame of parseSseStream(oaStream)) {
      oaPayloads.push(frame.data);
    }
    expect(oaPayloads[oaPayloads.length - 1]).toBe("[DONE]");
    expect(oaPayloads.some((d) => d.includes('"finish_reason":"tool_calls"'))).toBe(true);
  });
});
