import crypto from "node:crypto";
import type { CanonicalMessage, CanonicalRequest } from "../types/ir.js";

export interface RequestFeatures {
  estimatedTotalTokens: number;
  estimatedLastTurnTokens: number;
  messageCount: number;
  hasImages: boolean;
  toolCount: number;
  toolNames: string[];
  isToolLoopContinuation: boolean;
  consecutiveToolErrors: number;
  repeatedToolLoop: boolean;
  userCorrectionSignal: boolean;
  trimmedRecentTurn: string;
  lastUserText: string;
  prefixHash: string;
  decisionCacheKey: string;
}

const TOOL_ERROR_REGEX =
  /\b(exit code\s*[1-9]\d*|non-?zero exit|traceback|exception|segmentation fault|fatal:|panic:|failed|fail\b|error:)/i;

const USER_CORRECTION_REGEX =
  /^\s*(no[,!.\s]|nope[,!.\s]|wrong|that(?:'s| is) wrong|not quite|try again|still (?:broken|failing|fails|wrong|doesn't work|not working)|that didn't work|stop doing that|fix that|you broke)/i;

function estimateCharsForMessage(msg: CanonicalMessage): number {
  let chars = 16;
  for (const b of msg.content) {
    if (b.type === "text") chars += b.text.length;
    else if (b.type === "thinking") chars += b.thinking.length;
    else if (b.type === "tool_use") chars += b.name.length + JSON.stringify(b.input ?? {}).length;
    else if (b.type === "tool_result") chars += b.content.length;
    else if (b.type === "image") chars += 1000; // image token equivalent (~250+ tokens)
  }
  return chars;
}

function summarizeMessageForClassifier(msg: CanonicalMessage): string {
  const parts: string[] = [];
  for (const b of msg.content) {
    if (b.type === "text" && b.text.trim()) {
      parts.push(b.text.trim());
    } else if (b.type === "tool_use") {
      parts.push(`[tool_call:${b.name}]`);
    } else if (b.type === "tool_result") {
      const flag = b.isError ? "ERROR " : "";
      parts.push(`[tool_result ${flag}${b.content.slice(0, 240)}]`);
    } else if (b.type === "image") {
      parts.push("[image]");
    }
  }
  return `${msg.role}: ${parts.join(" ")}`.trim();
}

function sha256Short(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export function extractFeatures(
  req: CanonicalRequest,
  maxContextChars = 1800,
): RequestFeatures {
  let totalChars = req.system ? req.system.length : 0;
  let hasImages = false;

  for (const msg of req.messages) {
    totalChars += estimateCharsForMessage(msg);
    for (const b of msg.content) {
      if (b.type === "image") hasImages = true;
    }
  }

  const toolNames = (req.tools ?? []).map((t) => t.name);
  if (req.tools && req.tools.length > 0) {
    totalChars += JSON.stringify(req.tools).length;
  }

  const estimatedTotalTokens = Math.max(1, Math.ceil(totalChars / 4));

  const lastMsg = req.messages[req.messages.length - 1];
  const estimatedLastTurnTokens = lastMsg
    ? Math.max(1, Math.ceil(estimateCharsForMessage(lastMsg) / 4))
    : 1;

  const isToolLoopContinuation = Boolean(
    lastMsg && lastMsg.content.some((b) => b.type === "tool_result"),
  );

  // Count trailing consecutive tool errors from the end of the message history
  let consecutiveToolErrors = 0;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    const results = msg.content.filter((b) => b.type === "tool_result");
    if (results.length === 0) {
      if (msg.role === "assistant") continue;
      break;
    }
    const msgHasError = results.some(
      (r) => r.type === "tool_result" && (r.isError || TOOL_ERROR_REGEX.test(r.content)),
    );
    if (msgHasError) {
      consecutiveToolErrors += 1;
    } else {
      break;
    }
  }

  // Detect repeated near-identical tool_use calls in recent assistant turns
  const recentToolSignatures: string[] = [];
  for (let i = Math.max(0, req.messages.length - 8); i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (msg.role !== "assistant") continue;
    for (const b of msg.content) {
      if (b.type === "tool_use") {
        const sig = `${b.name}:${sha256Short(JSON.stringify(b.input ?? {}))}`;
        recentToolSignatures.push(sig);
      }
    }
  }
  const sigCounts = new Map<string, number>();
  let repeatedToolLoop = false;
  for (const sig of recentToolSignatures) {
    const next = (sigCounts.get(sig) ?? 0) + 1;
    sigCounts.set(sig, next);
    if (next >= 2) {
      repeatedToolLoop = true;
      break;
    }
  }

  // Find latest user text message (non-tool-result)
  let lastUserText = "";
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role === "user") {
      const txt = m.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (txt.length > 0) {
        lastUserText = txt;
        break;
      }
    }
  }

  const userCorrectionSignal =
    !isToolLoopContinuation &&
    lastUserText.length > 0 &&
    lastUserText.length <= 280 &&
    USER_CORRECTION_REGEX.test(lastUserText);

  // Build compact trimmed snippet of last 1-2 turns within maxContextChars
  const tailSlice = req.messages.slice(-2);
  const rawSummary = tailSlice.map(summarizeMessageForClassifier).join("\n");
  const trimmedRecentTurn =
    rawSummary.length > maxContextChars
      ? rawSummary.slice(rawSummary.length - maxContextChars)
      : rawSummary;

  // Rolling prefix hash: system + first up to 3 messages so multi-turn/tool-loop requests correlate
  const prefixAnchor = [
    req.system ? req.system.slice(0, 512) : "",
    ...req.messages.slice(0, 3).map((m) => summarizeMessageForClassifier(m).slice(0, 256)),
  ].join("|");
  const prefixHash = sha256Short(prefixAnchor || "empty");

  const decisionCacheKey = sha256Short(
    `${trimmedRecentTurn}|tools:${toolNames.slice(0, 8).join(",")}|img:${hasImages}`,
  );

  return {
    estimatedTotalTokens,
    estimatedLastTurnTokens,
    messageCount: req.messages.length,
    hasImages,
    toolCount: toolNames.length,
    toolNames,
    isToolLoopContinuation,
    consecutiveToolErrors,
    repeatedToolLoop,
    userCorrectionSignal,
    trimmedRecentTurn,
    lastUserText,
    prefixHash,
    decisionCacheKey,
  };
}
