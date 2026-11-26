# Handoff — DecisionRouter

## Last updated
- Date: 2026-11-26
- Agent/model: Antigravity execution agent
- Branch @ commit: `main` (added Hard Real-World Live Benchmark Suite `bench/hard/` & launched resilient background run)

## Current state
- **DecisionRouter v2** implemented in TypeScript (Node 22 + Hono + `node:sqlite`) and documented in [README.md](README.md), [DESIGN.md](DESIGN.md), and [CHANGELOG.md](CHANGELOG.md).
- **Hard Real-World Live Benchmark Suite (`bench/hard/`, `pnpm bench:hard`)** implemented and hydrated with **80 real unsaturated tasks** across **9 public benchmarks**:
  - `bigcode/bigcodebench-hard` (10 tasks executed in isolated `.venv-bench` Python unittest sandbox)
  - `math-ai/aime25` (8 tasks), `livebench/reasoning` (8), `livebench/math` (8), `livebench/data_analysis` (8)
  - `google/simpleqa-verified` (10), `google/IFEval` (10, deterministic verifier), `BFCL_v4_live_multiple` (10, tool calling), `ScaleAI/MultiChallenge` (8, multi-turn)
  - Backed by `ResilientGeminiPool` SQLite persistence (`data/benchmarks/hard-suite/hard-bench.db`), permanent `401`/`403` auth quarantine, `429` daily vs RPM backoff, shared per-model `503` probe cooldowns, and streaming SSE (`:streamGenerateContent?alt=sse`) to prevent thinking-model header timeouts.
  - Live progress & completed comparisons written progressively to [HARD_BENCHMARK_REPORT.md](HARD_BENCHMARK_REPORT.md) and `data/benchmarks/hard-suite/progress.json`.
- **Verified checks passing (post-final code edit):**
  - `pnpm typecheck` and `pnpm build`: exit code 0.
  - `pnpm test` (`vitest run`): **7 test files passed, 30 tests passed** (includes `tests/hard-bench.test.ts` covering real `.venv-bench` Python unittest execution, AIME/LiveBench/IFEval/BFCL/SimpleQA graders, backoff math, SQLite quarantine, and Oracle/Regret/Bonus reporting).
  - `pnpm bench`: Short-follow-up traps `5/5`, agent loops `95.2%` cache-sticky / `100%` escalation recall, all `4/4` protocol audits `PASS`.
  - `pnpm bench:pareto` ([BENCHMARK_REPORT.md](BENCHMARK_REPORT.md)): 84-task v2 `auto:quality` `100%` / `0` regret (`48.6%` saved, `1.84x` speedup); 21-task held-out `auto:quality` `100%`, `auto:balanced` `100%`, `auto:eco` `90.5%`.
- Local gitignored `.env`, `config.yaml`, and `.venv-bench/` configured cleanly.

## In progress
- Background live runner (`pnpm bench:hard --notify`) actively draining 80 live tasks (`gemini-decision-1`, `gemini-3.8-flash`, `gemini-4-hydrogen`) across API rate limits & `503` backoffs, logging to `data/benchmarks/hard-suite/runner.log` and updating `HARD_BENCHMARK_REPORT.md`.

## Next steps
- Check `pnpm bench:hard --status` or read [HARD_BENCHMARK_REPORT.md](HARD_BENCHMARK_REPORT.md) once the background daemon finishes (or wakes up from daily/503 cooldowns).
- If restarting after reboot/interruption, resume cleanly via `pnpm bench:hard --notify` (SQLite picks up from exact saved checkpoints).

## Waiting on the user
- None.

## Build, test, deploy
- Install: `pnpm install`
- Typecheck: `pnpm typecheck`
- Build: `pnpm build`
- Test: `pnpm test`
- Hard live benchmark status / resume: `pnpm bench:hard --status` / `pnpm bench:hard --notify`
- Structural & trap benchmark: `pnpm bench`
- Pareto & 84+21 industry benchmark: `pnpm bench:pareto`
- Run dev: `pnpm dev`

## Gotchas
- `bigcodebench-hard` unit tests execute in gitignored `.venv-bench/bin/python` (`uv` env with `pytest`, `numpy`, `pandas`, `scipy`, `matplotlib`, `requests`, `beautifulsoup4`, `scikit-learn`, `sympy`, `pillow`).
- Upstream free-tier Gemini uses `:streamGenerateContent?alt=sse` in `bench/hard/resilient-client.ts` because Node `undici` rejects slow thinking responses on non-streaming `:generateContent` with `UND_ERR_HEADERS_TIMEOUT`.
- Uses Node 22 built-in `node:sqlite` (`DatabaseSync`), which emits a harmless Node experimental warning on startup.
- Google AI Studio `POST /v1beta/decisions` requires `type: "score"` questions to send `criteria` as a JSON array of 2–255 strings (`string[]`), not an object map.
