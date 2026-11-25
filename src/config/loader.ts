import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import YAML from "yaml";
import { RouterConfigSchema, type RouterConfig } from "./schema.js";
import type { ModelPricing, TokenUsage } from "../types/ir.js";

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;

/**
 * Recursively interpolates `${VAR}` and `${VAR:-default}` across parsed YAML values.
 */
export function interpolateEnv<T>(
  value: T,
  env: Record<string, string | undefined> = process.env,
): T {
  if (typeof value === "string") {
    return value.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== "") {
        return resolved;
      }
      return fallback ?? "";
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnv(item, env)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateEnv(v, env);
    }
    return out as T;
  }
  return value;
}

export interface LoadedConfigResult {
  config: RouterConfig;
  configPath: string;
  usedFallbackExample: boolean;
}

/**
 * Loads YAML configuration from explicitPath -> ROUTER_CONFIG -> ./config.yaml -> ./config.example.yaml.
 */
export function loadConfig(explicitPath?: string): LoadedConfigResult {
  loadDotenv({ quiet: true } as Parameters<typeof loadDotenv>[0]);

  const cwd = process.cwd();
  const candidates = [
    explicitPath,
    process.env.ROUTER_CONFIG,
    path.join(cwd, "config.yaml"),
    path.join(cwd, "config.example.yaml"),
  ].filter((p): p is string => Boolean(p && p.trim().length > 0));

  let resolvedPath: string | undefined;
  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    if (fs.existsSync(abs)) {
      resolvedPath = abs;
      break;
    }
  }

  if (!resolvedPath) {
    throw new Error(
      `No configuration file found. Checked: ${candidates.join(", ")}`,
    );
  }

  const rawText = fs.readFileSync(resolvedPath, "utf8");
  const parsedYaml = YAML.parse(rawText) ?? {};
  const interpolated = interpolateEnv(parsedYaml);
  const config = RouterConfigSchema.parse(interpolated);

  // Filter empty API keys produced by unset env vars
  config.decisionModel.apiKeys = config.decisionModel.apiKeys
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  for (const p of Object.values(config.providers)) {
    p.apiKeys = p.apiKeys.map((k) => k.trim()).filter((k) => k.length > 0);
  }

  const usedFallbackExample =
    !explicitPath &&
    !process.env.ROUTER_CONFIG &&
    path.basename(resolvedPath) === "config.example.yaml";

  return {
    config,
    configPath: resolvedPath,
    usedFallbackExample,
  };
}

/** Built-in fallback pricing per 1M tokens (USD) for common models. */
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": { inputPer1M: 15.0, cachedInputPer1M: 1.5, outputPer1M: 75.0 },
  "claude-sonnet-4-6": { inputPer1M: 3.0, cachedInputPer1M: 0.3, outputPer1M: 15.0 },
  "claude-haiku-4-5": { inputPer1M: 1.0, cachedInputPer1M: 0.1, outputPer1M: 5.0 },
  "gpt-4.1": { inputPer1M: 2.0, cachedInputPer1M: 0.5, outputPer1M: 8.0 },
  "gpt-4.1-mini": { inputPer1M: 0.4, cachedInputPer1M: 0.1, outputPer1M: 1.6 },
  "gpt-4.1-nano": { inputPer1M: 0.1, cachedInputPer1M: 0.025, outputPer1M: 0.4 },
  "o4-mini": { inputPer1M: 1.1, cachedInputPer1M: 0.275, outputPer1M: 4.4 },
  "gemini-2.5-pro": { inputPer1M: 1.25, cachedInputPer1M: 0.31, outputPer1M: 10.0 },
  "gemini-2.5-flash": { inputPer1M: 0.3, cachedInputPer1M: 0.075, outputPer1M: 2.5 },
  "gemini-2.5-flash-lite": { inputPer1M: 0.1, cachedInputPer1M: 0.025, outputPer1M: 0.4 },
};

const ZERO_PRICING: ModelPricing = {
  inputPer1M: 0,
  cachedInputPer1M: 0,
  outputPer1M: 0,
};

export function getModelPricing(
  config: RouterConfig,
  provider: string,
  model: string,
): ModelPricing {
  if (provider === "decision-model") {
    return ZERO_PRICING;
  }
  const modelCfg = config.providers[provider]?.models[model];
  if (
    modelCfg &&
    (modelCfg.inputPer1M !== undefined || modelCfg.outputPer1M !== undefined)
  ) {
    const inputPer1M = modelCfg.inputPer1M ?? 0;
    return {
      inputPer1M,
      cachedInputPer1M: modelCfg.cachedInputPer1M ?? inputPer1M * 0.25,
      outputPer1M: modelCfg.outputPer1M ?? 0,
    };
  }

  // Exact or prefix match in built-in pricing table
  if (DEFAULT_PRICING[model]) {
    return DEFAULT_PRICING[model];
  }
  for (const [key, pricing] of Object.entries(DEFAULT_PRICING)) {
    if (model.startsWith(key)) {
      return pricing;
    }
  }
  if (provider === "ollama") {
    return ZERO_PRICING;
  }
  return { inputPer1M: 1.0, cachedInputPer1M: 0.25, outputPer1M: 4.0 };
}

export function estimateCostUsd(
  config: RouterConfig,
  provider: string,
  model: string,
  usage: TokenUsage,
): number {
  const pricing = getModelPricing(config, provider, model);
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncached = Math.max(0, usage.inputTokens - cached);
  const cost =
    (uncached / 1_000_000) * pricing.inputPer1M +
    (cached / 1_000_000) * pricing.cachedInputPer1M +
    (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  return Number(cost.toFixed(8));
}

export function getProviderApiKeys(providerCfg: {
  apiKey?: string;
  apiKeys?: string[];
}): string[] {
  const pool = (providerCfg.apiKeys ?? [])
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (pool.length > 0) return pool;
  if (providerCfg.apiKey && providerCfg.apiKey.trim().length > 0) {
    return [providerCfg.apiKey.trim()];
  }
  return [];
}

export function parseModelRef(
  ref: string,
  defaultProvider = "anthropic",
): { provider: string; model: string } {
  const slashIdx = ref.indexOf("/");
  if (slashIdx > 0) {
    return {
      provider: ref.slice(0, slashIdx),
      model: ref.slice(slashIdx + 1),
    };
  }
  return { provider: defaultProvider, model: ref };
}
