# DecisionRouter

A local-first, cross-protocol LLM model router HTTP proxy (`OpenAI` + `Anthropic` endpoints) that routes every LLM step using Google AI Studio's free Gemini tier, prompt-cache stickiness, automatic error escalation, and pre-stream circuit-breaker failover.

## Features

- **Dual Wire Protocols**: Exposes `POST /v1/chat/completions`, `GET /v1/models`, and `POST /v1/messages` with full cross-provider translation (text, images, tool calls, streaming SSE, and safe thinking-block handling).
- **Per-Step Switching + Cache Stickiness**: Evaluates each agent step independently, stays sticky mid-tool-loop when prompt-cache reuse beats switching cost, and immediately escalates on consecutive tool errors, repeated tool loops, or user pushback.
- **Gemini Free-Tier Waterfall**: Sends only compact metadata + trimmed recent turn (`<=1800` chars) to `gemini-2.5-flash-lite` / `gemini-2.5-flash` with strict JSON schema output, local RPM/RPD tracking, multi-key rotation, and silent `<1ms` heuristic fallback on timeout/`429`.
- **Ordered Fallbacks + Circuit Breaker**: Pre-stream failover across multiple providers per tier (Anthropic, OpenAI, Gemini, Ollama/vLLM/LM Studio, or custom compatible APIs).
- **Observability**: `X-Router-*` headers on every response, SQLite decision/savings log (`node:sqlite`), CLI `stats` & `test-route`, and a built-in web dashboard at `/_router`.

## Quick Start

1. **Install & build** (requires Node 22+):
   ```bash
   pnpm install
   pnpm build
   ```

2. **Configure secrets and routing**:
   ```bash
   cp .env.example .env
   cp config.example.yaml config.yaml
   ```
   Set `GEMINI_API_KEY` (for the free decision model) plus keys for whichever upstream providers you want to route to (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or local Ollama).

3. **Start the proxy**:
   ```bash
   pnpm dev
   # or after build:
   pnpm start
   ```
   Endpoints:
   - OpenAI: `http://127.0.0.1:4000/v1/chat/completions`
   - Anthropic: `http://127.0.0.1:4000/v1/messages`
   - Dashboard: `http://127.0.0.1:4000/_router`

## Client Integration

### OpenAI SDK / Cursor / Generic Clients
Point base URL to `http://127.0.0.1:4000/v1` and set `model` to a routing profile:
- `auto` — balanced cost/quality routing (`trivial` → `frontier`)
- `auto:eco` — cost-minimizing (`trivial` → `complex`)
- `auto:coding` — coding-focused defaults
- `auto:max` — high-capability (`complex` → `frontier`)
- `direct/<provider>/<model>` — explicit passthrough (e.g. `direct/anthropic/claude-sonnet-4-6`)

### Claude Code / Anthropic SDK
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:4000"
export ANTHROPIC_AUTH_TOKEN="${ROUTER_AUTH_TOKEN:-local}"
```
Add an `intercepts` rule in `config.yaml` if you want hardcoded `claude-*` model names routed automatically:
```yaml
intercepts:
  - pattern: "claude-*"
    profile: "auto:coding"
```

### Per-Request Headers
- `X-Router-Tier: trivial | standard | complex | frontier` — force a specific tier
- `X-Router-Model: <provider>/<model>` — force a specific upstream model
- `X-Router-Session: <id>` — explicit session ID for prompt-cache stickiness

## CLI Commands

```bash
# Start proxy server
pnpm cli start --config config.yaml --port 4000

# Preview routing decision without sending an upstream LLM call
pnpm cli test-route "Fix the race condition in our distributed lock manager" --profile auto

# Print 24h SQLite stats summary
pnpm cli stats --hours 24
```

## Benchmarks

Run the real-world-adjacent benchmark suite (single-turn routing accuracy, short-follow-up context traps, 12-step cache-aware agent loops, free-tier quota/failover stress, and MCP/Anthropic protocol audits):

```bash
# Default simulated mode (no API keys required, $0 cost)
pnpm bench

# Pure heuristic + cache-sticky baseline (no Gemini classifier)
pnpm bench:heuristic

# Live Google AI Studio classifier mode (requires GEMINI_API_KEY; upstreams remain mocked = $0)
pnpm bench:live

# Filter by suite or emit JSON report
pnpm bench --suite agent --json --out data/bench-report.json

# General text-out LLM benchmark (Light-Only vs Smart-Only vs DecisionRouter: accuracy, speed, cost, router logs)
pnpm bench:text

# Live-model text-out benchmark (requires GEMINI_API_KEY + configured light/smart provider keys)
pnpm bench:text:live --limit 10 --light gemini/gemini-2.5-flash-lite --smart anthropic/claude-sonnet-4-6

# 84-task Industry Benchmark Suite (MMLU-Pro, GSM8K-Math, BBH, ARC, TruthfulQA/CRT, CruxEval, SuperGLUE)
# Uses a persistent SQLite rate-limit-aware job queue (non-blocking 429/503 backoff + resume)
pnpm bench:industry
pnpm bench:industry:live-decision
pnpm bench:industry:live
```

See [BENCHMARK_REPORT.md](BENCHMARK_REPORT.md) for the latest benchmark results.

## Docker

```bash
cp .env.example .env
cp config.example.yaml config.yaml
docker compose up -d --build
```
