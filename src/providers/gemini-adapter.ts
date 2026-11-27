import { getProviderApiKeys } from "../config/loader.js";
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

function mapGeminiFinishReason(
  finishReason: unknown,
  hasToolCall: boolean,
): CanonicalStopReason {
  if (hasToolCall) return "tool_use";
  switch (finishReason) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "STOP":
    default:
      return "end_turn";
  }
}

const GEMINI_STRIPPED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "additionalProperties",
  "default",
  "examples",
  "title",
]);

/**
 * Recursively strips JSON Schema keywords rejected by Gemini's OpenAPI-subset
 * `functionDeclarations.parameters` validator and flattens nullable `anyOf`/`oneOf`.
 */
export function sanitizeSchemaForGemini(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object" };
  }

  const raw = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(raw)) {
    if (GEMINI_STRIPPED_SCHEMA_KEYS.has(key)) continue;

    if ((key === "anyOf" || key === "oneOf") && Array.isArray(val)) {
      const branches = val.filter(
        (b): b is Record<string, unknown> => Boolean(b && typeof b === "object"),
      );
      const nonNull = branches.filter((b) => b.type !== "null");
      const hasNull = branches.some((b) => b.type === "null");
      if (nonNull.length > 0) {
        const sanitized = sanitizeSchemaForGemini(nonNull[0]);
        Object.assign(out, sanitized);
        if (hasNull) out.nullable = true;
      }
      continue;
    }

    if (key === "properties" && val && typeof val === "object" && !Array.isArray(val)) {
      const propEntries = Object.entries(val as Record<string, unknown>);
      if (propEntries.length === 0) {
        // Gemini rejects empty properties: {} on OBJECT schemas
        continue;
      }
      const cleanedProps: Record<string, unknown> = {};
      for (const [pk, pv] of propEntries) {
        cleanedProps[pk] = sanitizeSchemaForGemini(pv);
      }
      out.properties = cleanedProps;
      continue;
    }

    if (key === "items") {
      out.items = sanitizeSchemaForGemini(val);
      continue;
    }

    out[key] = val;
  }

  if (Array.isArray(out.type)) {
    const types = (out.type as unknown[]).map(String);
    const nonNull = types.filter((t) => t !== "null");
    out.type = nonNull[0] ?? "string";
    if (types.includes("null")) out.nullable = true;
  }

  return out;
}

export function toGeminiRequestBody(
  req: CanonicalRequest,
): Record<string, unknown> {
  // Build toolUseId -> toolName map across prior assistant messages so functionResponse.name is exact
  const toolUseIdToName = new Map<string, string>();
  for (const msg of req.messages) {
    for (const b of msg.content) {
      if (b.type === "tool_use") {
        toolUseIdToName.set(b.id, b.name);
      }
    }
  }

  const contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];

  for (const msg of req.messages) {
    const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";
    const parts: Array<Record<string, unknown>> = [];

    for (const b of msg.content) {
      // Foreign thinking blocks are omitted when sending to Gemini
      if (b.type === "text") {
        parts.push({ text: b.text });
      } else if (b.type === "image") {
        if (b.sourceType === "base64") {
          parts.push({
            inlineData: {
              mimeType: b.mediaType,
              data: b.data,
            },
          });
        } else {
          parts.push({
            fileData: {
              mimeType: b.mediaType,
              fileUri: b.data,
            },
          });
        }
      } else if (b.type === "tool_use") {
        parts.push({
          functionCall: {
            name: b.name,
            args: b.input ?? {},
          },
        });
      } else if (b.type === "tool_result") {
        const fnName =
          b.toolName ?? toolUseIdToName.get(b.toolUseId) ?? "tool_result";
        parts.push({
          functionResponse: {
            name: fnName,
            response: {
              result: b.content,
              ...(b.isError ? { isError: true } : {}),
            },
          },
        });
      }
    }

    if (parts.length === 0) continue;

    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) {
      prev.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  const body: Record<string, unknown> = { contents };

  if (req.system) {
    body.systemInstruction = {
      parts: [{ text: req.system }],
    };
  }

  const generationConfig: Record<string, unknown> = {};
  if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.topP !== undefined) generationConfig.topP = req.topP;
  if (req.stopSequences && req.stopSequences.length > 0) {
    generationConfig.stopSequences = req.stopSequences;
  }
  if (req.thinkingLevel) {
    generationConfig.thinkingConfig = { thinkingLevel: req.thinkingLevel };
  }
  if (req.responseFormat) {
    if (req.responseFormat.type === "json_object") {
      generationConfig.responseMimeType = "application/json";
    } else if (req.responseFormat.type === "json_schema") {
      generationConfig.responseMimeType = "application/json";
      if (req.responseFormat.jsonSchema) {
        generationConfig.responseSchema = req.responseFormat.jsonSchema;
      }
    }
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          parameters: sanitizeSchemaForGemini(t.inputSchema),
        })),
      },
    ];
  }

  if (req.toolChoice) {
    if (req.toolChoice.type === "auto") {
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    } else if (req.toolChoice.type === "none") {
      body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    } else if (req.toolChoice.type === "required") {
      body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    } else if (req.toolChoice.type === "tool") {
      body.toolConfig = {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [req.toolChoice.name],
        },
      };
    }
  }

  return body;
}

