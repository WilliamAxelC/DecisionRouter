export type ProviderType = "openai" | "anthropic" | "gemini";

export type IncomingProtocol = "openai" | "anthropic";

export type RoutingTier =
  | "self"
  | "trivial"
  | "standard"
  | "complex"
  | "frontier"
  | "specialist";

export type BaseTier = "trivial" | "standard" | "complex" | "frontier";

export type SpecialistKind =
  | "vision"
  | "long_context"
  | "coding"
  | "reasoning";

export type DecisionSource =
  | "passthrough"
  | "header"
  | "pre_gate"
  | "self_answer"
  | "cache_sticky"
  | "escalation"
  | "decision_cache"
  | "gemini"
  | "heuristic"
  | "capability";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  /** Base64 payload (without data URL prefix) OR an http(s) URL when sourceType === "url". */
  data: string;
  sourceType: "base64" | "url";
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  /** Optional tool name if known at parse time; adapters can also resolve via toolUseId. */
  toolName?: string;
  content: string;
  isError?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
  provider?: ProviderType;
}

export type CanonicalContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock;

export interface CanonicalMessage {
  role: "user" | "assistant" | "tool";
  content: CanonicalContentBlock[];
}

export interface CanonicalTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type CanonicalToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; name: string };

export interface CanonicalSystemBlock {
  type: "text";
  text: string;
  cacheControl?: { type: string };
}

export interface CanonicalRequest {
  protocol: IncomingProtocol;
  requestedModel: string;
  system?: string;
  systemBlocks?: CanonicalSystemBlock[];
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  responseFormat?: {
    type: "text" | "json_object" | "json_schema";
    jsonSchema?: Record<string, unknown>;
  };
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  stream: boolean;
  headers: Record<string, string>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type CanonicalStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "error";

export interface CanonicalResponse {
  id: string;
  model: string;
  content: CanonicalContentBlock[];
  stopReason: CanonicalStopReason;
  usage: TokenUsage;
}

export type CanonicalStreamEvent =
  | { type: "message_start"; id: string; model: string; inputTokens?: number; cachedInputTokens?: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string; signature?: string; provider?: ProviderType }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_use_delta"; index: number; partialJson: string }
  | { type: "tool_use_stop"; index: number }
  | { type: "message_delta"; stopReason: CanonicalStopReason; usage?: TokenUsage }
  | { type: "message_stop" }
  | { type: "error"; message: string };

export interface ModelPricing {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
}

export interface CandidateRef {
  provider: string;
  model: string;
}

export interface RoutingDecision {
  profile: string;
  tier: RoutingTier;
  specialist?: SpecialistKind;
  source: DecisionSource;
  reason: string;
  decisionMs: number;
  cacheSticky: boolean;
  escalated: boolean;
  cascadeRetried?: boolean;
  riskScore?: number;
  selfHandled: boolean;
  selfAnswer?: string;
  failovers: number;
  selectedProvider: string;
  selectedModel: string;
  sessionId: string;
  estimatedInputTokens: number;
}
