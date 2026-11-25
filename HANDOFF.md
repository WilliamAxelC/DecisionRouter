# Handoff — DecisionRouter

## Last updated
- Date: 2026-11-25
- Agent/model: Antigravity execution agent
- Branch @ commit: `main` (DecisionRouter v2 upgrade, Pareto calibration & structural hardening)

## Current state
- **DecisionRouter v2** implemented in TypeScript (Node 22 + Hono + `node:sqlite`) and documented in [README.md](README.md), [DESIGN.md](DESIGN.md), and [CHANGELOG.md](CHANGELOG.md):
  - **Multi-probe single-pass `gemini-decision-1` (`POST /v1beta/decisions`)**: evaluates `error_risk` (`noul`), `needs_reasoning` (`noul`), `difficulty` (`score` 0–4), `user_is_correcting` (`noul`), and `self_answer` (`choice`, including JSON-template extraction) in one zero-output-token prefill pass; combines into `riskScore = 0.40*error_risk + 0.35*needs_reasoning + 0.25*(difficulty/4)`.
  - **Routing profiles & `<1ms` pre-gate**: configurable `auto:quality`, `auto:balanced`, and `auto:eco` profiles via [config.example.yaml](config.example.yaml), deterministic `<1ms` trivial ping/greeting bypass (`source: "pre_gate"`), and dual-gated inline `"self"` tier (`selfAnswerConfidence >= selfConfidenceMin && riskScore < selfMaxRisk`).
  - **Hardened escalation & cascade suite**: deterministic triggers (`consecutiveToolErrors >= 2`, `repeatedToolLoop`, `editFailOscillation`, regex `userCorrectionSignal`), `gemini-decision-1` subtle pushback (`user_is_correcting >= 0.65`), sticky escalation floor (`escalationLockTurns`), short-follow-up context-trap inertia (`contextInertiaEnabled`), and non-streaming structural/decision cascade retry (`X-Router-Cascade-Retried`).
  - **Cross-protocol & MCP hardening**: Gemini MCP JSON Schema sanitizer (`$schema`, `$id`, `$defs`, `definitions`, `additionalProperties`, nullable `anyOf`/`oneOf`, empty `properties: {}`) and Anthropic `cache_control` breakpoint passthrough through Canonical IR.
- **Verified checks passing (post-final edit):**
  - `pnpm typecheck` and `pnpm build`: exit code 0.
  - `pnpm test` (`vitest run`): **6 test files passed, 25 tests passed** (`tests/router.test.ts`, `tests/protocols.test.ts`, `tests/integration.test.ts`, `tests/bench-smoke.test.ts`, `tests/text-eval-bench.test.ts`, `tests/industry-bench.test.ts`).
  - `pnpm bench`: Short-follow-up context traps **5/5 (100%)** survived; 5 agent loops **95.2%** cache-sticky rate, **100%** escalation recall, `79.99%` savings vs Opus; 30-request quota/failover stress **0** user errors; all **4/4** protocol audits `PASS`.
  - `pnpm bench:pareto` ([BENCHMARK_REPORT.md](BENCHMARK_REPORT.md), live Google AI Studio `gemini-decision-1` multi-probe + calibrated upstreams):
    - 84-task suite (`auto:quality`): **84/84 (100%)** accuracy with **0 regret** (up from v1 `70.2%` / 25 regret), **38/38 (100%)** inline `self`-handled, **48.6%** cost savings (`$0.047951` vs `$0.093240` Smart-Only), and **1.84x** realistic thinking speedup.
    - 21-task unseen held-out set (`bench/industry/heldout.ts`): `auto:quality` **100%** (`42.9%` saved, `1.66x`), `auto:balanced` **100%** (`51.8%` saved, `1.96x`), `auto:eco` **90.5%** (`70.2%` saved, `3.06x`).
- Local gitignored `.env` and `config.yaml` configured for live Google AI Studio 4-key rotation with permanent `401`/`403` auth quarantine and `503` backoff.

## In progress
- None.

## Next steps
- Re-run full live upstream `pnpm bench:industry:live` once Google AI Studio upstream `503 UNAVAILABLE` high-demand spikes on `gemini-3.8-flash` / `gemini-4-hydrogen` clear.
- Optionally add trajectory-level sustained-downgrade policy if `feature-loop-12step` cache vs model-switch cost trade-off is prioritized over `oscillating-cache-thrash-8step` stability.

## Waiting on the user
- None.

## Build, test, deploy
- Install: `pnpm install`
- Typecheck: `pnpm typecheck`
- Build: `pnpm build`
- Test: `pnpm test`
- Structural & trap benchmark: `pnpm bench`
- Pareto & 84+21 industry benchmark: `pnpm bench:pareto`
- Run dev: `pnpm dev`
- Docker: `docker compose up -d --build`

## Gotchas
- Uses Node 22 built-in `node:sqlite` (`DatabaseSync`), which emits a harmless Node experimental warning on startup.
- Google AI Studio `POST /v1beta/decisions` requires `type: "score"` questions to send `criteria` as a JSON array of 2–255 strings (`string[]`), not an object map (object maps return HTTP 400).
- Google AI Studio free tier does not provide zero-data-retention; by default `decisionModel.maxContextChars` trims classifier input to 1800 chars of the latest turn + structural metadata and never sends giant system prompts or full histories.
- Pre-stream failover only occurs before response streaming begins; mid-stream upstream failures surface as SSE error events.
