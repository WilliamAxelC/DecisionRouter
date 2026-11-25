import type { ProviderConfig } from "../config/schema.js";
import { parseSseStream, safeJsonParse } from "../protocols/sse.js";
import type {
  CanonicalContentBlock,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStopReason,
  CanonicalStreamEvent,
} from "../types/ir.js";
import {
  isRetryableStatus,
  joinUrl,
  UpstreamError,
  type UpstreamAdapter,
  type UpstreamResult,
} from "./base.js";

function mapStopReasonFromAnthropic(reason: unknown): CanonicalStopReason {
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

export function toAnthropicRequestBody(
  req: CanonicalRequest,
  model: string,
): Record<string, unknown> {
  const rawMsgs: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = [];

  for (const msg of req.messages) {
    const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
    const blocks: Array<Record<string, unknown>> = [];

    for (const b of msg.content) {
      if (b.type === "thinking") {
        // Only preserve thinking blocks that originated from Anthropic
        if (b.provider === "anthropic") {
          blocks.push({
            type: "thinking",
            thinking: b.thinking,
            ...(b.signature ? { signature: b.signature } : {}),
          });
        }
      } else if (b.type === "text") {
        blocks.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        if (b.sourceType === "url") {
          blocks.push({
            type: "image",
            source: { type: "url", url: b.data },
          });
        } else {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: b.mediaType,
              data: b.data,
            },
          });
        }
      } else if (b.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input ?? {},
        });
      } else if (b.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: b.toolUseId,
          content: b.content,
          ...(b.isError ? { is_error: true } : {}),
        });
      }
    }

    if (blocks.length === 0) continue;

    // Anthropic requires alternating user/assistant messages; merge adjacent same-role turns
    const prev = rawMsgs[rawMsgs.length - 1];
    if (prev && prev.role === role) {
      prev.content.push(...blocks);
    } else {
      rawMsgs.push({ role, content: blocks });
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages: rawMsgs,
    max_tokens: req.maxTokens ?? 4096,
    stream: req.stream,
  };

  if (req.systemBlocks && req.systemBlocks.length > 0) {
    body.system = req.systemBlocks.map((b) => ({
      type: "text",
      text: b.text,
      ...(b.cacheControl ? { cache_control: b.cacheControl } : {}),
    }));
  } else if (req.system) {
    body.system = req.system;
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stopSequences && req.stopSequences.length > 0) {
    body.stop_sequences = req.stopSequences;
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.inputSchema,
    }));
  }

  if (req.toolChoice) {
    if (req.toolChoice.type === "auto") body.tool_choice = { type: "auto" };
    else if (req.toolChoice.type === "required") body.tool_choice = { type: "any" };
    else if (req.toolChoice.type === "none") body.tool_choice = { type: "none" };
    else if (req.toolChoice.type === "tool") {
      body.tool_choice = { type: "tool", name: req.toolChoice.name };
    }
  }

  return body;
}

export function fromAnthropicResponse(
  json: Record<string, unknown>,
  fallbackModel: string,
): CanonicalResponse {
  const rawContent = Array.isArray(json.content) ? json.content : [];
  const content: CanonicalContentBlock[] = [];

  for (const item of rawContent) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    if (b.type === "thinking") {
      content.push({
        type: "thinking",
        thinking: String(b.thinking ?? ""),
        signature: b.signature ? String(b.signature) : undefined,
        provider: "anthropic",
      });
    } else if (b.type === "text") {
      content.push({ type: "text", text: String(b.text ?? "") });
    } else if (b.type === "tool_use") {
      content.push({
        type: "tool_use",
        id: String(b.id ?? `toolu_${Date.now()}`),
        name: String(b.name ?? "unknown_tool"),
        input: (b.input as Record<string, unknown>) ?? {},
      });
    }
  }

  const usage = (json.usage ?? {}) as Record<string, unknown>;
  const uncachedInput = Number(usage.input_tokens ?? 0);
  const cachedRead = Number(usage.cache_read_input_tokens ?? 0);

  return {
    id: String(json.id ?? `msg_${Date.now()}`),
    model: String(json.model ?? fallbackModel),
    content,
    stopReason: mapStopReasonFromAnthropic(json.stop_reason),
    usage: {
      inputTokens: uncachedInput + cachedRead,
      outputTokens: Number(usage.output_tokens ?? 0),
      cachedInputTokens: cachedRead,
    },
  };
}

