import type { ProfileConfig, RouterConfig } from "../config/schema.js";
import type { UpstreamResult } from "../providers/base.js";
import { UpstreamError } from "../providers/base.js";
import { CircuitBreaker } from "../providers/circuit-breaker.js";
import { getUpstreamAdapter } from "../providers/registry.js";
import type {
  BaseTier,
  CandidateRef,
  CanonicalRequest,
  CanonicalStreamEvent,
  RoutingDecision,
  RoutingTier,
  SpecialistKind,
} from "../types/ir.js";
import { extractFeatures, type RequestFeatures } from "./features.js";
import {
  GeminiDecisionClassifier,
  type ClassifierDecision,
} from "./gemini-classifier.js";
import { classifyHeuristically } from "./heuristics.js";
import {
  SessionStore,
  shouldStayCacheSticky,
  tierRank,
} from "./session-store.js";

const TIER_ORDER: BaseTier[] = ["trivial", "standard", "complex", "frontier"];

interface CachedDecisionEntry {
  tier: RoutingTier;
  specialist?: SpecialistKind;
  reason: string;
  directAnswer?: string;
  classifierModel?: string;
  expiresAt: number;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function clampTier(tier: BaseTier, minTier: BaseTier, maxTier: BaseTier): BaseTier {
  const idx = TIER_ORDER.indexOf(tier);
  const minIdx = TIER_ORDER.indexOf(minTier);
  const maxIdx = TIER_ORDER.indexOf(maxTier);
  return TIER_ORDER[Math.min(Math.max(idx, minIdx), maxIdx)];
}

function bumpTierUp(
  tier: RoutingTier,
  maxTier: BaseTier,
  minEscalatedTier?: BaseTier,
): BaseTier {
  const maxIdx = TIER_ORDER.indexOf(maxTier);
  let bumpedIdx: number;
  if (tier === "specialist") {
    bumpedIdx = maxIdx;
  } else if (tier === "self") {
    bumpedIdx = Math.min(1, maxIdx); // bump self -> standard (or maxTier if lower)
  } else {
    const idx = TIER_ORDER.indexOf(tier);
    bumpedIdx = Math.min(idx + 1, maxIdx);
  }
  if (minEscalatedTier) {
    const minIdx = TIER_ORDER.indexOf(minEscalatedTier);
    bumpedIdx = Math.min(Math.max(bumpedIdx, minIdx), maxIdx);
  }
  return TIER_ORDER[bumpedIdx];
}

async function* createSelfAnswerStream(
  decision: RoutingDecision,
  inputTokens: number,
  outputTokens: number,
): AsyncGenerator<CanonicalStreamEvent> {
  const id = `self_${Date.now()}`;
  yield {
    type: "message_start",
    id,
    model: decision.selectedModel,
    inputTokens,
    cachedInputTokens: 0,
  };
  if (decision.selfAnswer && decision.selfAnswer.length > 0) {
    yield {
      type: "text_delta",
      text: decision.selfAnswer,
    };
  }
  yield {
    type: "message_delta",
    stopReason: "end_turn",
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
    },
  };
  yield { type: "message_stop" };
}

export interface ExecutionOutcome {
  decision: RoutingDecision;
  result: UpstreamResult;
}

export class DecisionEngine {
  readonly sessions = new SessionStore();
  readonly classifier = new GeminiDecisionClassifier();
  readonly breaker: CircuitBreaker;
  private readonly decisionCache = new Map<string, CachedDecisionEntry>();

  constructor(private readonly config: RouterConfig) {
    this.breaker = new CircuitBreaker(
      config.circuitBreaker.failureThreshold,
      config.circuitBreaker.cooldownSec,
    );
  }

