# DecisionRouter Architecture & Design

## Overview

DecisionRouter is a local-first, cross-protocol LLM HTTP proxy that routes **each individual LLM request** (including each step inside an agentic tool loop) to the cheapest model tier capable of completing that step reliably, using Google AI Studio's free Gemini tier as a fast decision classifier backed by deterministic heuristics and prompt-cache stickiness.

## Switching Granularity

| Level | Supported? | Behavior |
| --- | --- | --- |
| Session | Yes (stickiness) | Prefix hash / `X-Router-Session` tracks active model & cached tokens |
| User turn | Yes | Re-classified cleanly on new user prompts |
| **Per agent step (LLM call)** | **Primary unit** | Every tool-loop iteration is an HTTP request evaluated independently |
| Mid-stream token | No | Avoided intentionally; breaks provider KV-cache reuse |

## Decision Pipeline

For every incoming `/v1/chat/completions` or `/v1/messages` request:

1. **Direct Passthrough & Header Overrides (`<1ms`, 0 quota)**:
   - `direct/<provider>/<model>` or concrete configured model names pass directly without classification.
   - `X-Router-Model: <provider>/<model>` or `X-Router-Tier: <tier>` overrides routing per request.
2. **Feature Extraction (`<1ms`)**:
   - Computes estimated token counts, attachment flags (vision), tool count/names, tool-loop continuation state, consecutive tool errors, repeated identical tool calls, user correction pushback, and a compact trimmed snippet (`maxContextChars`, default `1800` chars) omitting giant system prompts and old file dumps.
3. **Reactive Escalation**:
   - Automatically bumps tier `+1` (bypassing cache stickiness) when `consecutiveToolErrors >= 2`, a repeated identical tool call loop is detected, or the user sends a short correction signal (`"no"`, `"that's wrong"`, `"still failing"`, etc.).
4. **Hard Capability Gates**:
   - Image attachments route to `specialist:vision`; prompts `>= 80k` estimated tokens route to `specialist:long_context`.
5. **Mid-Loop Cache-Stickiness Fast-Path (`<1ms`, 0 quota)**:
   - Active tool-loop continuations stay on the warm session model when healthy instead of spending free-tier classifier RPM.
   - On new user turns where the classifier wants to downgrade, `shouldStayCacheSticky()` compares `cached_read_cost(active) + delta + output` vs `full_uncached_prefill(cheaper) + output` and keeps the warm model unless switching saves at least 5%.
6. **Gemini Free-Tier Decision Waterfall, Inline `"self"` Tier & Silent Fallback**:
   - Checks short-TTL decision cache first.
   - Calls Google AI Studio `generateContent` with `responseMimeType: "application/json"`, strict enum `responseSchema`, `temperature: 0`, and `timeoutMs: 600`.
   - When `allowSelfAnswer` is enabled (and the request has no tools, no images, is not a tool-loop continuation, and is within `selfAnswerMaxInputTokens`), the classifier may choose `tier: "self"` and populate `directAnswer` to handle pure decision/triage/classification tasks inline with **zero upstream hops** and `$0.00` upstream cost.
   - Waterfalls across `(model, apiKey)` pairs (default: `gemini-2.5-flash-lite` -> `gemini-2.5-flash`), enforcing local sliding-window RPM and UTC daily RPD tracking plus 60s cooldown on `429`.
   - Falls back silently to deterministic heuristics on timeout or exhausted quota so client requests never fail.
7. **Upstream Translation & Pre-Stream Failover**:
   - Translates Canonical IR to OpenAI (`/chat/completions`), Anthropic (`/messages`), or Gemini native (`:generateContent` / `:streamGenerateContent?alt=sse`), including streaming SSE and tool calls.
   - Strips foreign `thinking` blocks across providers while preserving Anthropic `thinking` + `signature` when targeting Anthropic.
   - Retries pre-stream `408`/`429`/`5xx`/network errors across ordered tier candidates with a per-model circuit breaker.