async function* parseAnthropicSse(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
): AsyncGenerator<CanonicalStreamEvent> {
  const toolBlockIndices = new Set<number>();
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let stopReason: CanonicalStopReason = "end_turn";

  for await (const frame of parseSseStream(body)) {
    const payload = safeJsonParse<Record<string, unknown> | null>(frame.data, null);
    if (!payload) continue;
    const eventType = String(payload.type ?? frame.event ?? "");

    if (eventType === "message_start") {
      const msg = (payload.message ?? {}) as Record<string, unknown>;
      const usage = (msg.usage ?? {}) as Record<string, unknown>;
      cachedInputTokens = Number(usage.cache_read_input_tokens ?? 0);
      inputTokens = Number(usage.input_tokens ?? 0) + cachedInputTokens;
      yield {
        type: "message_start",
        id: String(msg.id ?? `msg_${Date.now()}`),
        model: String(msg.model ?? fallbackModel),
        inputTokens,
        cachedInputTokens,
      };
    } else if (eventType === "content_block_start") {
      const index = Number(payload.index ?? 0);
      const cb = (payload.content_block ?? {}) as Record<string, unknown>;
      if (cb.type === "tool_use") {
        toolBlockIndices.add(index);
        yield {
          type: "tool_use_start",
          index,
          id: String(cb.id ?? `toolu_${Date.now()}_${index}`),
          name: String(cb.name ?? "unknown_tool"),
        };
      }
    } else if (eventType === "content_block_delta") {
      const index = Number(payload.index ?? 0);
      const delta = (payload.delta ?? {}) as Record<string, unknown>;
      if (delta.type === "text_delta") {
        yield { type: "text_delta", text: String(delta.text ?? "") };
      } else if (delta.type === "thinking_delta") {
        yield {
          type: "thinking_delta",
          thinking: String(delta.thinking ?? ""),
          provider: "anthropic",
        };
      } else if (delta.type === "signature_delta") {
        yield {
          type: "thinking_delta",
          thinking: "",
          signature: String(delta.signature ?? ""),
          provider: "anthropic",
        };
      } else if (delta.type === "input_json_delta") {
        yield {
          type: "tool_use_delta",
          index,
          partialJson: String(delta.partial_json ?? ""),
        };
      }
    } else if (eventType === "content_block_stop") {
      const index = Number(payload.index ?? 0);
      if (toolBlockIndices.has(index)) {
        toolBlockIndices.delete(index);
        yield { type: "tool_use_stop", index };
      }
    } else if (eventType === "message_delta") {
      const delta = (payload.delta ?? {}) as Record<string, unknown>;
      if (delta.stop_reason) {
        stopReason = mapStopReasonFromAnthropic(delta.stop_reason);
      }
      const usage = (payload.usage ?? {}) as Record<string, unknown>;
      if (usage.output_tokens !== undefined) {
        outputTokens = Number(usage.output_tokens ?? 0);
      }
    } else if (eventType === "message_stop") {
      break;
    } else if (eventType === "error") {
      const errObj = (payload.error ?? {}) as Record<string, unknown>;
      yield {
        type: "error",
        message: String(errObj.message ?? "Anthropic stream error"),
      };
    }
  }

  yield {
    type: "message_delta",
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
    },
  };
  yield { type: "message_stop" };
}

export class AnthropicAdapter implements UpstreamAdapter {
  async send(
    req: CanonicalRequest,
    providerName: string,
    providerConfig: ProviderConfig,
    model: string,
  ): Promise<UpstreamResult> {
    const url = joinUrl(providerConfig.baseUrl, "/messages");
    const body = toAnthropicRequestBody(req, model);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version":
        req.headers["anthropic-version"] ?? "2023-06-01",
      ...providerConfig.headers,
    };
    if (providerConfig.apiKey) {
      headers["x-api-key"] = providerConfig.apiKey;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(providerConfig.timeoutMs),
      });
    } catch (err) {
      throw new UpstreamError({
        status: 504,
        retryable: true,
        provider: providerName,
        model,
        message: `Network/timeout error calling ${providerName}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new UpstreamError({
        status: res.status,
        retryable: isRetryableStatus(res.status),
        provider: providerName,
        model,
        message: `${providerName} (${model}) returned HTTP ${res.status}: ${errText.slice(0, 300)}`,
      });
    }

    if (req.stream) {
      if (!res.body) {
        throw new UpstreamError({
          status: 502,
          retryable: true,
          provider: providerName,
          model,
          message: `${providerName} returned empty stream body`,
        });
      }
      return {
        kind: "stream",
        stream: parseAnthropicSse(res.body, model),
      };
    }

    const json = (await res.json()) as Record<string, unknown>;
    return {
      kind: "response",
      response: fromAnthropicResponse(json, model),
    };
  }
}
