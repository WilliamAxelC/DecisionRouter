# Handoff — DecisionRouter

## Last updated
- Date: 2026-11-25
- Agent/model: Antigravity execution agent
- Branch @ commit: `main` (pushed initial MVP + industry benchmark report)

## Current state
- Full MVP implemented in TypeScript (Node 22 + Hono + `node:sqlite`) covering OpenAI & Anthropic ingress, OpenAI/Anthropic/Gemini upstream translation (JSON & SSE streaming + tools + images + thinking block handling), Gemini free-tier decision waterfall + native `POST /v1beta/decisions` (`gemini-decision-1`) + inline `"self"` tier (`allowSelfAnswer`), multi-key rotation with permanent `401`/`403` auth quarantine, cache-aware stickiness, escalation, circuit-breaker failover, SQLite persistence, `/_router` dashboard, CLI, and Docker setup.
- Verified passing: `pnpm typecheck`, `pnpm build`, and `pnpm test` (**6 test files, 22 tests**).
- Generated [BENCHMARK_REPORT.md](BENCHMARK_REPORT.md) from 84-task live `gemini-decision-1` evaluation (`59/84 = 70.2%` vs Light `61.9%` vs Smart `100%`, `1.26x` faster and `83.9%` cheaper than Smart, `11/11 = 100%` inline `self` accuracy, `4/4` Turn-2 escalation recoveries) + 14-task 4-key live queued probe (`http429=0`, `3/3` `gemini-4-hydrogen` and `2/2` `decision-router` completions passed amid upstream Google AI Studio `503` high demand).
- Three benchmark suites available:
  - `bench/` (`pnpm bench`): routing/cache-economics/stress/MCP protocol audit suite.
  - `bench/text-eval/` (`pnpm bench:text`, `pnpm bench:text:live`): 30-task 3-way text-out evaluation.
  - `bench/industry/` (`pnpm bench:industry`, `pnpm bench:industry:live-decision`, `pnpm bench:industry:live`): 84-task 7-family industry benchmark suite with persistent rate-limit-aware SQLite queue and `BENCHMARK_REPORT.md` generator.
- Local gitignored `.env` and `config.yaml` configured for live Google AI Studio 4-key rotation (`gemini-decision-1` Decisions API at 200 RPM / 50k TPM / 10k RPD; `gemini-3.8-flash` low tier and `gemini-4-hydrogen` high tier at 20 RPM / 1M TPM / 80 RPD pool) with permanent `401`/`403` auth-error quarantine and zero-spamming `503` backoff.
- Verified `gemini-decision-1` live (`POST /v1beta/decisions`) for routing & inline `"self"` answers; `gemini-3.8-flash` and `gemini-4-hydrogen` were temporarily returning Google AI Studio `503 UNAVAILABLE` ("high demand") during the live benchmark attempt.
- Added native `POST /v1beta/decisions` classifier path + Gemini `thought: true` part separation + `--sample` / per-model RPM pacing in `bench/text-eval/run.ts`.
- Known real-world gaps surfaced honestly by `pnpm bench`:
  - Short-follow-up context traps (4/5 drop when prefix is below stickiness size)
  - Mid-loop over-stickiness on sustained downgrades (`feature-loop-12step`: staying sticky on Sonnet costs more than a one-time switch to Gemini Flash, whereas `oscillating-cache-thrash-8step` proves stickiness beats cache thrashing)
  - Gemini MCP JSON Schema sanitization (`$schema`, `additionalProperties`, `anyOf`)
  - Anthropic `cache_control` breakpoint passthrough in `parseAnthropicRequest`

## In progress
- None.

## Next steps
- Re-run `pnpm bench:industry:live` once Google AI Studio upstream `503` high demand on `gemini-3.8-flash` / `gemini-4-hydrogen` clears (`--resume` via `data/benchmarks/live-full/queue.db` or fresh `--out-dir`).
- Tune `gemini-decision-1` routing criteria for `cruxeval-code` / `gsm8k-math` hard items to reduce `Router Regret` further.

## Waiting on the user
- None.

## Build, test, deploy
- Install: `pnpm install`
- Typecheck: `pnpm typecheck`
- Build: `pnpm build`
- Test: `pnpm test`
- Run dev: `pnpm dev`
- Docker: `docker compose up -d --build`

## Gotchas
- Uses Node 22 built-in `node:sqlite` (`DatabaseSync`), which emits a harmless Node experimental warning on startup.
- Google AI Studio free tier does not provide zero-data-retention; by default `decisionModel.maxContextChars` trims classifier input to 1800 chars of the latest turn + structural metadata and never sends giant system prompts or full histories.
- Pre-stream failover only occurs before response streaming begins; mid-stream upstream failures surface as SSE error events.
