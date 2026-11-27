import { z } from "zod";

export const BaseTierSchema = z.enum(["trivial", "standard", "complex", "frontier"]);
export const SpecialistKindSchema = z.enum([
  "vision",
  "long_context",
  "coding",
  "reasoning",
]);

export const ModelConfigSchema = z.object({
  contextWindow: z.number().int().positive().default(128000),
  supportsVision: z.boolean().default(false),
  supportsTools: z.boolean().default(true),
  rpm: z.number().int().positive().optional(),
  tpm: z.number().int().positive().optional(),
  rpd: z.number().int().positive().optional(),
  inputPer1M: z.number().nonnegative().optional(),
  cachedInputPer1M: z.number().nonnegative().optional(),
  outputPer1M: z.number().nonnegative().optional(),
});

export const ProviderConfigSchema = z.object({
  type: z.enum(["openai", "anthropic", "gemini"]),
  baseUrl: z.string().min(1),
  apiKey: z.string().default(""),
  apiKeys: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(60000),
  headers: z.record(z.string()).default({}),
  models: z.record(ModelConfigSchema).default({}),
});

export const ThinkingLevelSchema = z.enum([
  "MINIMAL",
  "LOW",
  "MEDIUM",
  "HIGH",
  "XHIGH",
]);

export const CandidateRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  thinkingLevel: ThinkingLevelSchema.optional(),
});

export const DecisionModelEntrySchema = z.object({
  id: z.string().min(1),
  api: z.enum(["decisions", "generateContent"]).optional(),
  rpm: z.number().int().positive().default(15),
  tpm: z.number().int().positive().optional(),
  rpd: z.number().int().positive().default(1000),
});

export const DecisionModelConfigSchema = z.object({
  provider: z.literal("gemini").default("gemini"),
  baseUrl: z
    .string()
    .default("https://generativelanguage.googleapis.com/v1beta"),
  timeoutMs: z.number().int().positive().default(600),
  maxContextChars: z.number().int().positive().default(1800),
  cacheTtlSec: z.number().int().nonnegative().default(60),
  allowSelfAnswer: z.boolean().default(true),
  selfAnswerMaxInputTokens: z.number().int().positive().default(1500),
  apiKeys: z.array(z.string()).default([]),
  models: z
    .array(DecisionModelEntrySchema)
    .default([
      { id: "gemini-2.5-flash-lite", rpm: 15, rpd: 1000 },
      { id: "gemini-2.5-flash", rpm: 10, rpd: 250 },
    ]),
});

export const ProfileConfigSchema = z.object({
  defaultTier: BaseTierSchema.default("standard"),
  minTier: BaseTierSchema.default("trivial"),
  maxTier: BaseTierSchema.default("frontier"),
  cacheStickyEnabled: z.boolean().default(true),
  cacheTtlSec: z.number().int().nonnegative().default(300),
  escalationEnabled: z.boolean().default(true),
  allowSelfAnswer: z.boolean().default(true),
  highRiskThreshold: z.number().min(0).max(1).default(0.32),
  frontierRiskThreshold: z.number().min(0).max(1).default(0.78),
  selfConfidenceMin: z.number().min(0).max(1).default(0.85),
  selfMaxRisk: z.number().min(0).max(1).default(0.38),
  cascadeVerifyEnabled: z.boolean().default(true),
  cascadeDecisionVerify: z.boolean().default(false),
  escalationLockTurns: z.number().int().nonnegative().default(2),
  contextInertiaEnabled: z.boolean().default(true),
  baselineModel: z.string().default("anthropic/claude-opus-4-6"),
});

export const InterceptRuleSchema = z.object({
  pattern: z.string().min(1),
  profile: z.string().min(1),
});

export const ServerConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().max(65535).default(4000),
  authToken: z.string().default(""),
  dbPath: z.string().default("./data/router.db"),
  dashboardEnabled: z.boolean().default(true),
});

export const TiersConfigSchema = z.object({
  trivial: z.array(CandidateRefSchema).default([]),
  standard: z.array(CandidateRefSchema).default([]),
  complex: z.array(CandidateRefSchema).default([]),
  frontier: z.array(CandidateRefSchema).default([]),
  specialists: z
    .object({
      vision: z.array(CandidateRefSchema).default([]),
      long_context: z.array(CandidateRefSchema).default([]),
      coding: z.array(CandidateRefSchema).default([]),
      reasoning: z.array(CandidateRefSchema).default([]),
    })
    .default({}),
});

export const CircuitBreakerConfigSchema = z.object({
  failureThreshold: z.number().int().positive().default(2),
  cooldownSec: z.number().int().positive().default(30),
});

export const RouterConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  decisionModel: DecisionModelConfigSchema.default({}),
  providers: z.record(ProviderConfigSchema).default({}),
  tiers: TiersConfigSchema.default({}),
  profiles: z.record(ProfileConfigSchema).default({
    auto: {
      defaultTier: "standard",
      minTier: "trivial",
      maxTier: "frontier",
      cacheStickyEnabled: true,
      cacheTtlSec: 300,
      escalationEnabled: true,
      allowSelfAnswer: true,
      highRiskThreshold: 0.32,
      frontierRiskThreshold: 0.78,
      selfConfidenceMin: 0.85,
      selfMaxRisk: 0.38,
      cascadeVerifyEnabled: true,
      cascadeDecisionVerify: false,
      escalationLockTurns: 2,
      contextInertiaEnabled: true,
      baselineModel: "anthropic/claude-opus-4-6",
    },
  }),
  intercepts: z.array(InterceptRuleSchema).default([]),
  circuitBreaker: CircuitBreakerConfigSchema.default({}),
});

export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;
export type DecisionModelConfig = z.infer<typeof DecisionModelConfigSchema>;
