import type { DecisionModelConfig } from "../config/schema.js";
import { joinUrl } from "../providers/base.js";
import type { RoutingTier, SpecialistKind } from "../types/ir.js";
import type { RequestFeatures } from "./features.js";

export interface ClassifierDecision {
  tier: RoutingTier;
  specialist?: SpecialistKind;
  confidence: number;
  reason: string;
  classifierModel: string;
  directAnswer?: string;
}

export interface QuotaBucketStatus {
  model: string;
  keyIndex: number;
  rpmUsed: number;
  rpmLimit: number;
  rpdUsed: number;
  rpdLimit: number;
  cooldownUntilMs: number | null;
  disabled: boolean;
}

interface BucketUsage {
  minuteTimestamps: number[];
  dayKey: string;
  dayCount: number;
  cooldownUntilMs: number | null;
}

const VALID_TIERS = new Set<RoutingTier>([
  "self",
  "trivial",
  "standard",
  "complex",
  "frontier",
  "specialist",
]);

const VALID_SPECIALISTS = new Set<SpecialistKind>([
  "vision",
  "long_context",
  "coding",
  "reasoning",
]);

const BASE_CLASSIFIER_SYSTEM_PROMPT = `You are a fast LLM routing classifier. Pick the cheapest capability tier that will reliably succeed for this single request step.
Tiers:
- "trivial": greetings, simple formatting, short boilerplate, single-line lookups, basic summarization.
- "standard": normal Q&A, straightforward coding edits, single-file helper functions, routine tool calls.
- "complex": multi-file architecture/refactors, subtle debugging, concurrency/stateful logic, careful analysis.
- "frontier": high-stakes system design, deep multi-step planning, hardest bugs, ambiguous critical tasks.
- "specialist": only when a dedicated specialist clearly fits (vision, long_context, coding, reasoning).
Keep "reason" under 80 characters.`;

const SELF_ANSWER_ADDENDUM = `
- "self": ONLY for pure decision, classification, triage, yes/no, label-picking, or tiny deterministic extraction tasks that need NO tools, NO multi-step reasoning, and NO long generation. When choosing "self", you MUST populate "directAnswer" with the exact final answer matching any requested output format.`;

function isAuthErrorResponse(status: number, bodyText: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status === 400) {
    return /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(bodyText);
  }
  return false;
}

export interface DiscreteChoiceQuestion {
  instructions: string;
  options: string[];
  useFinalPrefix: boolean;
}

/**
 * Extracts an explicit finite uppercase discrete choice set (2-20 options) from
 * classification/triage prompts so `gemini-decision-1` can answer inline via `choice`.
 * Returns null for open-ended JSON, code, or math prompts.
 */
