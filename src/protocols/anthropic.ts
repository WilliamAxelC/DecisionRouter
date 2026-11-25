import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStopReason,
  CanonicalStreamEvent,
  CanonicalTool,
  CanonicalToolChoice,
} from "../types/ir.js";

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function parseAnthropicSystem(system: unknown): string | undefined {
  if (typeof system === "string") {
    return system.length > 0 ? system : undefined;
  }
  if (Array.isArray(system)) {
    const parts = system
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  return undefined;
}

function parseToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c) {
          return String((c as { text: unknown }).text ?? "");
        }
        return JSON.stringify(c);
      })
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

export function parseAnthropicRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): CanonicalRequest {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages: CanonicalMessage[] = [];

  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    const role = msg.role === "assistant" ? "assistant" : "user";
    const blocks: CanonicalContentBlock[] = [];

    if (typeof msg.content === "string") {
      blocks.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (!item || typeof item !== "object") continue;
        const b = item as Record<string, unknown>;
        if (b.type === "text") {
          blocks.push({ type: "text", text: String(b.text ?? "") });
        } else if (b.type === "image" && b.source && typeof b.source === "object") {
          const src = b.source as Record<string, unknown>;
          if (src.type === "url") {
            blocks.push({
              type: "image",
              sourceType: "url",
              mediaType: String(src.media_type ?? "image/png"),
              data: String(src.url ?? ""),
            });
          } else {
            blocks.push({
              type: "image",
              sourceType: "base64",
              mediaType: String(src.media_type ?? "image/png"),
              data: String(src.data ?? ""),
            });
          }
        } else if (b.type === "tool_use") {
          blocks.push({
            type: "tool_use",
            id: String(b.id ?? `toolu_${Math.random().toString(36).slice(2, 10)}`),
            name: String(b.name ?? "unknown_tool"),
            input: (b.input as Record<string, unknown>) ?? {},
          });
        } else if (b.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            toolUseId: String(b.tool_use_id ?? ""),
            content: parseToolResultContent(b.content),
            isError: Boolean(b.is_error),
          });
        } else if (b.type === "thinking") {
          blocks.push({
            type: "thinking",
            thinking: String(b.thinking ?? ""),
            signature: b.signature ? String(b.signature) : undefined,
            provider: "anthropic",
          });
        }
      }
    }

    if (blocks.length === 0) {
      blocks.push({ type: "text", text: "" });
    }
    messages.push({ role, content: blocks });
  }

  let tools: CanonicalTool[] | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== "object") continue;
      const toolObj = t as Record<string, unknown>;
      if (!toolObj.name) continue;
      tools.push({
        name: String(toolObj.name),
        description: toolObj.description ? String(toolObj.description) : undefined,
        inputSchema:
          (toolObj.input_schema as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          },
      });
    }
  }

  let toolChoice: CanonicalToolChoice | undefined;
  if (body.tool_choice && typeof body.tool_choice === "object") {
    const tc = body.tool_choice as Record<string, unknown>;
    if (tc.type === "auto") toolChoice = { type: "auto" };
    else if (tc.type === "any") toolChoice = { type: "required" };
    else if (tc.type === "none") toolChoice = { type: "none" };
    else if (tc.type === "tool" && tc.name) {
      toolChoice = { type: "tool", name: String(tc.name) };
    }
  }

  const stopSequences = Array.isArray(body.stop_sequences)
    ? body.stop_sequences.map(String)
    : undefined;

  return {
    protocol: "anthropic",
    requestedModel: String(body.model ?? "auto"),
    system: parseAnthropicSystem(body.system),
    messages,
    tools,
    toolChoice,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : 4096,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    topP: typeof body.top_p === "number" ? body.top_p : undefined,
    stopSequences,
    stream: Boolean(body.stream),
    headers: normalizeHeaders(headers),
  };
}

export function mapStopReasonToAnthropic(
  reason: CanonicalStopReason,
): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

export function formatAnthropicResponse(
  res: CanonicalResponse,
  model: string,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  let hasToolUse = false;

  for (const block of res.content) {
    if (block.type === "thinking") {
      content.push({
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      });
    } else if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const cached = res.usage.cachedInputTokens ?? 0;

  return {
    id: res.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReasonToAnthropic(hasToolUse ? "tool_use" : res.stopReason),
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, res.usage.inputTokens - cached),
      output_tokens: res.usage.outputTokens,
      ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
    },
  };
}

