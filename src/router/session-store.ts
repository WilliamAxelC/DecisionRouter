import { getModelPricing } from "../config/loader.js";
import type { ProfileConfig, RouterConfig } from "../config/schema.js";
import type { BaseTier, RoutingTier } from "../types/ir.js";
import type { RequestFeatures } from "./features.js";

export interface SessionState {
  sessionId: string;
  lastProvider: string;
  lastModel: string;
  lastTier: RoutingTier;
  lastUpdatedAt: number;
  estimatedCachedTokens: number;
}

const TIER_RANK: Record<BaseTier, number> = {
  trivial: 0,
  standard: 1,
  complex: 2,
  frontier: 3,
};

export function tierRank(tier: RoutingTier): number {
  if (tier === "self") return -1;
  if (tier === "specialist") return 2;
  return TIER_RANK[tier];
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly maxEntries = 1000) {}

  get(sessionId: string, ttlSec: number, nowMs = Date.now()): SessionState | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    if (nowMs - entry.lastUpdatedAt > ttlSec * 1000) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    // Refresh LRU order
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, entry);
    return entry;
  }

  upsert(state: SessionState): void {
    if (this.sessions.has(state.sessionId)) {
      this.sessions.delete(state.sessionId);
    } else if (this.sessions.size >= this.maxEntries) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey !== undefined) this.sessions.delete(oldestKey);
    }
    this.sessions.set(state.sessionId, state);
  }

  clear(): void {
    this.sessions.clear();
  }
}

export interface StickyCheckResult {
  staySticky: boolean;
  reason: string;
}

/**
 * Evaluates whether staying on the active session model (reusing prompt cache)
 * is cheaper or within 5% of switching to a cheaper candidate model (which pays full uncached prefill).
 */
export function shouldStayCacheSticky(
  session: SessionState | undefined,
  candidateProvider: string,
  candidateModel: string,
  candidateTier: RoutingTier,
  features: RequestFeatures,
  config: RouterConfig,
  profile: ProfileConfig,
  nowMs = Date.now(),
): StickyCheckResult {
  if (!profile.cacheStickyEnabled || !session) {
    return { staySticky: false, reason: "no active cache session" };
  }
  if (nowMs - session.lastUpdatedAt > profile.cacheTtlSec * 1000) {
    return { staySticky: false, reason: "session cache expired" };
  }

  // Only consider stickiness when we would otherwise downgrade (or stay equal)
  if (tierRank(candidateTier) > tierRank(session.lastTier)) {
    return { staySticky: false, reason: "upgrading tier" };
  }

  if (
    session.lastProvider === candidateProvider &&
    session.lastModel === candidateModel
  ) {
    return { staySticky: true, reason: "same model selected" };
  }

  const cachedTokens = Math.min(
    session.estimatedCachedTokens,
    features.estimatedTotalTokens,
  );
  if (cachedTokens < 512) {
    return { staySticky: false, reason: "prefix too small to cache" };
  }

  const deltaInputTokens = Math.max(0, features.estimatedTotalTokens - cachedTokens);
  const assumedOutputTokens = 300;

  const stickyPricing = getModelPricing(
    config,
    session.lastProvider,
    session.lastModel,
  );
  const candidatePricing = getModelPricing(
    config,
    candidateProvider,
    candidateModel,
  );

  const stickyCost =
    (cachedTokens / 1_000_000) * stickyPricing.cachedInputPer1M +
    (deltaInputTokens / 1_000_000) * stickyPricing.inputPer1M +
    (assumedOutputTokens / 1_000_000) * stickyPricing.outputPer1M;

  const switchCost =
    (features.estimatedTotalTokens / 1_000_000) * candidatePricing.inputPer1M +
    (assumedOutputTokens / 1_000_000) * candidatePricing.outputPer1M;

  // Stay sticky if switching would not save at least 5%
  if (switchCost >= stickyCost * 0.95) {
    return {
      staySticky: true,
      reason: `cache-sticky (${cachedTokens} cached tok; stay ~$${stickyCost.toFixed(5)} vs switch ~$${switchCost.toFixed(5)})`,
    };
  }

  return {
    staySticky: false,
    reason: `switch saves >5% ($${switchCost.toFixed(5)} < $${stickyCost.toFixed(5)})`,
  };
}