export function extractDiscreteChoiceQuestion(
  prompt: string,
): DiscreteChoiceQuestion | null {
  if (!prompt || /return\s+only\s+json|```/i.test(prompt)) {
    return null;
  }

  const useFinalPrefix = /FINAL:/i.test(prompt);
  const stripped = prompt.replace(/End with ONLY FINAL:[^\n\r]*/i, "").trim();

  const parseOptionTokens = (raw: string): string[] => {
    const cleaned = raw
      .replace(/\s+or\s+/gi, ",")
      .replace(/\s*\/\s*/g, ",");
    const parts = cleaned
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2 || parts.length > 20) return [];
    const valid = parts.every((p) => /^[A-Z][A-Z0-9_-]{0,23}$/.test(p));
    if (!valid) return [];
    return [...new Set(parts)];
  };

  for (const m of stripped.matchAll(/\(([^()]{3,160})\)/g)) {
    const opts = parseOptionTokens(m[1]);
    if (opts.length >= 2) {
      return {
        instructions: stripped.slice(0, 400),
        options: opts,
        useFinalPrefix,
      };
    }
  }

  const inlineMatch = stripped.match(
    /\b(?:as|between|either)?\s*([A-Z][A-Z0-9_-]{1,23}(?:\s*,\s*[A-Z][A-Z0-9_-]{1,23})*(?:\s*,?\s*or\s+[A-Z][A-Z0-9_-]{1,23}))\b/,
  );
  if (inlineMatch) {
    const opts = parseOptionTokens(inlineMatch[1]);
    if (opts.length >= 2) {
      return {
        instructions: stripped.slice(0, 400),
        options: opts,
        useFinalPrefix,
      };
    }
  }

  return null;
}

export class GeminiDecisionClassifier {
  private readonly buckets = new Map<string, BucketUsage>();
  private readonly disabledKeyIndices = new Set<number>();

  private utcDayKey(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
  }

  private getBucket(model: string, keyIndex: number, nowMs: number): BucketUsage {
    const k = `${keyIndex}:${model}`;
    const today = this.utcDayKey(nowMs);
    let b = this.buckets.get(k);
    if (!b) {
      b = { minuteTimestamps: [], dayKey: today, dayCount: 0, cooldownUntilMs: null };
      this.buckets.set(k, b);
    }
    if (b.dayKey !== today) {
      b.dayKey = today;
      b.dayCount = 0;
    }
    const cutoff = nowMs - 60_000;
    b.minuteTimestamps = b.minuteTimestamps.filter((ts) => ts > cutoff);
    if (b.cooldownUntilMs !== null && nowMs >= b.cooldownUntilMs) {
      b.cooldownUntilMs = null;
    }
    return b;
  }

  private canUseBucket(
    bucket: BucketUsage,
    keyIndex: number,
    rpmLimit: number,
    rpdLimit: number,
  ): boolean {
    if (this.disabledKeyIndices.has(keyIndex)) return false;
    if (bucket.cooldownUntilMs !== null) return false;
    if (bucket.minuteTimestamps.length >= rpmLimit) return false;
    if (bucket.dayCount >= rpdLimit) return false;
    return true;
  }

  private quarantineKey(keyIndex: number, status: number): void {
    if (!this.disabledKeyIndices.has(keyIndex)) {
      this.disabledKeyIndices.add(keyIndex);
      console.warn(
        `[DecisionRouter] Decision key #${keyIndex + 1} quarantined after HTTP ${status} auth error`,
      );
    }
  }

  getQuotaStatus(config: DecisionModelConfig, nowMs = Date.now()): QuotaBucketStatus[] {
    const out: QuotaBucketStatus[] = [];
    const keysCount = Math.max(1, config.apiKeys.length);
    for (const m of config.models) {
      for (let keyIndex = 0; keyIndex < keysCount; keyIndex++) {
        const b = this.getBucket(m.id, keyIndex, nowMs);
        out.push({
          model: m.id,
          keyIndex,
          rpmUsed: b.minuteTimestamps.length,
          rpmLimit: m.rpm,
          rpdUsed: b.dayCount,
          rpdLimit: m.rpd,
          cooldownUntilMs: b.cooldownUntilMs,
          disabled: this.disabledKeyIndices.has(keyIndex),
        });
      }
    }
    return out;
  }

  private async classifyViaDecisionsApi(
    modelEntry: DecisionModelConfig["models"][number],
    apiKey: string,
    keyIdx: number,
    features: RequestFeatures,
    profileName: string,
    config: DecisionModelConfig,
    allowSelfAnswer: boolean,
    bucket: BucketUsage,
  ): Promise<ClassifierDecision | null> {
    const sourcePrompt = features.lastUserText || features.trimmedRecentTurn;
    const discreteChoice = allowSelfAnswer
      ? extractDiscreteChoiceQuestion(sourcePrompt)
      : null;

    const routeCriteria: Record<string, string> = {
      ...(discreteChoice
        ? {
            self: "Pure classification, sentiment, triage, yes/no, or discrete label selection among the explicit options, requiring zero multi-step reasoning or free-form generation.",
          }
        : {}),
      trivial:
        "Very simple formatting, greeting, lookup, single-step conversion, or short factual prompt.",
      standard:
        "Moderate coding edit, SQL query, routine Q&A, or straightforward multi-step calculation.",
      complex:
        "Hard multi-step reasoning, subtle debugging, concurrency, database deadlocks, logic puzzles, or architecture.",
      frontier:
        "Highest-stakes distributed consensus, security threat modeling, or deep system architecture.",
    };

    const questions: Record<string, unknown> = {
      route: {
        type: "choice",
        instructions:
          "Select the lowest capability tier that will reliably produce an accurate answer for this request.",
        criteria: routeCriteria,
      },
    };

    if (discreteChoice) {
      const choiceCriteria: Record<string, string> = {};
      for (const opt of discreteChoice.options) {
        choiceCriteria[opt] = `Select ${opt} if ${opt} is the correct answer.`;
      }
      questions.self_answer = {
        type: "choice",
        instructions: discreteChoice.instructions,
        criteria: choiceCriteria,
      };
    }

    const inputText = [
      `profile=${profileName} tokens=${features.estimatedTotalTokens} tools=${features.toolCount} images=${features.hasImages} toolLoop=${features.isToolLoopContinuation}`,
      features.trimmedRecentTurn,
    ].join("\n");

    const url = joinUrl(config.baseUrl, "/decisions");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model: `models/${modelEntry.id}`,
        input: inputText,
        questions,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (isAuthErrorResponse(res.status, errBody)) {
        this.quarantineKey(keyIdx, res.status);
      } else if (res.status === 429 || res.status >= 500) {
        bucket.cooldownUntilMs = Date.now() + 60_000;
      }
      return null;
    }

    const json = (await res.json()) as {
      answers?: {
        route?: { choice?: string; confidence?: number };
        self_answer?: { choice?: string; confidence?: number };
      };
    };

    const routeAns = json.answers?.route;
    if (!routeAns?.choice) return null;

    let chosenTier = routeAns.choice.toLowerCase() as RoutingTier;
    if (!VALID_TIERS.has(chosenTier)) return null;

    const routeConf = Math.min(1, Math.max(0, Number(routeAns.confidence ?? 0.8)));

    if (chosenTier === "self") {
      const selfAns = json.answers?.self_answer;
      const selfConf = Number(selfAns?.confidence ?? 0);
      if (discreteChoice && selfAns?.choice && selfConf >= 0.5) {
        const formatted = discreteChoice.useFinalPrefix
          ? `FINAL: ${selfAns.choice}`
          : selfAns.choice;
        return {
          tier: "self",
          confidence: routeConf,
          reason: `self (${Math.round(routeConf * 100)}%, ans=${selfAns.choice}@${Math.round(selfConf * 100)}%)`,
          classifierModel: modelEntry.id,
          directAnswer: formatted,
        };
      }
      chosenTier = "trivial";
    }

    return {
      tier: chosenTier,
      confidence: routeConf,
      reason: `${chosenTier} (${Math.round(routeConf * 100)}%)`,
      classifierModel: modelEntry.id,
    };
  }

  async classify(
    features: RequestFeatures,
    profileName: string,
    config: DecisionModelConfig,
    opts?: { allowSelfAnswer?: boolean },
  ): Promise<ClassifierDecision | null> {
    if (config.apiKeys.length === 0 || config.models.length === 0) {
      return null;
    }

    const allowSelfAnswer = Boolean(opts?.allowSelfAnswer);

    const compactInput = JSON.stringify({
      profile: profileName,
      estimatedTotalTokens: features.estimatedTotalTokens,
      estimatedLastTurnTokens: features.estimatedLastTurnTokens,
      messageCount: features.messageCount,
      hasImages: features.hasImages,
      toolCount: features.toolCount,
      toolNames: features.toolNames.slice(0, 12),
      isToolLoopContinuation: features.isToolLoopContinuation,
      recentTurn: features.trimmedRecentTurn,
    });

    const tierEnum = allowSelfAnswer
      ? ["self", "trivial", "standard", "complex", "frontier", "specialist"]
      : ["trivial", "standard", "complex", "frontier", "specialist"];

    const schemaProperties: Record<string, unknown> = {
      tier: {
        type: "STRING",
        enum: tierEnum,
      },
      specialist: {
        type: "STRING",
        enum: ["vision", "long_context", "coding", "reasoning"],
      },
      confidence: { type: "NUMBER" },
      reason: { type: "STRING" },
    };

    if (allowSelfAnswer) {
      schemaProperties.directAnswer = { type: "STRING" };
    }

    const requestBody = {
      systemInstruction: {
        parts: [
          {
            text: allowSelfAnswer
              ? `${BASE_CLASSIFIER_SYSTEM_PROMPT}${SELF_ANSWER_ADDENDUM}`
              : BASE_CLASSIFIER_SYSTEM_PROMPT,
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: compactInput }],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: allowSelfAnswer ? 256 : 120,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: schemaProperties,
          required: ["tier", "confidence", "reason"],
        },
      },
    };

    const nowMs = Date.now();

    for (const modelEntry of config.models) {
      const apiMode =
        modelEntry.api ??
        (modelEntry.id.includes("decision") ? "decisions" : "generateContent");

      for (let keyIdx = 0; keyIdx < config.apiKeys.length; keyIdx++) {
        const apiKey = config.apiKeys[keyIdx];
        if (!apiKey) continue;

        const bucket = this.getBucket(modelEntry.id, keyIdx, nowMs);
        if (!this.canUseBucket(bucket, keyIdx, modelEntry.rpm, modelEntry.rpd)) {
          continue;
        }

        bucket.minuteTimestamps.push(nowMs);
        bucket.dayCount += 1;

        try {
          if (apiMode === "decisions") {
            const dec = await this.classifyViaDecisionsApi(
              modelEntry,
              apiKey,
              keyIdx,
              features,
              profileName,
              config,
              allowSelfAnswer,
              bucket,
            );
            if (dec) return dec;
            continue;
          }

          const url = joinUrl(
            config.baseUrl,
            `/models/${encodeURIComponent(modelEntry.id)}:generateContent`,
          );

          const res = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(config.timeoutMs),
          });

          if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            if (isAuthErrorResponse(res.status, errBody)) {
              this.quarantineKey(keyIdx, res.status);
            } else if (res.status === 429 || res.status >= 500) {
              bucket.cooldownUntilMs = Date.now() + 60_000;
            }
            continue;
          }

          const json = (await res.json()) as Record<string, unknown>;
          const candidates = Array.isArray(json.candidates) ? json.candidates : [];
          const first = (candidates[0] ?? {}) as Record<string, unknown>;
          const content = (first.content ?? {}) as Record<string, unknown>;
          const parts = Array.isArray(content.parts) ? content.parts : [];
          const text = parts
            .map((p) =>
              p && typeof p === "object" && "text" in p
                ? String((p as { text: unknown }).text ?? "")
                : "",
            )
            .join("")
            .trim();

          if (!text) continue;
          const parsed = JSON.parse(text) as Record<string, unknown>;
          let rawTier = String(parsed.tier ?? "").toLowerCase() as RoutingTier;
          if (!VALID_TIERS.has(rawTier)) continue;

          let directAnswer: string | undefined;
          if (rawTier === "self") {
            const candidateAns =
              typeof parsed.directAnswer === "string"
                ? parsed.directAnswer.trim()
                : "";
            if (!allowSelfAnswer || candidateAns.length === 0) {
              rawTier = "trivial";
            } else {
              directAnswer = candidateAns;
            }
          }

          const rawSpec = parsed.specialist
            ? (String(parsed.specialist).toLowerCase() as SpecialistKind)
            : undefined;
          const specialist =
            rawTier === "specialist" && rawSpec && VALID_SPECIALISTS.has(rawSpec)
              ? rawSpec
              : undefined;

          if (rawTier === "specialist" && !specialist) {
            return {
              tier: "complex",
              confidence: Number(parsed.confidence ?? 0.7),
              reason: String(parsed.reason ?? "gemini specialist fallback"),
              classifierModel: modelEntry.id,
            };
          }

          return {
            tier: rawTier,
            specialist,
            confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.8))),
            reason: String(parsed.reason ?? "gemini classifier"),
            classifierModel: modelEntry.id,
            ...(directAnswer !== undefined ? { directAnswer } : {}),
          };
        } catch {
          continue;
        }
      }
    }

    return null;
  }
}