export function formatAnthropicStream(
  events: AsyncIterable<CanonicalStreamEvent>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  const writeSse = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: string,
    data: Record<string, unknown>,
  ) => {
    controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let messageStarted = false;
      let nextBlockIndex = 0;
      let activeThinkingIdx: number | null = null;
      let activeTextIdx: number | null = null;
      const activeToolIndices = new Map<number, number>();
      let sawToolUse = false;
      let finalReason: CanonicalStopReason = "end_turn";
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedInputTokens = 0;

      const ensureMessageStart = (id = `msg_${Date.now()}`) => {
        if (messageStarted) return;
        messageStarted = true;
        writeSse(controller, "message_start", {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: Math.max(0, inputTokens - cachedInputTokens),
              output_tokens: 0,
              ...(cachedInputTokens > 0
                ? { cache_read_input_tokens: cachedInputTokens }
                : {}),
            },
          },
        });
      };

      const closeOpenBlocks = () => {
        if (activeThinkingIdx !== null) {
          writeSse(controller, "content_block_stop", {
            type: "content_block_stop",
            index: activeThinkingIdx,
          });
          activeThinkingIdx = null;
        }
        if (activeTextIdx !== null) {
          writeSse(controller, "content_block_stop", {
            type: "content_block_stop",
            index: activeTextIdx,
          });
          activeTextIdx = null;
        }
      };

      try {
        for await (const ev of events) {
          if (ev.type === "message_start") {
            inputTokens = ev.inputTokens ?? inputTokens;
            cachedInputTokens = ev.cachedInputTokens ?? cachedInputTokens;
            ensureMessageStart(ev.id);
          } else if (ev.type === "thinking_delta") {
            ensureMessageStart();
            if (activeTextIdx !== null) {
              writeSse(controller, "content_block_stop", {
                type: "content_block_stop",
                index: activeTextIdx,
              });
              activeTextIdx = null;
            }
            if (activeThinkingIdx === null) {
              activeThinkingIdx = nextBlockIndex++;
              writeSse(controller, "content_block_start", {
                type: "content_block_start",
                index: activeThinkingIdx,
                content_block: { type: "thinking", thinking: "" },
              });
            }
            if (ev.thinking) {
              writeSse(controller, "content_block_delta", {
                type: "content_block_delta",
                index: activeThinkingIdx,
                delta: { type: "thinking_delta", thinking: ev.thinking },
              });
            }
            if (ev.signature) {
              writeSse(controller, "content_block_delta", {
                type: "content_block_delta",
                index: activeThinkingIdx,
                delta: { type: "signature_delta", signature: ev.signature },
              });
            }
          } else if (ev.type === "text_delta") {
            ensureMessageStart();
            if (activeThinkingIdx !== null) {
              writeSse(controller, "content_block_stop", {
                type: "content_block_stop",
                index: activeThinkingIdx,
              });
              activeThinkingIdx = null;
            }
            if (activeTextIdx === null) {
              activeTextIdx = nextBlockIndex++;
              writeSse(controller, "content_block_start", {
                type: "content_block_start",
                index: activeTextIdx,
                content_block: { type: "text", text: "" },
              });
            }
            if (ev.text.length > 0) {
              writeSse(controller, "content_block_delta", {
                type: "content_block_delta",
                index: activeTextIdx,
                delta: { type: "text_delta", text: ev.text },
              });
            }
          } else if (ev.type === "tool_use_start") {
            ensureMessageStart();
            closeOpenBlocks();
            sawToolUse = true;
            const outIdx = nextBlockIndex++;
            activeToolIndices.set(ev.index, outIdx);
            writeSse(controller, "content_block_start", {
              type: "content_block_start",
              index: outIdx,
              content_block: {
                type: "tool_use",
                id: ev.id,
                name: ev.name,
                input: {},
              },
            });
          } else if (ev.type === "tool_use_delta") {
            const outIdx = activeToolIndices.get(ev.index);
            if (outIdx !== undefined && ev.partialJson.length > 0) {
              writeSse(controller, "content_block_delta", {
                type: "content_block_delta",
                index: outIdx,
                delta: { type: "input_json_delta", partial_json: ev.partialJson },
              });
            }
          } else if (ev.type === "tool_use_stop") {
            const outIdx = activeToolIndices.get(ev.index);
            if (outIdx !== undefined) {
              writeSse(controller, "content_block_stop", {
                type: "content_block_stop",
                index: outIdx,
              });
              activeToolIndices.delete(ev.index);
            }
          } else if (ev.type === "message_delta") {
            finalReason = ev.stopReason;
            if (ev.usage) {
              inputTokens = ev.usage.inputTokens || inputTokens;
              outputTokens = ev.usage.outputTokens || outputTokens;
              cachedInputTokens = ev.usage.cachedInputTokens ?? cachedInputTokens;
            }
          } else if (ev.type === "error") {
            ensureMessageStart();
            writeSse(controller, "error", {
              type: "error",
              error: { type: "api_error", message: ev.message },
            });
          }
        }

        ensureMessageStart();
        closeOpenBlocks();
        for (const outIdx of activeToolIndices.values()) {
          writeSse(controller, "content_block_stop", {
            type: "content_block_stop",
            index: outIdx,
          });
        }
        activeToolIndices.clear();

        writeSse(controller, "message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: mapStopReasonToAnthropic(
              sawToolUse && finalReason === "end_turn" ? "tool_use" : finalReason,
            ),
            stop_sequence: null,
          },
          usage: {
            input_tokens: Math.max(0, inputTokens - cachedInputTokens),
            output_tokens: outputTokens,
            ...(cachedInputTokens > 0
              ? { cache_read_input_tokens: cachedInputTokens }
              : {}),
          },
        });
        writeSse(controller, "message_stop", { type: "message_stop" });
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
