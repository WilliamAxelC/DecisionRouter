import type { DecisionSource, RoutingTier, SpecialistKind } from "../src/types/ir.js";

export type BenchmarkMode = "simulated" | "heuristic" | "live-classifier";

export type BenchmarkSuiteName =
  | "all"
  | "single"
  | "traps"
  | "agent"
  | "stress"
  | "protocol";

export interface SingleTurnScenario {
  id: string;
  category: "trivial" | "standard" | "complex" | "frontier" | "specialist";
  prompt: string;
  system?: string;
  hasImages?: boolean;
  tools?: Array<Record<string, unknown>>;
  estimatedExtraTokens?: number;
  minRequiredTier: RoutingTier;
  idealTier: RoutingTier;
  specialist?: SpecialistKind;
  expectedOutputTokens: number;
  tags: string[];
}

export interface ContextTrapTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ContextTrapScenario {
  id: string;
  name: string;
  description: string;
  minRequiredTier: RoutingTier;
  turns: ContextTrapTurn[];
  expectedOutputTokens: number;
}

export interface AgentStep {
  label: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  minRequiredTier: RoutingTier;
  expectEscalated?: boolean;
  expectCacheSticky?: boolean;
  expectedOutputTokens: number;
}

export interface AgentLoopScenario {
  id: string;
  name: string;
  description: string;
  systemPromptChars: number;
  steps: AgentStep[];
}

export interface SingleTurnResult {
  id: string;
  category: string;
  idealTier: RoutingTier;
  minRequiredTier: RoutingTier;
  actualTier: RoutingTier;
  actualSpecialist?: SpecialistKind;
  selectedModel: string;
  source: DecisionSource;
  decisionMs: number;
  exactMatch: boolean;
  overRouted: boolean;
  underRouted: boolean;
  specialistMatch: boolean;
}

export interface SingleTurnSummary {
  total: number;
  exactMatches: number;
  exactMatchPct: number;
  overRoutedCount: number;
  underRoutedCount: number;
  underRoutedPct: number;
  avgDecisionMs: number;
  results: SingleTurnResult[];
}

export interface ContextTrapResult {
  id: string;
  name: string;
  minRequiredTier: RoutingTier;
  turn1Tier: RoutingTier;
  turn3Tier: RoutingTier;
  turn3Model: string;
  turn3Source: DecisionSource;
  cacheSticky: boolean;
  survived: boolean;
  reason: string;
}

export interface ContextTrapSummary {
  total: number;
  survived: number;
  survivalPct: number;
  results: ContextTrapResult[];
}

export interface StrategyCostComparison {
  alwaysFrontierUsd: number;
  alwaysComplexUsd: number;
  naiveStatelessUsd: number;
  decisionRouterUsd: number;
  savingsVsFrontierPct: number;
  savingsVsComplexPct: number;
  savingsVsNaivePct: number;
}

export interface AgentLoopResult {
  id: string;
  name: string;
  stepsCount: number;
  cacheStickyHits: number;
  cacheStickyEligible: number;
  expectedEscalations: number;
  caughtEscalations: number;
  stepsToEscalate: number | null;
  underRoutedSteps: number;
  costs: StrategyCostComparison;
}

export interface AgentLoopSummary {
  totalLoops: number;
  totalSteps: number;
  cacheStickyRatePct: number;
  escalationRecallPct: number;
  results: AgentLoopResult[];
  aggregateCosts: StrategyCostComparison;
}

export interface StressSummary {
  totalRequests: number;
  userFacingErrors: number;
  failoversTriggered: number;
  p50DecisionMs: number;
  p95DecisionMs: number;
  p99DecisionMs: number;
  sourceDistribution: Record<string, number>;
}

export type AuditStatus = "PASS" | "WARN" | "GAP";

export interface ProtocolAuditItem {
  id: string;
  name: string;
  status: AuditStatus;
  detail: string;
}

export interface BenchmarkReport {
  timestamp: string;
  mode: BenchmarkMode;
  suite: BenchmarkSuiteName;
  singleTurn?: SingleTurnSummary;
  contextTraps?: ContextTrapSummary;
  agentLoops?: AgentLoopSummary;
  stress?: StressSummary;
  protocolAudit?: ProtocolAuditItem[];
  gapsSurfaced: string[];
}
