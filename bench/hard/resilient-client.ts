import type { DatabaseSync } from "node:sqlite";
import { getModelPricing, getProviderApiKeys } from "../../src/config/loader.js";
import type { RouterConfig } from "../../src/config/schema.js";
import { parseSseStream, safeJsonParse } from "../../src/protocols/sse.js";
import { toGeminiRequestBody } from "../../src/providers/gemini-adapter.js";
import { extractFeatures } from "../../src/router/features.js";
import {
  extractDiscreteChoiceQuestion,
  type ClassifierDecision,
} from "../../src/router/gemini-classifier.js";
import type { CanonicalMessage, CanonicalRequest, RoutingTier } from "../../src/types/ir.js";
import type { HardBenchTask, HardBenchToolCall } from "./types.js";

const DIFFICULTY_LEVELS: string[] = [
  "Trivial greeting, label classification, simple lookup, or single-step formatting",
  "Simple fact, basic conversion, or straightforward single-step edit",
  "Moderate multi-step QA, reading comprehension, or simple script",
  "Hard multi-step math, code execution trace, logic puzzle, subtle bug, or tricky domain analysis",
  "Frontier system architecture, distributed consensus, security threat model, or formal proof",
];

export interface KeySlotRow {
  keyIdx: number;
  model: string;
  status: "active" | "quarantined";
  consecutiveErrors: number;
  cooldownUntilMs: number;
  lastCallMs: number;
  dayKey: string;
  dayCalls: number;
  lastError: string | null;
}

export interface BackoffInput {
  status: number;
  errorBody: string;
  prevConsecutiveErrors: number;
  nowMs: number;
  jitterMs?: number;
}

export interface BackoffTransition {
  quarantine: boolean;
  isDailyQuota: boolean;
  consecutiveErrors: number;
  cooldownUntilMs: number;
  delayMs: number;
  eventType: string;
}

export function isAuthFailure(status: number, bodyText: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status === 400) {
    return /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(bodyText);
  }
  return false;
}

export function parseRetryDelayMs(errorBody: string): number | undefined {
  const m = errorBody.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (m) {
    const sec = Number(m[1]);
    if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
  }
  const m2 = errorBody.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (m2) {
    const sec = Number(m2[1]);
    if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec * 1000);
  }
  return undefined;
}

/**
 * Pure, non-spamming exponential backoff transition for free-tier Gemini APIs.
 */
export function computeBackoffTransition(input: BackoffInput): BackoffTransition {
  const jitter =
    input.jitterMs !== undefined
      ? input.jitterMs
      : Math.floor(Math.random() * 15_000);

  if (isAuthFailure(input.status, input.errorBody)) {
    return {
      quarantine: true,
      isDailyQuota: false,
      consecutiveErrors: input.prevConsecutiveErrors + 1,
      cooldownUntilMs: input.nowMs + 365 * 86_400_000,
      delayMs: 365 * 86_400_000,
      eventType: `auth_quarantine_${input.status}`,
    };
  }

  const nextErr = input.prevConsecutiveErrors + 1;

  if (input.status === 429) {
    const isDaily =
      /PerDay|GenerateRequestsPerDay|daily|limit:\s*0\b/i.test(input.errorBody);
    if (isDaily) {
      // 15m -> 30m -> 60m (capped at 60m)
      const mins = Math.min(60, 15 * Math.pow(2, Math.min(nextErr - 1, 2)));
      const delayMs = mins * 60_000 + jitter;
      return {
        quarantine: false,
        isDailyQuota: true,
        consecutiveErrors: nextErr,
        cooldownUntilMs: input.nowMs + delayMs,
        delayMs,
        eventType: "rate_limited_429_daily",
      };
    }

    const hintMs = parseRetryDelayMs(input.errorBody) ?? 0;
    const expMs = Math.min(10 * 60_000, 65_000 * Math.pow(2, Math.min(nextErr - 1, 3)));
    const delayMs = Math.max(hintMs, expMs) + jitter;
    return {
      quarantine: false,
      isDailyQuota: false,
      consecutiveErrors: nextErr,
      cooldownUntilMs: input.nowMs + delayMs,
      delayMs,
      eventType: "rate_limited_429_rpm",
    };
  }

  // 503 / 5xx / timeout / transport error: 30s -> 60s -> 120s -> 240s -> 480s -> 600s + jitter
  const base503Ms = Math.min(600_000, 30_000 * Math.pow(2, Math.min(nextErr - 1, 5)));
  const delayMs = base503Ms + jitter;
  return {
    quarantine: false,
    isDailyQuota: false,
    consecutiveErrors: nextErr,
    cooldownUntilMs: input.nowMs + delayMs,
    delayMs,
    eventType:
      input.status === 503
        ? "transient_503"
        : input.status === 0
          ? "transient_network_timeout"
          : `transient_${input.status}`,
  };
}