export function fromGeminiResponse(
  json: Record<string, unknown>,
  model: string,
): CanonicalResponse {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const first = (candidates[0] ?? {}) as Record<string, unknown>;
  const contentObj = (first.content ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(contentObj.parts) ? contentObj.parts : [];

  const content: CanonicalContentBlock[] = [];
  let hasToolCall = false;
  let toolIdx = 0;

  for (const rawPart of parts) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as Record<string, unknown>;
    if (typeof part.text === "string" && part.text.length > 0) {
      if (part.thought === true) {
        content.push({
          type: "thinking",
          thinking: part.text,
          provider: "gemini",
        });
      } else {
        content.push({ type: "text", text: part.text });
      }
    } else if (part.functionCall && typeof part.functionCall === "object") {
      hasToolCall = true;
      const fc = part.functionCall as Record<string, unknown>;
      content.push({
        type: "tool_use",
        id: `call_gemini_${Date.now()}_${toolIdx++}`,
        name: String(fc.name ?? "unknown_tool"),
        input: (fc.args as Record<string, unknown>) ?? {},
      });
    }
  }

  const usage = (json.usageMetadata ?? {}) as Record<string, unknown>;

  return {
    id: String(json.responseId ?? `gem_${Date.now()}`),
    model,
    content,
    stopReason: mapGeminiFinishReason(first.finishReason, hasToolCall),
    usage: {
      inputTokens: Number(usage.promptTokenCount ?? 0),
      outputTokens: Number(usage.candidatesTokenCount ?? 0),
      cachedInputTokens: Number(usage.cachedContentTokenCount ?? 0),
    },
  };
}

async function* parseGeminiSse(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<CanonicalStreamEvent> {
  let started = false;
  let toolCounter = 0;
  let hasToolCall = false;
  let finishReason: unknown;
  let latestUsage:
    | { inputTokens: number; outputTokens: number; cachedInputTokens?: number }
    | undefined;

  for await (const frame of parseSseStream(body)) {
    if (!frame.data || frame.data === "[DONE]") continue;
    const chunk = safeJsonParse<Record<string, unknown> | null>(frame.data, null);
    if (!chunk) continue;

    if (chunk.usageMetadata && typeof chunk.usageMetadata === "object") {
      const u = chunk.usageMetadata as Record<string, unknown>;
      latestUsage = {
        inputTokens: Number(u.promptTokenCount ?? 0),
        outputTokens: Number(u.candidatesTokenCount ?? 0),
        cachedInputTokens: Number(u.cachedContentTokenCount ?? 0),
      };
    }

    if (!started) {
      started = true;
      yield {
        type: "message_start",
        id: String(chunk.responseId ?? `gem_${Date.now()}`),
        model,
        inputTokens: latestUsage?.inputTokens,
        cachedInputTokens: latestUsage?.cachedInputTokens,
      };
    }

    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
    const first = candidates[0] as Record<string, unknown> | undefined;
    if (!first) continue;

    if (first.finishReason) {
      finishReason = first.finishReason;
    }

    const contentObj = (first.content ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(contentObj.parts) ? contentObj.parts : [];

    for (const rawPart of parts) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      if (typeof part.text === "string" && part.text.length > 0) {
        if (part.thought === true) {
          yield {
            type: "thinking_delta",
            thinking: part.text,
            provider: "gemini",
          };
        } else {
          yield { type: "text_delta", text: part.text };
        }
      } else if (part.functionCall && typeof part.functionCall === "object") {
        hasToolCall = true;
        const fc = part.functionCall as Record<string, unknown>;
        const idx = toolCounter++;
        const id = `call_gemini_${Date.now()}_${idx}`;
        yield {
          type: "tool_use_start",
          index: idx,
          id,
          name: String(fc.name ?? "unknown_tool"),
        };
        yield {
          type: "tool_use_delta",
          index: idx,
          partialJson: JSON.stringify(fc.args ?? {}),
        };
        yield { type: "tool_use_stop", index: idx };
      }
    }
  }

  yield {
    type: "message_delta",
    stopReason: mapGeminiFinishReason(finishReason, hasToolCall),
    usage: latestUsage,
  };
  yield { type: "message_stop" };
}

interface ProviderKeyPoolState {
  disabledKeyIndices: Set<number>;
  cooldownUntilByKeyModel: Map<string, number>;
  cursor: number;
}

function isGeminiAuthError(status: number, bodyText: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status === 400) {
    return /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(bodyText);
  }
  return false;
}

export class GeminiAdapter implements UpstreamAdapter {
  private readonly pools = new Map<string, ProviderKeyPoolState>();