  private resolveProfile(requestedModel: string): {
    mode: "passthrough" | "routed";
    directCandidate?: CandidateRef;
    profileName: string;
    profile: ProfileConfig;
  } {
    const defaultProfile =
      this.config.profiles.auto ?? Object.values(this.config.profiles)[0];

    // 1. Explicit direct/<provider>/<model> passthrough
    if (requestedModel.startsWith("direct/")) {
      const rest = requestedModel.slice("direct/".length);
      const slash = rest.indexOf("/");
      if (slash > 0) {
        return {
          mode: "passthrough",
          directCandidate: {
            provider: rest.slice(0, slash),
            model: rest.slice(slash + 1),
          },
          profileName: "direct",
          profile: defaultProfile,
        };
      }
    }

    // 2. Virtual routing profile (e.g. "auto", "auto:eco", "auto:coding")
    if (this.config.profiles[requestedModel]) {
      return {
        mode: "routed",
        profileName: requestedModel,
        profile: this.config.profiles[requestedModel],
      };
    }

    // 3. Configurable intercept rules (e.g. "claude-*" -> "auto:coding")
    for (const rule of this.config.intercepts) {
      if (globToRegex(rule.pattern).test(requestedModel)) {
        const targetProfile = this.config.profiles[rule.profile] ?? defaultProfile;
        return {
          mode: "routed",
          profileName: rule.profile,
          profile: targetProfile,
        };
      }
    }

    // 4. Concrete model name matching a configured provider passes straight through
    const directSlash = requestedModel.indexOf("/");
    if (directSlash > 0) {
      const p = requestedModel.slice(0, directSlash);
      const m = requestedModel.slice(directSlash + 1);
      if (this.config.providers[p]) {
        return {
          mode: "passthrough",
          directCandidate: { provider: p, model: m },
          profileName: "direct",
          profile: defaultProfile,
        };
      }
    }

    for (const [providerName, providerCfg] of Object.entries(this.config.providers)) {
      if (providerCfg.models[requestedModel]) {
        return {
          mode: "passthrough",
          directCandidate: { provider: providerName, model: requestedModel },
          profileName: "direct",
          profile: defaultProfile,
        };
      }
    }

    // Unknown virtual/alias -> route using default profile
    return {
      mode: "routed",
      profileName: "auto",
      profile: defaultProfile,
    };
  }

  private filterCandidatesByCapabilities(
    candidates: CandidateRef[],
    features: RequestFeatures,
  ): CandidateRef[] {
    return candidates.filter((cand) => {
      const providerCfg = this.config.providers[cand.provider];
      if (!providerCfg) return false;
      const modelCfg = providerCfg.models[cand.model];
      if (!modelCfg) return true;
      if (features.hasImages && !modelCfg.supportsVision) return false;
      if (features.toolCount > 0 && !modelCfg.supportsTools) return false;
      if (features.estimatedTotalTokens > modelCfg.contextWindow) return false;
      return true;
    });
  }

