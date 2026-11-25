import type { ProviderType } from "../types/ir.js";
import { AnthropicAdapter } from "./anthropic-adapter.js";
import type { UpstreamAdapter } from "./base.js";
import { GeminiAdapter } from "./gemini-adapter.js";
import { OpenAIAdapter } from "./openai-adapter.js";

const adapters: Record<ProviderType, UpstreamAdapter> = {
  openai: new OpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  gemini: new GeminiAdapter(),
};

export function getUpstreamAdapter(type: ProviderType): UpstreamAdapter {
  return adapters[type];
}