export function buildCanonicalRequestForTask(
  task: HardBenchTask,
  model: string,
  stream: boolean,
): CanonicalRequest {
  const messages: CanonicalMessage[] = task.messages.map((m) => ({
    role: m.role,
    content: [{ type: "text", text: m.content }],
  }));

  return {
    protocol: "openai",
    requestedModel: model,
    system: task.systemPrompt,
    messages,
    tools: task.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })),
    maxTokens: 8192,
    temperature: 0,
    stream,
    headers: {},
  };
}

export interface LiveGenerationOutput {
  text: string;
  thinkingText: string;
  toolCalls: HardBenchToolCall[];
  finishReason: string;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  httpStatus: number;
}

export class ResilientGeminiPool {
  readonly baseUrl: string;
  readonly decisionKeys: string[];
  readonly geminiKeys: string[];
  private readonly modelGlobalCooldown = new Map<string, number>();

  constructor(
    private readonly db: DatabaseSync,
    readonly config: RouterConfig,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS key_slot_state (
        key_idx INTEGER NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        cooldown_until_ms INTEGER NOT NULL DEFAULT 0,
        last_call_ms INTEGER NOT NULL DEFAULT 0,
        day_key TEXT NOT NULL DEFAULT '',
        day_calls INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (key_idx, model)
      );
      CREATE TABLE IF NOT EXISTS api_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        model TEXT NOT NULL,
        key_idx INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        http_status INTEGER NOT NULL,
        detail TEXT NOT NULL
      );
    `);

    const dKeys = config.decisionModel.apiKeys.filter((k) => Boolean(k && k.trim()));
    const gemCfg = config.providers.gemini;
    const pKeys = gemCfg ? getProviderApiKeys(gemCfg).filter((k) => Boolean(k && k.trim())) : [];
    const union = [...new Set([...dKeys, ...pKeys])];
    this.decisionKeys = dKeys.length > 0 ? dKeys : union;
    this.geminiKeys = pKeys.length > 0 ? pKeys : union;
    this.baseUrl = gemCfg?.baseUrl ?? config.decisionModel.baseUrl;
  }

  private utcDayKey(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
  }

  private getKeysForModel(model: string): string[] {
    return model.includes("decision") ? this.decisionKeys : this.geminiKeys;
  }

  private getMinSpacingMs(model: string): number {
    if (model.includes("decision")) return 400; // <= 150 RPM per key
    return 15_500; // <= 3.87 RPM per key (safe under 5 RPM free quota)
  }

  private getDailyCapPerKey(model: string): number {
    if (model.includes("decision")) return 10_000;
    const configuredRpd = this.config.providers.gemini?.models?.[model]?.rpd ?? 20;
    const nKeys = Math.max(1, this.getKeysForModel(model).length);
    // If pooled RPD was configured (e.g. 80 across 4 keys), divide per key
    return configuredRpd > 30 ? Math.ceil(configuredRpd / nKeys) : configuredRpd;
  }

  getSlot(keyIdx: number, model: string, nowMs = Date.now()): KeySlotRow {
    const today = this.utcDayKey(nowMs);
    const row = this.db
      .prepare(`SELECT * FROM key_slot_state WHERE key_idx = ? AND model = ?`)
      .get(keyIdx, model) as Record<string, unknown> | undefined;

    if (!row) {
      const fresh: KeySlotRow = {
        keyIdx,
        model,
        status: "active",
        consecutiveErrors: 0,
        cooldownUntilMs: 0,
        lastCallMs: 0,
        dayKey: today,
        dayCalls: 0,
        lastError: null,
      };
      this.db
        .prepare(
          `INSERT OR IGNORE INTO key_slot_state (key_idx, model, status, consecutive_errors, cooldown_until_ms, last_call_ms, day_key, day_calls, last_error)
           VALUES (?, ?, 'active', 0, 0, 0, ?, 0, NULL)`,
        )
        .run(keyIdx, model, today);
      return fresh;
    }

    let dayKey = String(row.day_key ?? today);
    let dayCalls = Number(row.day_calls ?? 0);
    if (dayKey !== today) {
      dayKey = today;
      dayCalls = 0;
      this.db
        .prepare(
          `UPDATE key_slot_state SET day_key = ?, day_calls = 0, cooldown_until_ms = CASE WHEN status = 'active' THEN 0 ELSE cooldown_until_ms END WHERE key_idx = ? AND model = ?`,
        )
        .run(today, keyIdx, model);
    }

    return {
      keyIdx,
      model,
      status: String(row.status) === "quarantined" ? "quarantined" : "active",
      consecutiveErrors: Number(row.consecutive_errors ?? 0),
      cooldownUntilMs: Number(row.cooldown_until_ms ?? 0),
      lastCallMs: Number(row.last_call_ms ?? 0),
      dayKey,
      dayCalls,
      lastError: row.last_error ? String(row.last_error) : null,
    };
  }

  recordEvent(
    model: string,
    keyIdx: number,
    eventType: string,
    httpStatus: number,
    detail: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO api_events (ts_ms, model, key_idx, event_type, http_status, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), model, keyIdx, eventType, httpStatus, detail.slice(0, 320));
  }

  private getSlotReadyAtMs(slot: KeySlotRow, model: string, nowMs: number): number {
    if (slot.status === "quarantined") return Number.POSITIVE_INFINITY;

    let readyAt = Math.max(nowMs, slot.cooldownUntilMs);
    const minSpacing = this.getMinSpacingMs(model);
    if (slot.lastCallMs > 0) {
      readyAt = Math.max(readyAt, slot.lastCallMs + minSpacing);
    }

    const dailyCap = this.getDailyCapPerKey(model);
    if (slot.dayCalls >= dailyCap) {
      // Wait up to 60m or until next UTC day
      const tomorrowUtc = Date.parse(`${slot.dayKey}T00:00:00.000Z`) + 86_400_000;
      readyAt = Math.max(readyAt, Math.min(tomorrowUtc, nowMs + 60 * 60_000));
    }

    const globalCool = this.modelGlobalCooldown.get(model) ?? 0;
    if (globalCool > readyAt) {
      readyAt = globalCool;
    }
    return readyAt;
  }

  getNextReadyAtMs(model: string, nowMs = Date.now()): {
    readyAtMs: number;
    keyIdx: number;
    allQuarantined: boolean;
  } {
    const keys = this.getKeysForModel(model);
    if (keys.length === 0) {
      return { readyAtMs: Number.POSITIVE_INFINITY, keyIdx: -1, allQuarantined: true };
    }

    let bestReadyAt = Number.POSITIVE_INFINITY;
    let bestIdx = -1;
    let quarantinedCount = 0;

    for (let i = 0; i < keys.length; i++) {
      const slot = this.getSlot(i, model, nowMs);
      if (slot.status === "quarantined") {
        quarantinedCount++;
        continue;
      }
      const r = this.getSlotReadyAtMs(slot, model, nowMs);
      if (r < bestReadyAt || (r === bestReadyAt && bestIdx !== -1 && slot.lastCallMs < this.getSlot(bestIdx, model, nowMs).lastCallMs)) {
        bestReadyAt = r;
        bestIdx = i;
      }
    }

    return {
      readyAtMs: bestReadyAt,
      keyIdx: bestIdx,
      allQuarantined: quarantinedCount >= keys.length,
    };
  }

  private markCallStarted(keyIdx: number, model: string, nowMs: number): void {
    const slot = this.getSlot(keyIdx, model, nowMs);
    this.db
      .prepare(
        `UPDATE key_slot_state SET last_call_ms = ?, day_calls = ? WHERE key_idx = ? AND model = ?`,
      )
      .run(nowMs, slot.dayCalls + 1, keyIdx, model);
  }

  markSuccess(keyIdx: number, model: string, latencyMs: number): void {
    this.modelGlobalCooldown.delete(model);
    this.db
      .prepare(
        `UPDATE key_slot_state SET consecutive_errors = 0, cooldown_until_ms = 0, last_error = NULL WHERE key_idx = ? AND model = ?`,
      )
      .run(keyIdx, model);
    this.recordEvent(model, keyIdx, "success_200", 200, `ok ${Math.round(latencyMs)}ms`);
  }

  markFailure(
    keyIdx: number,
    model: string,
    status: number,
    errorBody: string,
    nowMs = Date.now(),
  ): BackoffTransition {
    const slot = this.getSlot(keyIdx, model, nowMs);
    const trans = computeBackoffTransition({
      status,
      errorBody,
      prevConsecutiveErrors: slot.consecutiveErrors,
      nowMs,
    });

    if (trans.quarantine) {
      this.db
        .prepare(
          `UPDATE key_slot_state SET status = 'quarantined', consecutive_errors = ?, cooldown_until_ms = ?, last_error = ? WHERE key_idx = ? AND model = ?`,
        )
        .run(
          trans.consecutiveErrors,
          trans.cooldownUntilMs,
          errorBody.slice(0, 240),
          keyIdx,
          model,
        );
    } else {
      this.db
        .prepare(
          `UPDATE key_slot_state SET consecutive_errors = ?, cooldown_until_ms = ?, last_error = ? WHERE key_idx = ? AND model = ?`,
        )
        .run(
          trans.consecutiveErrors,
          trans.cooldownUntilMs,
          errorBody.slice(0, 240),
          keyIdx,
          model,
        );
    }

    this.recordEvent(
      model,
      keyIdx,
      trans.eventType,
      status,
      `err#${trans.consecutiveErrors} backoff=${Math.round(trans.delayMs / 1000)}s ${errorBody.slice(0, 140).replace(/\s+/g, " ")}`,
    );

    // If all active slots for this model hit 503/5xx/network outage, share one global probe window
    if (!trans.quarantine && !trans.isDailyQuota && (status === 503 || status >= 500 || status === 0)) {
      const keys = this.getKeysForModel(model);
      let allActiveFailing = true;
      let minActiveCool = Number.POSITIVE_INFINITY;
      for (let i = 0; i < keys.length; i++) {
        const s = this.getSlot(i, model, nowMs);
        if (s.status === "quarantined") continue;
        if (s.consecutiveErrors === 0) {
          allActiveFailing = false;
          break;
        }
        minActiveCool = Math.min(minActiveCool, s.cooldownUntilMs);
      }
      if (allActiveFailing && Number.isFinite(minActiveCool) && minActiveCool > nowMs) {
        this.modelGlobalCooldown.set(model, minActiveCool);
      }
    }

    return trans;
  }

  /**
   * Calls Gemini via :streamGenerateContent?alt=sse (avoids undici headers timeout
   * while thinking) on whichever key slot is currently ready.
   */
  async callGenerateContent(
    model: string,
    task: HardBenchTask,
    timeoutMs = 180_000,
  ): Promise<
    | { ok: true; keyIdx: number; output: LiveGenerationOutput }
    | { ok: false; keyIdx: number; status: number; errorMessage: string; transition: BackoffTransition }
  > {
    const nowMs = Date.now();
    const next = this.getNextReadyAtMs(model, nowMs);
    if (next.keyIdx < 0 || next.allQuarantined) {
      return {
        ok: false,
        keyIdx: -1,
        status: 401,
        errorMessage: `All API keys quarantined for ${model}`,
        transition: computeBackoffTransition({
          status: 401,
          errorBody: "all keys quarantined",
          prevConsecutiveErrors: 0,
          nowMs,
          jitterMs: 0,
        }),
      };
    }

    const keyIdx = next.keyIdx;
    const apiKey = this.getKeysForModel(model)[keyIdx];
    const url = `${this.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const canonicalReq = buildCanonicalRequestForTask(task, model, true);
    const body = toGeminiRequestBody(canonicalReq);

    this.markCallStarted(keyIdx, model, nowMs);
    const t0 = performance.now();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => `HTTP ${res.status}`);
        const trans = this.markFailure(keyIdx, model, res.status, errBody);
        return {
          ok: false,
          keyIdx,
          status: res.status,
          errorMessage: errBody.slice(0, 220),
          transition: trans,
        };
      }

      if (!res.body) {
        const trans = this.markFailure(keyIdx, model, 502, "empty SSE response body");
        return {
          ok: false,
          keyIdx,
          status: 502,
          errorMessage: "empty SSE response body",
          transition: trans,
        };
      }

      let text = "";
      let thinkingText = "";
      const toolCalls: HardBenchToolCall[] = [];
      let finishReason = "STOP";
      let promptTokens = 0;
      let outputTokens = 0;
      let thinkingTokens = 0;

      for await (const ev of parseSseStream(res.body)) {
        if (ev.data === "[DONE]") break;
        const chunk = safeJsonParse<Record<string, unknown>>(ev.data, {});
        if (chunk.error && typeof chunk.error === "object") {
          const eObj = chunk.error as { code?: number; message?: string };
          const code = Number(eObj.code ?? 503);
          const msg = String(eObj.message ?? "stream error chunk");
          const trans = this.markFailure(keyIdx, model, code, msg);
          return {
            ok: false,
            keyIdx,
            status: code,
            errorMessage: msg,
            transition: trans,
          };
        }

        const usageMeta = chunk.usageMetadata as
          | {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              thoughtsTokenCount?: number;
            }
          | undefined;
        if (usageMeta) {
          if (typeof usageMeta.promptTokenCount === "number") {
            promptTokens = usageMeta.promptTokenCount;
          }
          if (typeof usageMeta.candidatesTokenCount === "number") {
            outputTokens = usageMeta.candidatesTokenCount;
          }
          if (typeof usageMeta.thoughtsTokenCount === "number") {
            thinkingTokens = usageMeta.thoughtsTokenCount;
          }
        }

        const cands = Array.isArray(chunk.candidates) ? chunk.candidates : [];
        const first = cands[0] as Record<string, unknown> | undefined;
        if (!first) continue;
        if (first.finishReason) finishReason = String(first.finishReason);

        const content = (first.content ?? {}) as Record<string, unknown>;
        const parts = Array.isArray(content.parts) ? content.parts : [];
        for (const rawPart of parts) {
          if (!rawPart || typeof rawPart !== "object") continue;
          const part = rawPart as Record<string, unknown>;
          if (typeof part.text === "string" && part.text.length > 0) {
            if (part.thought === true) thinkingText += part.text;
            else text += part.text;
          } else if (part.functionCall && typeof part.functionCall === "object") {
            const fc = part.functionCall as { name?: string; args?: Record<string, unknown> };
            toolCalls.push({
              name: String(fc.name ?? "unknown"),
              arguments:
                fc.args && typeof fc.args === "object" ? fc.args : {},
            });
          }
        }
      }

      const latencyMs = Number((performance.now() - t0).toFixed(2));
      this.markSuccess(keyIdx, model, latencyMs);
      return {
        ok: true,
        keyIdx,
        output: {
          text: text.trim(),
          thinkingText: thinkingText.trim(),
          toolCalls,
          finishReason,
          latencyMs,
          promptTokens,
          outputTokens,
          thinkingTokens,
          httpStatus: 200,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const trans = this.markFailure(keyIdx, model, 0, msg);
      return {
        ok: false,
        keyIdx,
        status: 0,
        errorMessage: msg,
        transition: trans,
      };
    }
  }

  /**
   * Executes live multi-probe `POST /v1beta/decisions` on `gemini-decision-1`.
   */
  async callDecisionMultiProbe(
    task: HardBenchTask,
    timeoutMs = 30_000,
  ): Promise<
    | { ok: true; keyIdx: number; decision: ClassifierDecision; latencyMs: number }
    | { ok: false; keyIdx: number; status: number; errorMessage: string; transition: BackoffTransition }
  > {
    const model =
      this.config.decisionModel.models[0]?.id ?? "gemini-decision-1";
    const nowMs = Date.now();
    const next = this.getNextReadyAtMs(model, nowMs);
    if (next.keyIdx < 0 || next.allQuarantined) {
      return {
        ok: false,
        keyIdx: -1,
        status: 401,
        errorMessage: `All decision keys quarantined`,
        transition: computeBackoffTransition({
          status: 401,
          errorBody: "all keys quarantined",
          prevConsecutiveErrors: 0,
          nowMs,
          jitterMs: 0,
        }),
      };
    }

    const keyIdx = next.keyIdx;
    const apiKey = this.getKeysForModel(model)[keyIdx];
    const canonicalReq = buildCanonicalRequestForTask(task, "auto:quality", false);
    const features = extractFeatures(
      canonicalReq,
      this.config.decisionModel.maxContextChars,
    );
    const sourcePrompt = features.lastUserText || features.trimmedRecentTurn;
    const discreteChoice =
      features.toolCount === 0 ? extractDiscreteChoiceQuestion(sourcePrompt) : null;

    const questions: Record<string, unknown> = {
      error_risk: {
        type: "noul",
        instructions:
          "Could a lightweight fast LLM make a subtle math, logic, code-execution, edge-case, or factual mistake on this request?",
      },
      needs_reasoning: {
        type: "noul",
        instructions:
          "Does answering this request accurately require multi-step math, code execution tracing, deductive logic, constraint satisfaction, or catching a subtle trap?",
      },
      difficulty: {
        type: "score",
        instructions:
          "Rate the task reasoning difficulty from level 0 (trivial) to level 4 (frontier).",
        criteria: DIFFICULTY_LEVELS,
      },
    };

    if (features.messageCount >= 3 && !features.isToolLoopContinuation) {
      questions.user_is_correcting = {
        type: "noul",
        instructions:
          "Is the latest user message correcting, pushing back on, questioning, or reporting a mistake or failure in the assistant's prior response?",
      };
    }

    if (discreteChoice) {
      const choiceCriteria: Record<string, string> = {};
      for (const opt of discreteChoice.options) {
        choiceCriteria[opt] = `Select ${opt} if ${opt} is the exact correct answer.`;
      }
      questions.self_answer = {
        type: "choice",
        instructions: discreteChoice.instructions,
        criteria: choiceCriteria,
      };
    }

    const inputText = [
      `profile=auto:quality tokens=${features.estimatedTotalTokens} tools=${features.toolCount} images=${features.hasImages} turns=${features.messageCount}`,
      features.trimmedRecentTurn,
    ].join("\n");

    const url = `${this.config.decisionModel.baseUrl.replace(/\/+$/, "")}/decisions`;
    this.markCallStarted(keyIdx, model, nowMs);
    const t0 = performance.now();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model: `models/${model}`,
          input: inputText,
          questions,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => `HTTP ${res.status}`);
        const trans = this.markFailure(keyIdx, model, res.status, errBody);
        return {
          ok: false,
          keyIdx,
          status: res.status,
          errorMessage: errBody.slice(0, 220),
          transition: trans,
        };
      }

      const json = (await res.json()) as {
        answers?: {
          error_risk?: { noul?: number };
          needs_reasoning?: { noul?: number };
          difficulty?: { score?: number };
          user_is_correcting?: { noul?: number };
          self_answer?: { choice?: string; confidence?: number };
        };
      };
      const latencyMs = Number((performance.now() - t0).toFixed(2));
      const answers = json.answers ?? {};
      const errorRisk = Number(answers.error_risk?.noul ?? 0.5);
      const needsReasoning = Number(answers.needs_reasoning?.noul ?? 0.5);
      const difficultyScore = Number(answers.difficulty?.score ?? 2.0);
      const userIsCorrecting =
        answers.user_is_correcting?.noul !== undefined
          ? Number(answers.user_is_correcting.noul)
          : undefined;
      const riskScore = Number(
        (
          0.4 * errorRisk +
          0.35 * needsReasoning +
          0.25 * Math.min(1, Math.max(0, difficultyScore / 4))
        ).toFixed(4),
      );
      const selfAns = answers.self_answer;
      const selfConf =
        selfAns?.confidence !== undefined ? Number(selfAns.confidence) : undefined;
      const directAnswer =
        discreteChoice && selfAns?.choice
          ? discreteChoice.useFinalPrefix
            ? `FINAL: ${selfAns.choice}`
            : selfAns.choice
          : undefined;

      const preliminaryTier: RoutingTier =
        riskScore >= 0.78
          ? "frontier"
          : riskScore >= 0.32
            ? "complex"
            : riskScore >= 0.18
              ? "standard"
              : "trivial";

      const decision: ClassifierDecision = {
        tier: preliminaryTier,
        confidence: Math.min(1, Math.max(0, 1 - Math.abs(riskScore - 0.5))),
        reason: `risk=${riskScore.toFixed(2)} (err=${errorRisk.toFixed(2)}, reas=${needsReasoning.toFixed(2)}, diff=${difficultyScore.toFixed(1)})`,
        classifierModel: model,
        riskScore,
        signals: {
          errorRisk,
          needsReasoning,
          difficultyScore,
          riskScore,
          ...(userIsCorrecting !== undefined ? { userIsCorrecting } : {}),
          ...(selfConf !== undefined ? { selfAnswerConfidence: selfConf } : {}),
        },
        ...(directAnswer !== undefined ? { directAnswer } : {}),
      };

      this.markSuccess(keyIdx, model, latencyMs);
      return { ok: true, keyIdx, decision, latencyMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const trans = this.markFailure(keyIdx, model, 0, msg);
      return {
        ok: false,
        keyIdx,
        status: 0,
        errorMessage: msg,
        transition: trans,
      };
    }
  }

  /**
   * Zero-output-token `noul` probe on `gemini-decision-1` used for SimpleQA/MultiChallenge grading
   * and cascade answer verification.
   */
  async callDecisionNoulJudge(
    input: string,
    instruction: string,
    timeoutMs = 25_000,
  ): Promise<number | null> {
    const model =
      this.config.decisionModel.models[0]?.id ?? "gemini-decision-1";
    const keys = this.getKeysForModel(model);
    for (let attempt = 0; attempt < Math.min(3, keys.length + 1); attempt++) {
      const nowMs = Date.now();
      const next = this.getNextReadyAtMs(model, nowMs);
      if (next.keyIdx < 0 || next.allQuarantined) return null;
      if (next.readyAtMs > nowMs) {
        const waitMs = next.readyAtMs - nowMs;
        if (waitMs > 5000) return null;
        await new Promise((r) => setTimeout(r, waitMs));
      }
      const keyIdx = next.keyIdx;
      const apiKey = keys[keyIdx];
      this.markCallStarted(keyIdx, model, Date.now());

      const url = `${this.config.decisionModel.baseUrl.replace(/\/+$/, "")}/decisions`;
      const t0 = performance.now();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            model: `models/${model}`,
            input: input.slice(0, 4000),
            questions: {
              verdict: {
                type: "noul",
                instructions: instruction,
              },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => `HTTP ${res.status}`);
          this.markFailure(keyIdx, model, res.status, errBody);
          continue;
        }
        const json = (await res.json()) as {
          answers?: { verdict?: { noul?: number } };
        };
        const p = json.answers?.verdict?.noul;
        if (typeof p === "number") {
          this.markSuccess(keyIdx, model, performance.now() - t0);
          return p;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.markFailure(keyIdx, model, 0, msg);
      }
    }
    return null;
  }

  estimateGeminiCostUsd(
    model: string,
    promptTokens: number,
    outputAndThinkingTokens: number,
  ): number {
    const p = getModelPricing(this.config, "gemini", model);
    return Number(
      (
        (promptTokens * p.inputPer1M + outputAndThinkingTokens * p.outputPer1M) /
        1_000_000
      ).toFixed(8),
    );
  }

  getApiTelemetrySummary(): Array<{
    model: string;
    totalEvents: number;
    ok200: number;
    err429: number;
    err503: number;
    otherErrors: number;
    quarantinedKeys: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT model,
          COUNT(*) AS total_events,
          SUM(CASE WHEN http_status = 200 THEN 1 ELSE 0 END) AS ok_200,
          SUM(CASE WHEN http_status = 429 THEN 1 ELSE 0 END) AS err_429,
          SUM(CASE WHEN http_status = 503 THEN 1 ELSE 0 END) AS err_503,
          SUM(CASE WHEN http_status NOT IN (200, 429, 503) THEN 1 ELSE 0 END) AS other_errs
         FROM api_events
         GROUP BY model
         ORDER BY model ASC`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const model = String(r.model);
      const qRow = this.db
        .prepare(
          `SELECT COUNT(*) AS qcnt FROM key_slot_state WHERE model = ? AND status = 'quarantined'`,
        )
        .get(model) as { qcnt?: number } | undefined;
      return {
        model,
        totalEvents: Number(r.total_events ?? 0),
        ok200: Number(r.ok_200 ?? 0),
        err429: Number(r.err_429 ?? 0),
        err503: Number(r.err_503 ?? 0),
        otherErrors: Number(r.other_errs ?? 0),
        quarantinedKeys: Number(qRow?.qcnt ?? 0),
      };
    });
  }
}
