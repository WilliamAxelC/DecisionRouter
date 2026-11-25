import { getModelPricing } from "../src/config/loader.js";
import type { RouterConfig } from "../src/config/schema.js";
import type { CandidateRef } from "../src/types/ir.js";
import type { StrategyCostComparison } from "./types.js";

export interface TrajectoryStepBillingInput {
  inputTokens: number;
  outputTokens: number;
}

interface CacheState {
  lastProvider: string;
  lastModel: string;
  cachedPrefixTokens: number;
  lastTsMs: number;
}

/**
 * Computes realistic prompt-cache billing across a trajectory:
 * - Anthropic: cache read = cachedInputPer1M (0.1x), cache write / uncached delta = 1.25x inputPer1M.
 * - OpenAI/Gemini: cache read = cachedInputPer1M (0.25x), new/uncached delta = 1.0x inputPer1M.
 * - Switching provider/model triggers a full cache miss on the entire input prefix.
 */
export function calculateTrajectoryCostUsd(
  steps: TrajectoryStepBillingInput[],
  choices: CandidateRef[],
  config: RouterConfig,
  cacheTtlSec = 300,
): number {
  let state: CacheState | null = null;
  let totalCost = 0;
  let simTimeMs = 1_000_000;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const choice = choices[i];
    const pricing = getModelPricing(config, choice.provider, choice.model);
    const providerType = config.providers[choice.provider]?.type ?? "openai";
    const writeMultiplier = providerType === "anthropic" ? 1.25 : 1.0;

    const isCacheWarm =
      state !== null &&
      state.lastProvider === choice.provider &&
      state.lastModel === choice.model &&
      simTimeMs - state.lastTsMs <= cacheTtlSec * 1000;

    const cachedTokens = isCacheWarm
      ? Math.min(state!.cachedPrefixTokens, step.inputTokens)
      : 0;
    const uncachedOrWriteTokens = Math.max(0, step.inputTokens - cachedTokens);

    const stepCost =
      (cachedTokens / 1_000_000) * pricing.cachedInputPer1M +
      (uncachedOrWriteTokens / 1_000_000) * pricing.inputPer1M * writeMultiplier +
      (step.outputTokens / 1_000_000) * pricing.outputPer1M;

    totalCost += stepCost;

    state = {
      lastProvider: choice.provider,
      lastModel: choice.model,
      cachedPrefixTokens: step.inputTokens,
      lastTsMs: simTimeMs,
    };
    simTimeMs += 5_000;
  }

  return Number(totalCost.toFixed(6));
}

export function compareStrategyCosts(
  steps: TrajectoryStepBillingInput[],
  decisionRouterChoices: CandidateRef[],
  naiveStatelessChoices: CandidateRef[],
  config: RouterConfig,
): StrategyCostComparison {
  const frontierRef: CandidateRef = {
    provider: "anthropic",
    model: "claude-opus-4-6",
  };
  const complexRef: CandidateRef = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  };

  const alwaysFrontierUsd = calculateTrajectoryCostUsd(
    steps,
    steps.map(() => frontierRef),
    config,
  );
  const alwaysComplexUsd = calculateTrajectoryCostUsd(
    steps,
    steps.map(() => complexRef),
    config,
  );
  const naiveStatelessUsd = calculateTrajectoryCostUsd(
    steps,
    naiveStatelessChoices,
    config,
  );
  const decisionRouterUsd = calculateTrajectoryCostUsd(
    steps,
    decisionRouterChoices,
    config,
  );

  const pct = (base: number, actual: number) =>
    base > 0 ? Number((((base - actual) / base) * 100).toFixed(2)) : 0;

  return {
    alwaysFrontierUsd,
    alwaysComplexUsd,
    naiveStatelessUsd,
    decisionRouterUsd,
    savingsVsFrontierPct: pct(alwaysFrontierUsd, decisionRouterUsd),
    savingsVsComplexPct: pct(alwaysComplexUsd, decisionRouterUsd),
    savingsVsNaivePct: pct(naiveStatelessUsd, decisionRouterUsd),
  };
}
