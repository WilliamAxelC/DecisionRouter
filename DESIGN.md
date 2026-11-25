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
6. **Multi-Probe `gemini-decision-1`, Dual-Gated `"self"` Tier & Pre-Gates**:
   - `<1ms` Pre-gate handles trivial pings/greetings without spending decision quota.
   - Calls Google AI Studio `POST /v1beta/decisions` (`gemini-decision-1`, zero output tokens) with a single multi-probe prefill pass: `error_risk` (`noul`), `needs_reasoning` (`noul`), `difficulty` (`score`, 0–4), `user_is_correcting` (`noul` on multi-turn), and `self_answer` (`choice` when discrete options exist).
   - Combines probes into `riskScore = 0.40*error_risk + 0.35*needs_reasoning + 0.25*(difficulty/4)` and compares against profile thresholds (`auto:quality`, `auto:balanced`, `auto:eco`).
   - Dual-gates `"self"`: only answers inline (`0` upstream hops) when `self_answer.confidence >= selfConfidenceMin` AND `riskScore < selfMaxRisk`.
   - Falls back to `generateContent` waterfall or deterministic heuristics if needed.
7. **Smart Escalation, Context Inertia & Cascade Verification**:
   - Escalates immediately on `consecutiveToolErrors >= 2`, repeated tool loops, fuzzy `editFailOscillation`, regex pushback, or `user_is_correcting >= 0.65`, locking an escalation floor for `escalationLockTurns` turns.
   - Short-follow-up context-trap inertia preserves `complex`/`frontier` tier across short referential follow-ups.
   - Non-streaming structural/decision cascade verification retries failed light responses on a higher tier (`X-Router-Cascade-Retried: true`).
8. **Protocol Hardening & Upstream Failover**:
   - Preserves Anthropic `system` `cache_control` breakpoints and thinking signatures (`anthropic` only).
   - Recursively sanitizes messy MCP JSON Schemas (`$schema`, `additionalProperties`, nullable `anyOf`, empty `properties`) for Gemini `functionDeclarations`.
   - Retries pre-stream `408`/`429`/`5xx`/network errors across ordered tier candidates with per-model circuit breakers and permanent `401`/`403` key quarantine.
