import type { CanonicalRequest, CanonicalResponse } from "../types/ir.js";

export interface CascadeCheckResult {
  ok: boolean;
  reason?: string;
}

const REFUSAL_OR_HEDGING_REGEX =
  /\b(as an ai language model|i cannot determine|i'm not sure how to|unable to compute|cannot solve without)\b/i;

function extractAllText(res: CanonicalResponse): string {
  return res.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function expectsJsonResponse(req: CanonicalRequest): boolean {
  if (
    req.responseFormat &&
    (req.responseFormat.type === "json_object" ||
      req.responseFormat.type === "json_schema")
  ) {
    return true;
  }
  const lastUser = req.messages
    .slice()
    .reverse()
    .find((m) => m.role === "user");
  const userText = lastUser
    ? lastUser.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    : "";
  return /\breturn\s+only\s+json\b/i.test(userText);
}

/**
 * Fast zero-cost structural verification of a non-streaming light-tier response.
 * Triggers an automatic escalation retry when the light model truncates, outputs empty text,
 * produces invalid JSON when JSON was requested, or hedges without answering.
 */
export function verifyResponseStructurally(
  req: CanonicalRequest,
  res: CanonicalResponse,
): CascadeCheckResult {
  const hasToolCalls = res.content.some((b) => b.type === "tool_use");
  const text = extractAllText(res);

  if (!hasToolCalls && text.length === 0) {
    return { ok: false, reason: "empty response from upstream" };
  }

  if (res.stopReason === "max_tokens") {
    return { ok: false, reason: "truncated at max_tokens" };
  }

  if (!hasToolCalls && expectsJsonResponse(req)) {
    const cleaned = text
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```/g, "")
      .trim();
    try {
      JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          return { ok: false, reason: "malformed JSON output" };
        }
      } else {
        return { ok: false, reason: "missing JSON object in output" };
      }
    }
  }

  if (!hasToolCalls && text.length < 220 && REFUSAL_OR_HEDGING_REGEX.test(text)) {
    return { ok: false, reason: "hedging/unable-to-answer response" };
  }

  return { ok: true };
}
