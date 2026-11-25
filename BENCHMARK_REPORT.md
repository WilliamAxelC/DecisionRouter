# DecisionRouter v2 — Calibrated Benchmark & Pareto Report

- **Generated:** 2026-11-25T15:58:35.907Z
- **Decision Classifier:** Live Google AI Studio `gemini-decision-1` (`POST /v1beta/decisions`, multi-probe single prefill pass: `error_risk` + `needs_reasoning` + `difficulty` 0–4 score + `user_is_correcting` + dual-gated `self_answer`, 0 output tokens).
- **Workloads:** 84-task 7-family Industry Suite (`mmlu-pro`, `gsm8k-math`, `bbh`, `arc-commonsense`, `truthfulqa-crt`, `cruxeval-code`, `superglue-nlu`) **+** 21-task unseen Held-Out Validation Set **+** Structural Agent/Protocol Suite.

## 1. v1 → v2 Head-to-Head Improvement (84-Task Live `gemini-decision-1`)

| Metric | Light-Only (`3.8-flash`) | Smart-Only (`4-hydrogen`) | **v1 Router** (`4-way argmax`) | **v2 Router** (`auto:quality` multi-probe) |
| --- | --- | --- | --- | --- |
| Overall Accuracy | 51/84 (60.7%) | 84/84 (100%) | 59/84 (70.2%) | **84/84 (100%)** |
| Accuracy Gain vs. Light | — | +39.3 pts | +8.3 pts | **+39.3 pts** |
| Smart Accuracy Retention | 60.7% | 100.0% | 70.2% | **100%** |
| Router Regret (tasks missed) | 32 | 0 | 25 | **0** |
| Inline `self` Tier (0 upstream hops) | 0 | 0 | 11 (100%) | **38 (100%)** |
| Escalation Recovery (Turn 2) | 0/4 | — | 4/4 | **0/0** |
| Est. Cost (84 tasks) | $0.006468 | $0.093240 | $0.014988 (83.9% saved) | **$0.047951 (48.6% saved)** |
| Realistic Thinking-Model Speedup (1.2s Flash / 15s Hydrogen) | — | 1.00x (1260s) | — | **1.84x** (self=38, light=3, high=43) |

## 2. v2 Breakdown Across All 7 Industry Benchmarks (`auto:quality`)

| Benchmark | N | Light Acc | Smart Acc | v2 DecisionRouter Acc | Self-Handled (`self`) |
| --- | --- | --- | --- | --- | --- |
| `mmlu-pro` | 12 | 66.7% | 100% | **100%** | 10 (100%) |
| `gsm8k-math` | 12 | 50% | 100% | **100%** | 0 (0%) |
| `bbh` | 12 | 58.3% | 100% | **100%** | 1 (100%) |
| `arc-commonsense` | 12 | 66.7% | 100% | **100%** | 10 (100%) |
| `truthfulqa-crt` | 12 | 50% | 100% | **100%** | 7 (100%) |
| `cruxeval-code` | 12 | 41.7% | 100% | **100%** | 0 (0%) |
| `superglue-nlu` | 12 | 91.7% | 100% | **100%** | 10 (100%) |

## 3. Empirical Pareto Frontier (`riskScore` Threshold Sweep on Live `gemini-decision-1`)

Measured from a single live multi-probe `gemini-decision-1` pass (`riskScore = 0.40*error_risk + 0.35*needs_reasoning + 0.25*(difficulty/4)`, dual-gated `self` at `selfConfidence >= 0.85` & `riskScore < 0.38`):

| `highRiskThreshold` (τ) | `self` / `light` / `high` | Accuracy | Regret | Cost Savings vs Smart | Realistic Thinking Speedup |
| --- | --- | --- | --- | --- | --- |
| 0.20 | 39 / 1 / 44 | **84/84 (100%)** | 0 | 47.5% | 1.8x (698.42s) |
| 0.25 | 39 / 2 / 43 | **84/84 (100%)** | 0 | 48.6% | 1.84x (684.62s) |
| 0.30 | 39 / 3 / 42 | **84/84 (100%)** | 0 | 49.8% | 1.88x (670.82s) |
| 0.35 | 39 / 5 / 40 | **84/84 (100%)** | 0 | 52% | 1.96x (643.22s) |
| 0.40 | 39 / 6 / 39 | **83/84 (98.8%)** | 1 | 53.1% | 2x (629.42s) |
| 0.50 | 39 / 11 / 34 | **81/84 (96.4%)** | 3 | 58.6% | 2.25x (560.42s) |
| 0.60 | 39 / 20 / 25 | **78/84 (92.9%)** | 6 | 68.6% | 2.89x (436.22s) |
| 0.70 | 39 / 28 / 17 | **73/84 (86.9%)** | 11 | 77.4% | 3.87x (325.82s) |

## 4. Out-of-Sample Generalization: 21-Task Unseen Held-Out Validation Set

Evaluated on 21 brand-new tasks (3 per benchmark family) never used in threshold calibration:

| Profile | Light Acc | Smart Acc | **Router Acc** | Regret | Self-Handled | Escalations | Cost Savings | Realistic Speedup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `auto:quality` | 57.1% | 100% | **100%** | 0 | 9 (100%) | 0/0 | 42.9% | 1.66x |
| `auto:balanced` | 57.1% | 100% | **100%** | 0 | 9 (100%) | 0/0 | 51.8% | 1.96x |
| `auto:eco` | 57.1% | 100% | **90.5%** | 2 | 11 (100%) | 0/0 | 70.2% | 3.06x |

## 5. Structural Hardening Audit (`pnpm bench` — Context Traps, Cache Economics, Stress & MCP)

- **Short-Follow-Up Context Traps:** **5/5 (100%)** survived (up from 1/5 = 20% in v1 via `contextInertiaEnabled`).
- **Agent Trajectories (5 loops, 29 steps):** cache-sticky rate `95.2%`, escalation recall `100%`, `79.99%` savings vs Opus.
- **Quota & Failover Stress (30 requests):** `0` user-facing errors, `10` failovers, `p50=0.15ms`.
- **[`PASS`] Gemini MCP JSON Schema sanitization:** Unsupported JSON Schema keywords stripped before Gemini call.
- **[`PASS`] Anthropic thinking signature isolation:** Preserved for Anthropic upstream; stripped cleanly for OpenAI and Gemini.
- **[`PASS`] Anthropic cache_control breakpoint passthrough:** cache_control breakpoints preserved through Canonical IR.
- **[`PASS`] Cross-protocol Anthropic SSE tool_use lifecycle:** Valid 9-frame Anthropic SSE lifecycle emitted.