  private getTierCandidates(
    tier: RoutingTier,
    specialist: SpecialistKind | undefined,
    features: RequestFeatures,
  ): CandidateRef[] {
    let baseList: CandidateRef[] = [];
    if (tier === "specialist" && specialist) {
      baseList = [
        ...this.config.tiers.specialists[specialist],
        ...this.config.tiers.complex,
        ...this.config.tiers.frontier,
      ];
    } else {
      const safeTier: BaseTier =
        tier === "specialist" ? "complex" : tier === "self" ? "trivial" : tier;
      const idx = TIER_ORDER.indexOf(safeTier);
      // Primary tier candidates first, then one tier up as cross-tier backup
      baseList = [...this.config.tiers[safeTier]];
      if (idx + 1 < TIER_ORDER.length) {
        baseList.push(...this.config.tiers[TIER_ORDER[idx + 1]]);
      }
    }

    // Deduplicate while preserving priority order
    const seen = new Set<string>();
    const deduped: CandidateRef[] = [];
    for (const c of baseList) {
      const key = `${c.provider}/${c.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(c);
      }
    }

    const capable = this.filterCandidatesByCapabilities(deduped, features);
    const list = capable.length > 0 ? capable : deduped;

    // Prefer candidates whose circuit breaker is healthy; append tripped ones at the end as last resort
    const healthy = list.filter((c) => this.breaker.isAvailable(c.provider, c.model));
    const tripped = list.filter((c) => !this.breaker.isAvailable(c.provider, c.model));
    return [...healthy, ...tripped];
  }

  async decide(req: CanonicalRequest): Promise<{
    decision: RoutingDecision;
    candidates: CandidateRef[];
    features: RequestFeatures;
    profile: ProfileConfig;
  }> {
    const startMs = performance.now();
    const features = extractFeatures(req, this.config.decisionModel.maxContextChars);
    const resolved = this.resolveProfile(req.requestedModel);
    const sessionId = req.headers["x-router-session"] || features.prefixHash;

    // Header override: X-Router-Model: provider/model
    const headerModel = req.headers["x-router-model"];
    if (headerModel) {
      const slash = headerModel.indexOf("/");
      if (slash > 0) {
        const provider = headerModel.slice(0, slash);
        const model = headerModel.slice(slash + 1);
        return {
          decision: {
            profile: resolved.profileName,
            tier: "standard",
            source: "header",
            reason: `X-Router-Model override (${headerModel})`,
            decisionMs: Math.round((performance.now() - startMs) * 100) / 100,
            cacheSticky: false,
            escalated: false,
            selfHandled: false,
            failovers: 0,
            selectedProvider: provider,
            selectedModel: model,
            sessionId,
            estimatedInputTokens: features.estimatedTotalTokens,
          },
          candidates: [{ provider, model }],
          features,
          profile: resolved.profile,
        };
      }
    }

    // Direct passthrough
    if (resolved.mode === "passthrough" && resolved.directCandidate) {
      const c = resolved.directCandidate;
      return {
        decision: {
          profile: resolved.profileName,
          tier: "standard",
          source: "passthrough",
          reason: `Direct passthrough (${c.provider}/${c.model})`,
          decisionMs: Math.round((performance.now() - startMs) * 100) / 100,
          cacheSticky: false,
          escalated: false,
          selfHandled: false,
          failovers: 0,
          selectedProvider: c.provider,
          selectedModel: c.model,
          sessionId,
          estimatedInputTokens: features.estimatedTotalTokens,
        },
        candidates: [c],
        features,
        profile: resolved.profile,
      };
    }

    const profile = resolved.profile;
    const session = this.sessions.get(sessionId, profile.cacheTtlSec);

    // Header override: X-Router-Tier
    const headerTier = req.headers["x-router-tier"]?.toLowerCase();
    if (
      headerTier === "trivial" ||
      headerTier === "standard" ||
      headerTier === "complex" ||
      headerTier === "frontier"
    ) {
      const candidates = this.getTierCandidates(headerTier, undefined, features);
      const chosen = candidates[0];
      return {
        decision: {
          profile: resolved.profileName,
          tier: headerTier,
          source: "header",
          reason: `X-Router-Tier override (${headerTier})`,
          decisionMs: Math.round((performance.now() - startMs) * 100) / 100,
          cacheSticky: false,
          escalated: false,
          selfHandled: false,
          failovers: 0,
          selectedProvider: chosen.provider,
          selectedModel: chosen.model,
          sessionId,
          estimatedInputTokens: features.estimatedTotalTokens,
        },
        candidates,
        features,
        profile,
      };
    }

    // Escalation check (bypasses cache stickiness and self-answering)
    const shouldEscalate =
      profile.escalationEnabled &&
      (features.consecutiveToolErrors >= 2 ||
        features.repeatedToolLoop ||
        features.userCorrectionSignal);

    if (shouldEscalate) {
      const baseTier = session?.lastTier ?? profile.defaultTier;
      const escalatedTier = bumpTierUp(
        baseTier,
        profile.maxTier,
        features.userCorrectionSignal ? "complex" : undefined,
      );
      const candidates = this.getTierCandidates(escalatedTier, undefined, features);
      const chosen = candidates[0];
      const reasons: string[] = [];
      if (features.consecutiveToolErrors >= 2) {
        reasons.push(`${features.consecutiveToolErrors} consecutive tool errors`);
      }
      if (features.repeatedToolLoop) reasons.push("repeated tool loop");
      if (features.userCorrectionSignal) reasons.push("user correction");

      return {
        decision: {
          profile: resolved.profileName,
          tier: escalatedTier,
          source: "escalation",
          reason: `Escalated to ${escalatedTier}: ${reasons.join(", ")}`,
          decisionMs: Math.round((performance.now() - startMs) * 100) / 100,
          cacheSticky: false,
          escalated: true,
          selfHandled: false,
          failovers: 0,
          selectedProvider: chosen.provider,
          selectedModel: chosen.model,
          sessionId,
          estimatedInputTokens: features.estimatedTotalTokens,
        },
        candidates,
        features,
        profile,
      };
    }

    // Hard capability check (vision / huge context)
    if (features.hasImages || features.estimatedTotalTokens >= 80_000) {
      const cap = classifyHeuristically(features, profile);
      const candidates = this.getTierCandidates(cap.tier, cap.specialist, features);
      const chosen = candidates[0];
      return {
        decision: {
          profile: resolved.profileName,
          tier: cap.tier,
          specialist: cap.specialist,
          source: "capability",
          reason: cap.reason,
          decisionMs: Math.round((performance.now() - startMs) * 100) / 100,
          cacheSticky: false,
          escalated: false,
          selfHandled: false,
          failovers: 0,
          selectedProvider: chosen.provider,
          selectedModel: chosen.model,
          sessionId,
          estimatedInputTokens: features.estimatedTotalTokens,
        },
        candidates,
        features,
        profile,
      };
    }

    // Fast-path: active mid-tool-loop continuation stays cache-sticky without burning decision RPM
    if (
      features.isToolLoopContinuation &&
      profile.cacheStickyEnabled &&
      session &&
      session.lastProvider !== "decision-model" &&
      this.breaker.isAvailable(session.lastProvider, session.lastModel)
    ) {
      const stickyCand: CandidateRef = {
        provider: session.lastProvider,
        model: session.lastModel,
      };
      const fallbacks = this.getTierCandidates(session.lastTier, undefined, features).filter(
        (c) => !(c.provider === stickyCand.provider && c.model === stickyCand.model),
      );
      return {
        decision: {
          profile: resolved.profileName,
          tier: session.lastTier,
          source: "cache_sticky",
          reason: `Mid-loop cache-sticky on ${stickyCand.provider}/${stickyCand.model}`,
          decisionMs: Math.round((performance.now() - startMs) * 100) / 100,
          cacheSticky: true,
          escalated: false,
          selfHandled: false,
          failovers: 0,
          selectedProvider: stickyCand.provider,
          selectedModel: stickyCand.model,
          sessionId,
          estimatedInputTokens: features.estimatedTotalTokens,
        },
        candidates: [stickyCand, ...fallbacks],
        features,
        profile,
      };
    }

    // Check short-TTL decision cache, else Layer 1 Gemini classifier, else Layer 2 heuristic
    let chosenTier: RoutingTier;
    let specialist: SpecialistKind | undefined;
    let source: RoutingDecision["source"];
    let reason: string;
    let directAnswer: string | undefined;
    let classifierModel: string | undefined;

    const canSelfAnswer =
      this.config.decisionModel.allowSelfAnswer &&
      profile.allowSelfAnswer &&
      features.toolCount === 0 &&
      !features.hasImages &&
      !features.isToolLoopContinuation &&
      features.estimatedTotalTokens <=
        this.config.decisionModel.selfAnswerMaxInputTokens;

    const nowMs = Date.now();
    const cached = this.decisionCache.get(features.decisionCacheKey);
    if (
      cached &&
      cached.expiresAt > nowMs &&
      (cached.tier !== "self" || canSelfAnswer)
    ) {
      chosenTier = cached.tier;
      specialist = cached.specialist;
      source = cached.tier === "self" ? "self_answer" : "decision_cache";
      reason = cached.reason;
      directAnswer = cached.directAnswer;
      classifierModel = cached.classifierModel;
    } else {
      const geminiResult: ClassifierDecision | null =
        await this.classifier.classify(
          features,
          resolved.profileName,
          this.config.decisionModel,
          { allowSelfAnswer: canSelfAnswer },
        );
      if (geminiResult) {
        chosenTier = geminiResult.tier;
        specialist = geminiResult.specialist;
        directAnswer = geminiResult.directAnswer;
        classifierModel = geminiResult.classifierModel;
        source =
          geminiResult.tier === "self" && geminiResult.directAnswer
            ? "self_answer"
            : "gemini";
        reason = `${geminiResult.classifierModel}: ${geminiResult.reason}`;
      } else {
        const heuristic = classifyHeuristically(features, profile);
        chosenTier = heuristic.tier;
        specialist = heuristic.specialist;
        source = "heuristic";
        reason = heuristic.reason;
      }

      if (this.config.decisionModel.cacheTtlSec > 0) {
        this.decisionCache.set(features.decisionCacheKey, {
          tier: chosenTier,
          specialist,
          reason,
          directAnswer,
          classifierModel,
          expiresAt: nowMs + this.config.decisionModel.cacheTtlSec * 1000,
        });
      }
    }

    // Inline self-answer path: zero upstream calls
    if (chosenTier === "self" && directAnswer !== undefined && directAnswer.length > 0) {
      return {
        decision: {
          profile: resolved.profileName,
          tier: "self",
          source: "self_answer",
          reason,
          decisionMs: Math.round((performance.now() - startMs) * 100) / 100,
          cacheSticky: false,
          escalated: false,
          selfHandled: true,
          selfAnswer: directAnswer,
          failovers: 0,
          selectedProvider: "decision-model",
          selectedModel:
            classifierModel ??
            this.config.decisionModel.models[0]?.id ??
            "gemini-2.5-flash-lite",
          sessionId,
          estimatedInputTokens: features.estimatedTotalTokens,
        },
        candidates: [],
        features,
        profile,
      };
    }

    if (chosenTier === "self") {
      chosenTier = "trivial";
    }

    if (chosenTier !== "specialist") {
      chosenTier = clampTier(chosenTier, profile.minTier, profile.maxTier);
    }

    let candidates = this.getTierCandidates(chosenTier, specialist, features);
    let primary = candidates[0];
    let cacheSticky = false;

    // Cache-stickiness downgrade guard on new user turns when prefix cache is warm
    if (
      primary &&
      session &&
      session.lastProvider !== "decision-model" &&
      tierRank(chosenTier) <= tierRank(session.lastTier)
    ) {
      const stickyCheck = shouldStayCacheSticky(
        session,
        primary.provider,
        primary.model,
        chosenTier,
        features,
        this.config,
        profile,
      );
      if (
        stickyCheck.staySticky &&
        this.breaker.isAvailable(session.lastProvider, session.lastModel) &&
        !(
          primary.provider === session.lastProvider &&
          primary.model === session.lastModel
        )
      ) {
        const stickyCand: CandidateRef = {
          provider: session.lastProvider,
          model: session.lastModel,
        };
        candidates = [
          stickyCand,
          ...candidates.filter(
            (c) => !(c.provider === stickyCand.provider && c.model === stickyCand.model),
          ),
        ];
        primary = stickyCand;
        cacheSticky = true;
        source = "cache_sticky";
        reason = stickyCheck.reason;
        chosenTier = session.lastTier;
      }
    }

    if (!primary) {
      throw new Error(
        `No candidate models configured for tier "${chosenTier}" (profile "${resolved.profileName}")`,
      );
    }

    return {
      decision: {
        profile: resolved.profileName,
        tier: chosenTier,
        specialist,
        source,
        reason,
        decisionMs: Math.round((performance.now() - startMs) * 100) / 100,
        cacheSticky,
        escalated: false,
        selfHandled: false,
        failovers: 0,
        selectedProvider: primary.provider,
        selectedModel: primary.model,
        sessionId,
        estimatedInputTokens: features.estimatedTotalTokens,
      },
      candidates,
      features,
      profile,
    };
  }

  async execute(req: CanonicalRequest): Promise<ExecutionOutcome> {
    const plan = await this.decide(req);
    const { decision, candidates, features } = plan;

    if (decision.selfHandled && decision.selfAnswer !== undefined) {
      const outTokens = Math.max(1, Math.ceil(decision.selfAnswer.length / 4));
      this.sessions.upsert({
        sessionId: decision.sessionId,
        lastProvider: "decision-model",
        lastModel: decision.selectedModel,
        lastTier: "self",
        lastUpdatedAt: Date.now(),
        estimatedCachedTokens: features.estimatedTotalTokens,
      });

      if (req.stream) {
        return {
          decision,
          result: {
            kind: "stream",
            stream: createSelfAnswerStream(
              decision,
              features.estimatedTotalTokens,
              outTokens,
            ),
          },
        };
      }

      return {
        decision,
        result: {
          kind: "response",
          response: {
            id: `self_${Date.now()}`,
            model: decision.selectedModel,
            content: [{ type: "text", text: decision.selfAnswer }],
            stopReason: "end_turn",
            usage: {
              inputTokens: features.estimatedTotalTokens,
              outputTokens: outTokens,
              cachedInputTokens: 0,
            },
          },
        },
      };
    }

    let lastError: unknown;
    let failovers = 0;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const providerCfg = this.config.providers[candidate.provider];
      if (!providerCfg) {
        lastError = new UpstreamError({
          status: 500,
          retryable: true,
          provider: candidate.provider,
          model: candidate.model,
          message: `Provider "${candidate.provider}" is not configured`,
        });
        failovers += 1;
        continue;
      }

      const adapter = getUpstreamAdapter(providerCfg.type);
      try {
        const result = await adapter.send(
          req,
          candidate.provider,
          providerCfg,
          candidate.model,
        );
        this.breaker.recordSuccess(candidate.provider, candidate.model);

        const finalDecision: RoutingDecision = {
          ...decision,
          selectedProvider: candidate.provider,
          selectedModel: candidate.model,
          failovers,
        };

        // Update active session state for future cache-stickiness & escalation tracking
        this.sessions.upsert({
          sessionId: decision.sessionId,
          lastProvider: candidate.provider,
          lastModel: candidate.model,
          lastTier: decision.tier,
          lastUpdatedAt: Date.now(),
          estimatedCachedTokens: features.estimatedTotalTokens,
        });

        return { decision: finalDecision, result };
      } catch (err) {
        lastError = err;
        const retryable = err instanceof UpstreamError ? err.retryable : true;
        this.breaker.recordFailure(
          candidate.provider,
          candidate.model,
          err instanceof Error ? err.message : String(err),
        );
        if (!retryable || i === candidates.length - 1) {
          throw err;
        }
        failovers += 1;
      }
    }

    throw lastError ?? new Error("All upstream candidates failed");
  }
}
