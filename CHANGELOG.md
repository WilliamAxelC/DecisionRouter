# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial MVP of **DecisionRouter**: OpenAI (`/v1/chat/completions`, `/v1/models`) and Anthropic (`/v1/messages`) HTTP proxy with cross-protocol request/response/SSE translation across OpenAI, Anthropic, and Gemini upstreams.
- Google AI Studio free-tier Gemini decision classifier with compact metadata + trimmed turn extraction, local RPM/RPD quota waterfall across models/keys, short-TTL decision cache, and silent heuristic fallback.
- Cache-aware per-step switching (`shouldStayCacheSticky`), mid-tool-loop stickiness fast-path, and reactive escalation on consecutive tool errors, repeated tool loops, or user pushback.
- Ordered per-tier upstream fallback chains with pre-stream circuit breaker cooldowns.
- SQLite telemetry (`node:sqlite`), `X-Router-*` response headers, `/_router` web dashboard, CLI (`start`, `stats`, `test-route`), and Dockerfile / `docker-compose.yml`.
- Real-world-adjacent benchmark suite under `bench/` (`pnpm bench`, `pnpm bench:heuristic`, `pnpm bench:live`) evaluating single-turn routing, multi-turn context traps, true 1.25×/0.1× prompt-cache-aware agent loop trajectories, free-tier 429/latency stress, and MCP/Anthropic protocol audits.
- Inline `"self"` tier (`allowSelfAnswer`, `source: "self_answer"`, `X-Router-Self-Handled`, SQLite `self_handled` tracking) allowing the Gemini decision model to answer pure decision/triage tasks directly in one call with zero upstream hops.
- General text-out LLM benchmark suite under `bench/text-eval/` (`pnpm bench:text`, `pnpm bench:text:live`) comparing Light-Only vs Smart-Only vs DecisionRouter on accuracy, wall-clock task speed, cost, router regret, self-handling, escalation recovery, and JSONL switch/decision logs.
- Native Google AI Studio Decisions API (`POST /v1beta/decisions`) support for `gemini-decision-1` (including single-pass inline `self_answer` on discrete choices), Gemini `thought: true` separation in `gemini-adapter.ts`, and quota-safe `--sample` + per-model RPM pacing for live `text-eval` benchmarks.
- 84-task Industry-Standard Benchmark Suite (`bench/industry/`) spanning MMLU-Pro, GSM8K/MATH, BBH, ARC-Challenge, TruthfulQA/CRT, CruxEval-Code, and SuperGLUE-NLU backed by a persistent WAL SQLite rate-limit-aware job queue (`PersistentRateLimitQueue`) and generated `BENCHMARK_REPORT.md`.
- Multi-key `providers.<name>.apiKeys` pool with round-robin rotation, `429` cooldowns, and permanent `401`/`403` auth-error quarantine across both `GeminiDecisionClassifier` and `GeminiAdapter` (zero spamming).
- **v2 Routing & Escalation Upgrades**:
  - Calibrated multi-probe `POST /v1beta/decisions` scoring (`error_risk` + `needs_reasoning` `noul` probes, 0–4 `difficulty` `score` rubric, subtle pushback `user_is_correcting` `noul` probe, and dual-gated `self_answer`) mapped against profile risk thresholds (`auto:quality`, `auto:balanced`, `auto:eco`).
  - `<1ms` trivial greeting pre-gate (`source: "pre_gate"`), fuzzy `editFailOscillation` detection, sticky escalation floor (`escalationLockTurns`), short-follow-up context-trap inertia (`contextInertiaEnabled`), and non-streaming structural/decision cascade verification retries (`X-Router-Cascade-Retried`).
  - Gemini MCP JSON Schema sanitizer (`$schema`, `additionalProperties`, nullable `anyOf`/`oneOf`, empty `properties: {}`) and Anthropic `cache_control` system block passthrough.
  - 21-task unseen held-out validation set (`bench/industry/heldout.ts`) and Pareto calibration runner (`pnpm bench:pareto`).
- Hard Real-World Live Benchmark Suite (`bench/hard/`, `pnpm bench:hard`): 80 unsaturated tasks across 9 public datasets (`bigcode/bigcodebench-hard` executed in `.venv-bench` Python sandbox, `math-ai/aime25`, `livebench/reasoning|math|data_analysis`, `google/simpleqa-verified`, `google/IFEval`, `BFCL_v4_live_multiple`, `ScaleAI/MultiChallenge`) backed by `ResilientGeminiPool` SQLite backoff/quarantine state and generating `HARD_BENCHMARK_REPORT.md`.
- First-class Gemini reasoning-effort routing (`thinkingLevel: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | "XHIGH"`) on tier candidates (`src/config/schema.ts`, `src/providers/gemini-adapter.ts`, `src/router/engine.ts`, `X-Router-Thinking-Level` header), plus `pnpm bench:hard:effort` (`gemini-4-hydrogen@LOW` vs `gemini-4-hydrogen@XHIGH`) with round-robin 9-family interleaving and cached decision seeding.
