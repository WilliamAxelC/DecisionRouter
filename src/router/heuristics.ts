import type { ProfileConfig } from "../config/schema.js";
import type { RoutingTier, SpecialistKind } from "../types/ir.js";
import type { RequestFeatures } from "./features.js";

export interface HeuristicClassification {
  tier: RoutingTier;
  specialist?: SpecialistKind;
  reason: string;
}

const COMPLEX_SIGNAL_REGEX =
  /\b(architect(?:ure)?|refactor|concurrency|race condition|deadlock|distributed|security audit|cryptograph|migrate|memory leak|root cause|optimize query|system design)\b/i;

const REASONING_SIGNAL_REGEX =
  /\b(prove|mathematical proof|formal verification|theorem|sat solver|dynamic programming|algorithmic complexity)\b/i;

const TRIVIAL_SIGNAL_REGEX =
  /^\s*(hi|hello|hey|thanks|thank you|ok|okay|ping|test|summarize this|format this|translate|convert)\b/i;

/**
 * Deterministic <1ms classifier used for hard capability gates and Layer 2 silent fallback.
 */
export function classifyHeuristically(
  features: RequestFeatures,
  profile: ProfileConfig,
): HeuristicClassification {
  if (features.hasImages) {
    return {
      tier: "specialist",
      specialist: "vision",
      reason: "image attachment detected",
    };
  }

  if (features.estimatedTotalTokens >= 80_000) {
    return {
      tier: "specialist",
      specialist: "long_context",
      reason: `long context (~${features.estimatedTotalTokens} tokens)`,
    };
  }

  const text = features.lastUserText || features.trimmedRecentTurn;

  if (REASONING_SIGNAL_REGEX.test(text)) {
    return {
      tier: "specialist",
      specialist: "reasoning",
      reason: "formal/algorithmic reasoning keywords",
    };
  }

  if (COMPLEX_SIGNAL_REGEX.test(text) || features.estimatedLastTurnTokens > 2500) {
    return {
      tier: "complex",
      reason: "complex engineering/architecture signal",
    };
  }

  if (
    features.toolCount === 0 &&
    features.messageCount <= 2 &&
    features.estimatedLastTurnTokens <= 120 &&
    (TRIVIAL_SIGNAL_REGEX.test(text) || text.length < 100)
  ) {
    return {
      tier: "trivial",
      reason: "short simple prompt without tools",
    };
  }

  return {
    tier: profile.defaultTier,
    reason: `heuristic fallback (${profile.defaultTier})`,
  };
}