  private getPool(providerName: string): ProviderKeyPoolState {
    let p = this.pools.get(providerName);
    if (!p) {
      p = {
        disabledKeyIndices: new Set<number>(),
        cooldownUntilByKeyModel: new Map<string, number>(),
        cursor: 0,
      };
      this.pools.set(providerName, p);
    }
    return p;
  }

  async send(
    req: CanonicalRequest,
    providerName: string,
    providerConfig: ProviderConfig,
    model: string,
  ): Promise<UpstreamResult> {
    const endpoint = req.stream
      ? `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
      : `/models/${encodeURIComponent(model)}:generateContent`;
    const url = joinUrl(providerConfig.baseUrl, endpoint);
    const body = toGeminiRequestBody(req);

    const keys = getProviderApiKeys(providerConfig);
    const keySlots = keys.length > 0 ? keys : [""];
    const pool = this.getPool(providerName);
    const nowMs = Date.now();

    // Order candidate key indices round-robin starting at pool.cursor, skipping disabled/cooled-down keys
    const activeIndices: number[] = [];
    for (let offset = 0; offset < keySlots.length; offset++) {
      const idx = (pool.cursor + offset) % keySlots.length;
      if (pool.disabledKeyIndices.has(idx)) continue;
      const coolUntil = pool.cooldownUntilByKeyModel.get(`${idx}:${model}`) ?? 0;
      if (coolUntil > nowMs) continue;
      activeIndices.push(idx);
    }

    if (pool.disabledKeyIndices.size >= keySlots.length) {
      throw new UpstreamError({
        status: 401,
        retryable: false,
        provider: providerName,
        model,
        message: `${providerName} (${model}): all ${keySlots.length} configured API key(s) failed authentication and were quarantined`,
      });
    }

    if (activeIndices.length === 0) {
      throw new UpstreamError({
        status: 429,
        retryable: true,
        provider: providerName,
        model,
        message: `${providerName} (${model}): all healthy API keys are temporarily in 429 cooldown`,
      });
    }

    let lastError: UpstreamError | undefined;
    let transient503Count = 0;

    for (let attemptPos = 0; attemptPos < activeIndices.length; attemptPos++) {
      const keyIdx = activeIndices[attemptPos];
      const apiKey = keySlots[keyIdx];
      pool.cursor = (keyIdx + 1) % keySlots.length;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...providerConfig.headers,
      };
      if (apiKey) {
        headers["x-goog-api-key"] = apiKey;
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
        lastError = new UpstreamError({
          status: 504,
          retryable: true,
          provider: providerName,
          model,
          message: `Network/timeout error calling ${providerName}: ${err instanceof Error ? err.message : String(err)}`,
        });
        transient503Count += 1;
        if (transient503Count >= 2) break;
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (isGeminiAuthError(res.status, errText)) {
          if (!pool.disabledKeyIndices.has(keyIdx)) {
            pool.disabledKeyIndices.add(keyIdx);
            console.warn(
              `[DecisionRouter] Provider ${providerName} key #${keyIdx + 1} quarantined after HTTP ${res.status} auth error`,
            );
          }
          lastError = new UpstreamError({
            status: res.status,
            retryable: false,
            provider: providerName,
            model,
            message: `${providerName} (${model}) returned HTTP ${res.status}: ${errText.slice(0, 300)}`,
          });
          continue;
        }

        if (res.status === 429) {
          if (keySlots.length > 1) {
            const retryHdr = res.headers.get("retry-after");
            const coolMs =
              retryHdr !== null && Number.isFinite(Number(retryHdr))
                ? Math.max(0, Number(retryHdr) * 1000)
                : 60_000;
            if (coolMs > 0) {
              pool.cooldownUntilByKeyModel.set(`${keyIdx}:${model}`, Date.now() + coolMs);
            }
          }
          lastError = new UpstreamError({
            status: 429,
            retryable: true,
            provider: providerName,
            model,
            message: `${providerName} (${model}) returned HTTP 429: ${errText.slice(0, 300)}`,
          });
          continue;
        }

        const retryable = isRetryableStatus(res.status);
        lastError = new UpstreamError({
          status: res.status,
          retryable,
          provider: providerName,
          model,
          message: `${providerName} (${model}) returned HTTP ${res.status}: ${errText.slice(0, 300)}`,
        });
        if (!retryable) throw lastError;

        // On model-wide 5xx (e.g. 503 high demand), try at most 1 alternate key instead of spamming all keys
        transient503Count += 1;
        if (transient503Count >= 2) break;
        continue;
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
          stream: parseGeminiSse(res.body, model),
        };
      }

      const json = (await res.json()) as Record<string, unknown>;
      return {
        kind: "response",
        response: fromGeminiResponse(json, model),
      };
    }

    if (pool.disabledKeyIndices.size >= keySlots.length && lastError) {
      throw new UpstreamError({
        status: lastError.status,
        retryable: false,
        provider: providerName,
        model,
        message: lastError.message,
      });
    }

    throw (
      lastError ??
      new UpstreamError({
        status: 502,
        retryable: true,
        provider: providerName,
        model,
        message: `${providerName} (${model}) failed across active API key pool`,
      })
    );
  }
}
