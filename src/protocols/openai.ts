import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStopReason,
  CanonicalStreamEvent,
  CanonicalTool,
  CanonicalToolChoice,
  ImageBlock,
  ToolUseBlock,
} from "../types/ir.js";
import { safeJsonParse } from "./sse.js";

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function parseDataUrlOrHttp(url: string): ImageBlock {
  if (url.startsWith("data:")) {
    const commaIdx = url.indexOf(",");
    if (commaIdx !== -1) {
      const meta = url.slice(5, commaIdx);
      const data = url.slice(commaIdx + 1);
      const mediaType = meta.split(";")[0] || "image/png";
      return {
        type: "image",
        sourceType: "base64",
        mediaType,
        data,
      };
    }
  }
  return {
    type: "image",
    sourceType: "url",
    mediaType: "image/png",
    data: url,
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

export function parseOpenAIRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): CanonicalRequest {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts: string[] = [];
  const messages: CanonicalMessage[] = [];

  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    const role = String(msg.role ?? "user");

    if (role === "system" || role === "developer") {
      const sysText = extractTextContent(msg.content);
      if (sysText) systemParts.push(sysText);
      continue;
    }

    if (role === "tool") {
      const toolCallId = String(msg.tool_call_id ?? msg.id ?? "call_unknown");
      const toolName = msg.name ? String(msg.name) : undefined;
      const contentText = extractTextContent(msg.content);
      const block = {
        type: "tool_result" as const,
        toolUseId: toolCallId,
        toolName,
        content: contentText,
      };

      const prev = messages[messages.length - 1];
      if (prev && prev.role === "tool") {
        prev.content.push(block);
      } else {
        messages.push({ role: "tool", content: [block] });
      }
      continue;
    }

    const blocks: CanonicalContentBlock[] = [];
    if (typeof msg.content === "string") {
      if (msg.content.length > 0) {
        blocks.push({ type: "text", text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "text" || p.type === "input_text") {
          blocks.push({ type: "text", text: String(p.text ?? "") });
        } else if (p.type === "image_url" && p.image_url) {
          const url =
            typeof p.image_url === "string"
              ? p.image_url
              : String((p.image_url as Record<string, unknown>).url ?? "");
          if (url) blocks.push(parseDataUrlOrHttp(url));
        }
      }
    }

    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const call = tc as Record<string, unknown>;
        const fn = (call.function ?? {}) as Record<string, unknown>;
        const argsRaw =
          typeof fn.arguments === "string"
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? {});
        blocks.push({
          type: "tool_use",
          id: String(call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`),
          name: String(fn.name ?? "unknown_tool"),
          input: safeJsonParse<Record<string, unknown>>(argsRaw, {}),
        });
      }
    }

    if (blocks.length === 0) {
      blocks.push({ type: "text", text: "" });
    }

    messages.push({
      role: role === "assistant" ? "assistant" : "user",
      content: blocks,
    });
  }

  let tools: CanonicalTool[] | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== "object") continue;
      const toolObj = t as Record<string, unknown>;
      if (toolObj.type === "function" && toolObj.function && typeof toolObj.function === "object") {
        const fn = toolObj.function as Record<string, unknown>;
        tools.push({
          name: String(fn.name ?? ""),
          description: fn.description ? String(fn.description) : undefined,
          inputSchema:
            (fn.parameters as Record<string, unknown>) ?? {
              type: "object",
              properties: {},
            },
        });
      } else if (toolObj.name) {
        tools.push({
          name: String(toolObj.name),
          description: toolObj.description ? String(toolObj.description) : undefined,
          inputSchema:
            (toolObj.parameters as Record<string, unknown>) ??
            (toolObj.input_schema as Record<string, unknown>) ?? {
              type: "object",
              properties: {},
            },
        });
      }
    }
  }

  let toolChoice: CanonicalToolChoice | undefined;
  if (body.tool_choice !== undefined) {
    if (body.tool_choice === "auto") toolChoice = { type: "auto" };
    else if (body.tool_choice === "none") toolChoice = { type: "none" };
    else if (body.tool_choice === "required") toolChoice = { type: "required" };
    else if (typeof body.tool_choice === "object" && body.tool_choice !== null) {
      const tc = body.tool_choice as Record<string, unknown>;
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn?.name) toolChoice = { type: "tool", name: String(fn.name) };
    }
  }

  let responseFormat: CanonicalRequest["responseFormat"];
  if (body.response_format && typeof body.response_format === "object") {
    const rf = body.response_format as Record<string, unknown>;
    if (rf.type === "json_object") {
      responseFormat = { type: "json_object" };
    } else if (rf.type === "json_schema" && rf.json_schema && typeof rf.json_schema === "object") {
      const js = rf.json_schema as Record<string, unknown>;
      responseFormat = {
        type: "json_schema",
        jsonSchema: (js.schema as Record<string, unknown>) ?? js,
      };
    } else if (rf.type === "text") {
      responseFormat = { type: "text" };
    }
  }

  const stopRaw = body.stop;
  const stopSequences = Array.isArray(stopRaw)
    ? stopRaw.map(String)
    : typeof stopRaw === "string"
      ? [stopRaw]
      : undefined;

  const maxTokensRaw = body.max_completion_tokens ?? body.max_tokens;

  return {
    protocol: "openai",
    requestedModel: String(body.model ?? "auto"),
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
    tools,
    toolChoice,
    responseFormat,
    maxTokens: typeof maxTokensRaw === "number" ? maxTokensRaw : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    topP: typeof body.top_p === "number" ? body.top_p : undefined,
    stopSequences,
    stream: Boolean(body.stream),
    headers: normalizeHeaders(headers),
  };
}

export function mapStopReasonToOpenAI(
  reason: CanonicalStopReason,
): "stop" | "tool_calls" | "length" {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

export function formatOpenAIResponse(
  res: CanonicalResponse,
  model: string,
): Record<string, unknown> {
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const block of res.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : toolCalls.length > 0 ? null : "",
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const cached = res.usage.cachedInputTokens ?? 0;

  return {
    id: res.id || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReasonToOpenAI(
          toolCalls.length > 0 ? "tool_use" : res.stopReason,
        ),
      },
    ],
    usage: {
      prompt_tokens: res.usage.inputTokens,
      completion_tokens: res.usage.outputTokens,
      total_tokens: res.usage.inputTokens + res.usage.outputTokens,
      ...(cached > 0
        ? { prompt_tokens_details: { cached_tokens: cached } }
        : {}),
    },
  };
}

export function formatOpenAIStream(
  events: AsyncIterable<CanonicalStreamEvent>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let id = `chatcmpl_${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      let sentRole = false;
      let sawToolUse = false;
      let toolIndexCounter = 0;
      const toolIdxMap = new Map<number, number>();
      let finalReason: CanonicalStopReason = "end_turn";
      let finalUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined;

      const sendChunk = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        for await (const ev of events) {
          if (ev.type === "message_start") {
            id = ev.id || id;
            sendChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "" },
                  finish_reason: null,
                },
              ],
            });
            sentRole = true;
          } else if (ev.type === "text_delta") {
            if (!sentRole) {
              sendChunk({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              });
              sentRole = true;
            }
            if (ev.text.length > 0) {
              sendChunk({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }],
              });
            }
          } else if (ev.type === "tool_use_start") {
            if (!sentRole) {
              sendChunk({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              });
              sentRole = true;
            }
            sawToolUse = true;
            const outIdx = toolIndexCounter++;
            toolIdxMap.set(ev.index, outIdx);
            sendChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: outIdx,
                        id: ev.id,
                        type: "function",
                        function: { name: ev.name, arguments: "" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            });
          } else if (ev.type === "tool_use_delta") {
            const outIdx = toolIdxMap.get(ev.index) ?? 0;
            sendChunk({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: outIdx,
                        function: { arguments: ev.partialJson },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            });
          } else if (ev.type === "message_delta") {
            finalReason = ev.stopReason;
            if (ev.usage) finalUsage = ev.usage;
          } else if (ev.type === "error") {
            sendChunk({
              error: { message: ev.message, type: "upstream_error" },
            });
          }
        }

        sendChunk({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: mapStopReasonToOpenAI(
                sawToolUse && finalReason === "end_turn" ? "tool_use" : finalReason,
              ),
            },
          ],
          ...(finalUsage
            ? {
                usage: {
                  prompt_tokens: finalUsage.inputTokens,
                  completion_tokens: finalUsage.outputTokens,
                  total_tokens: finalUsage.inputTokens + finalUsage.outputTokens,
                  ...(finalUsage.cachedInputTokens
                    ? {
                        prompt_tokens_details: {
                          cached_tokens: finalUsage.cachedInputTokens,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        });

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

export function extractToolCallsFromBlocks(blocks: CanonicalContentBlock[]): ToolUseBlock[] {
  return blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
}
