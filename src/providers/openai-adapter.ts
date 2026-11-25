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

function mapStopReasonFromOpenAI(reason: unknown): CanonicalStopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    default:
      return "end_turn";
  }
}

export function toOpenAIRequestBody(
  req: CanonicalRequest,
  model: string,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  if (req.system) {
    messages.push({ role: "system", content: req.system });
  }

  for (const msg of req.messages) {
    // Handle tool_result blocks (could be in role === "tool" or inside role === "user" from Anthropic)
    const toolResults = msg.content.filter((b) => b.type === "tool_result");
    const nonToolResults = msg.content.filter((b) => b.type !== "tool_result");

    for (const tr of toolResults) {
      if (tr.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: tr.toolUseId,
          content: tr.content,
        });
      }
    }

    if (msg.role === "tool" && nonToolResults.length === 0) {
      continue;
    }

    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];

      for (const b of nonToolResults) {
        // Foreign thinking blocks are intentionally stripped when targeting OpenAI
        if (b.type === "text") {
          textParts.push(b.text);
        } else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input ?? {}),
            },
          });
        }
      }

      if (textParts.length > 0 || toolCalls.length > 0) {
        const out: Record<string, unknown> = {
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("") : null,
        };
        if (toolCalls.length > 0) {
          out.tool_calls = toolCalls;
        }
        messages.push(out);
      }
      continue;
    }

    if (nonToolResults.length === 0) continue;

    const hasImage = nonToolResults.some((b) => b.type === "image");
    if (!hasImage) {
      const text = nonToolResults
        .filter((b): b is Extract<CanonicalContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      messages.push({ role: "user", content: text });
    } else {
      const parts: Array<Record<string, unknown>> = [];
      for (const b of nonToolResults) {
        if (b.type === "text") {
          parts.push({ type: "text", text: b.text });
        } else if (b.type === "image") {
          const url =
            b.sourceType === "url"
              ? b.data
              : `data:${b.mediaType};base64,${b.data}`;
          parts.push({ type: "image_url", image_url: { url } });
        }
      }
      messages.push({ role: "user", content: parts });
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: req.stream,
  };

  if (req.stream) {
    body.stream_options = { include_usage: true };
  }
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stopSequences && req.stopSequences.length > 0) {
    body.stop = req.stopSequences;
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.inputSchema,
      },
    }));
  }

  if (req.toolChoice) {
    if (req.toolChoice.type === "auto") body.tool_choice = "auto";
    else if (req.toolChoice.type === "none") body.tool_choice = "none";
    else if (req.toolChoice.type === "required") body.tool_choice = "required";
    else if (req.toolChoice.type === "tool") {
      body.tool_choice = {
        type: "function",
        function: { name: req.toolChoice.name },
      };
    }
  }

  if (req.responseFormat) {
    if (req.responseFormat.type === "json_object") {
      body.response_format = { type: "json_object" };
    } else if (req.responseFormat.type === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "output",
          schema: req.responseFormat.jsonSchema ?? { type: "object" },
        },
      };
    }
  }

  return body;
}

export function fromOpenAIResponse(
  json: Record<string, unknown>,
  fallbackModel: string,
): CanonicalResponse {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;
  const content: CanonicalContentBlock[] = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const fn = (call.function ?? {}) as Record<string, unknown>;
      const argsStr =
        typeof fn.arguments === "string"
          ? fn.arguments
          : JSON.stringify(fn.arguments ?? {});
      content.push({
        type: "tool_use",
        id: String(call.id ?? `call_${Date.now()}`),
        name: String(fn.name ?? "unknown_tool"),
        input: safeJsonParse<Record<string, unknown>>(argsStr, {}),
      });
    }
  }

  const usage = (json.usage ?? {}) as Record<string, unknown>;
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;

  return {
    id: String(json.id ?? `chatcmpl_${Date.now()}`),
    model: String(json.model ?? fallbackModel),
    content,
    stopReason: mapStopReasonFromOpenAI(first.finish_reason),
    usage: {
      inputTokens: Number(usage.prompt_tokens ?? 0),
      outputTokens: Number(usage.completion_tokens ?? 0),
      cachedInputTokens: Number(promptDetails.cached_tokens ?? 0),
    },
  };
}

async function* parseOpenAISse(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
): AsyncGenerator<CanonicalStreamEvent> {
  let started = false;
  const startedToolIndices = new Set<number>();
  let latestUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined;
  let lastFinishReason: CanonicalStopReason = "end_turn";

  for await (const frame of parseSseStream(body)) {
    if (frame.data === "[DONE]") {
      break;
    }
    const chunk = safeJsonParse<Record<string, unknown> | null>(frame.data, null);
    if (!chunk) continue;

    if (!started) {
      started = true;
      yield {
        type: "message_start",
        id: String(chunk.id ?? `chatcmpl_${Date.now()}`),
        model: String(chunk.model ?? fallbackModel),
      };
    }

    if (chunk.usage && typeof chunk.usage === "object") {
      const u = chunk.usage as Record<string, unknown>;
      const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
      latestUsage = {
        inputTokens: Number(u.prompt_tokens ?? 0),
        outputTokens: Number(u.completion_tokens ?? 0),
        cachedInputTokens: Number(details.cached_tokens ?? 0),
      };
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    if (!choice) continue;

    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text_delta", text: delta.content };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const rawTc of delta.tool_calls) {
        if (!rawTc || typeof rawTc !== "object") continue;
        const tc = rawTc as Record<string, unknown>;
        const idx = Number(tc.index ?? 0);
        const fn = (tc.function ?? {}) as Record<string, unknown>;

        if (!startedToolIndices.has(idx)) {
          startedToolIndices.add(idx);
          yield {
            type: "tool_use_start",
            index: idx,
            id: String(tc.id ?? `call_${Date.now()}_${idx}`),
            name: String(fn.name ?? "unknown_tool"),
          };
        }
        if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
          yield {
            type: "tool_use_delta",
            index: idx,
            partialJson: fn.arguments,
          };
        }
      }
    }

    if (choice.finish_reason) {
      lastFinishReason = mapStopReasonFromOpenAI(choice.finish_reason);
    }
  }

  for (const idx of startedToolIndices) {
    yield { type: "tool_use_stop", index: idx };
  }

  yield {
    type: "message_delta",
    stopReason: lastFinishReason,
    usage: latestUsage,
  };
  yield { type: "message_stop" };
}

export class OpenAIAdapter implements UpstreamAdapter {
  async send(
    req: CanonicalRequest,
    providerName: string,
    providerConfig: ProviderConfig,
    model: string,
  ): Promise<UpstreamResult> {
    const url = joinUrl(providerConfig.baseUrl, "/chat/completions");
    const body = toOpenAIRequestBody(req, model);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...providerConfig.headers,
    };
    if (providerConfig.apiKey) {
      headers.authorization = `Bearer ${providerConfig.apiKey}`;
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
        stream: parseOpenAISse(res.body, model),
      };
    }

    const json = (await res.json()) as Record<string, unknown>;
    return {
      kind: "response",
      response: fromOpenAIResponse(json, model),
    };
  }
}
