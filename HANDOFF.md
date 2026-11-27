# Handoff — DecisionRouter

## Last updated
- Date: 2026-11-28
- Agent/model: Antigravity execution agent
- Branch @ commit: `main` (added first-class `thinkingLevel` effort routing & switched live hard suite to `gemini-4-hydrogen@LOW` vs `@XHIGH`)

## Current state
- **DecisionRouter v2 + Gemini Reasoning-Effort Routing** implemented in TypeScript (Node 22 + Hono + `node:sqlite`) and documented in [README.md](README.md), [DESIGN.md](DESIGN.md), and [CHANGELOG.md](CHANGELOG.md):
  - Tier candidates accept `thinkingLevel` (`MINIMAL` | `LOW` | `MEDIUM` | `HIGH` | `XHIGH`) emitted to `generationConfig.thinkingConfig.thinkingLevel` in [gemini-adapter.ts](src/providers/gemini-adapter.ts) and surfaced via `X-Router-Thinking-Level`.
  - Cascade retry and candidate deduplication distinguish `(provider, model, thinkingLevel)` cleanly so `LOW -> XHIGH` upgrades work on a single model without invalidating KV prefix caches.
- **Hard Real-World Live Benchmark Suite (`bench/hard/`)** switched to `pnpm bench:hard:effort` (**`gemini-4-hydrogen@LOW` vs `gemini-4-hydrogen@XHIGH`**) across all **80 real unsaturated tasks** interleaved round-robin across all 9 public benchmarks:
  - Reuses the `80/80` cached `gemini-decision-1` multi-probe classifications via `--seed-decisions` into `data/benchmarks/hard-suite/effort-bench.db` (previous `3.8-flash` vs `4-hydrogen` snapshot preserved at `data/benchmarks/hard-suite/hard-bench.db` and `flash-vs-hydrogen-report.md`).
  - Fixed `day_calls` accounting (only `HTTP 200` consumes daily cap; `503`/`429` never falsely exhaust local quota), UTC midnight rollover wait, and `<solution>...</solution>` extraction in `gradeLiveBenchExact`.
- **Verified checks passing (post-final code edit):**
  - `pnpm typecheck` and `pnpm build`: exit code 0.
  - `pnpm test` (`vitest run`): **7 test files passed, 31 tests passed**.
- Local gitignored `.env`, `config.yaml` (updated tiers to `gemini-4-hydrogen@LOW` / `@XHIGH`), and `.venv-bench/` configured cleanly.

## In progress
- Background live daemon (`pnpm bench:hard:effort -- --notify`) draining the 80-task round-robin suite across `gemini-4-hydrogen@LOW` and `gemini-4-hydrogen@XHIGH` (`data/benchmarks/hard-suite/effort-runner.log`), automatically sending a `#worker-ping` notification upon completion.

## Next steps
- Check `pnpm bench:hard:effort -- --status` or read [HARD_BENCHMARK_REPORT.md](HARD_BENCHMARK_REPORT.md) once the background daemon completes (shares `80 RPD` pool across both effort levels -> ~2 days for all 80 pairs, with all 9 families evenly populated along the way).

## Waiting on the user
- None.

## Build, test, deploy
- Install: `pnpm install`
- Typecheck: `pnpm typecheck`
- Build: `pnpm build`
- Test: `pnpm test`
- Effort benchmark status / resume: `pnpm bench:hard:effort -- --status` / `pnpm bench:hard:effort -- --notify`
- Structural & trap benchmark: `pnpm bench`
- Pareto benchmark: `pnpm bench:pareto`

## Gotchas
- Running `LOW` and `XHIGH` on `gemini-4-hydrogen` shares the single `20 RPD/key` (`80 RPD` total) daily quota across both effort arms (`~2` days for `160` total generations across 80 tasks), vs independent daily pools for separate model IDs.
- Upstream free-tier Gemini uses `:streamGenerateContent?alt=sse` in `bench/hard/resilient-client.ts` because Node `undici` rejects slow thinking responses on non-streaming `:generateContent` with `UND_ERR_HEADERS_TIMEOUT`.
- Uses Node 22 built-in `node:sqlite` (`DatabaseSync`), which emits a harmless Node experimental warning on startup.
