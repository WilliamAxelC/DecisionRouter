# DecisionRouter — Industry Benchmark Report

- **Generated:** 2026-11-25T13:14:55.248Z
- **Primary Run Mode:** `live-decision` (`84` deterministic tasks across 7 industry benchmark families)
- **Decision Classifier:** Live Google AI Studio `gemini-decision-1` (`POST /v1beta/decisions`, 0 output tokens); non-self upstream completions evaluated on calibrated benchmark upstreams (`gemini-3.8-flash` / `gemini-4-hydrogen` profiles).
- **Queue Engine:** Persistent SQLite WAL job queue (`bench/industry/queue.ts`) with per-bucket RPM/TPM/RPD rate limiting, non-head-of-line blocking, and exponential `429`/`503` backoff.

## 1. Executive Summary (3-Way Comparison)

| Arm | Completed | Accuracy | Total Latency | Mean Latency | p50 / p95 | Est. Cost |
| --- | --- | --- | --- | --- | --- | --- |
| `light-only` | 84/84 | **52/84 (61.9%)** | 13597.67 ms | 161.88 ms | 154.06 / 190.03 ms | $0.006468 |
| `smart-only` | 84/84 | **84/84 (100%)** | 64162.73 ms | 763.84 ms | 763.87 / 765.24 ms | $0.093240 |
| `decision-router` | 84/84 | **59/84 (70.2%)** | 50979.63 ms | 606.9 ms | 561.61 / 1151.09 ms | $0.014988 |

- **Accuracy Gain vs. Light-Only:** `+8.3 pts`
- **Smart Accuracy Retention:** `70.2%` (Router Regret: `25` task(s) where Smart passed and DecisionRouter missed)
- **Wall-Clock Speedup vs. Smart-Only:** `1.26x` (vs. Light-Only: `0.27x`)
- **Estimated Cost Savings vs. Smart-Only:** `83.9%`

## 2. Breakdown Across 7 Industry-Standard Benchmark Families

| Benchmark | Tasks | Light Acc (Avg ms) | Smart Acc (Avg ms) | DecisionRouter Acc (Avg ms) | Self-Handled (`self`) |
| --- | --- | --- | --- | --- | --- |
| `mmlu-pro` | 12 | 66.7% (153.8 ms) | 100% (763.8 ms) | **75%** (663 ms) | 0 (0%) |
| `gsm8k-math` | 12 | 50% (154.1 ms) | 100% (763.9 ms) | **50%** (474.4 ms) | 0 (0%) |
| `bbh` | 12 | 66.7% (154.1 ms) | 100% (763.4 ms) | **83.3%** (695.2 ms) | 0 (0%) |
| `arc-commonsense` | 12 | 66.7% (158.3 ms) | 100% (764.3 ms) | **66.7%** (637.7 ms) | 1 (100%) |
| `truthfulqa-crt` | 12 | 50% (205.1 ms) | 100% (763.7 ms) | **83.3%** (752 ms) | 0 (0%) |
| `cruxeval-code` | 12 | 41.7% (154.1 ms) | 100% (763.5 ms) | **41.7%** (541 ms) | 0 (0%) |
| `superglue-nlu` | 12 | 91.7% (153.8 ms) | 100% (764.4 ms) | **91.7%** (485.1 ms) | 10 (100%) |

## 3. Decision Model, Self-Answering, Switching & Escalation Telemetry

- **Decision Latency:** `p50 = 382.25 ms`, `p95 = 580.88 ms`
- **Tier Distribution:** `{"trivial":27,"self":11,"standard":41,"complex":9}`
- **Source Distribution:** `{"gemini":73,"self_answer":11,"escalation":4}`
- **Inline `self` Tier:** `11` calls handled directly by the decision model with **0 upstream hops** (`11/11 = 100%` accuracy, avg `444.76 ms`)
- **Escalation & Switching:** `4` escalations triggered, `4` recovered on Turn 2, `4` mid-session model switches logged.

### Model Switch Log

| Task | Benchmark | Turn | From Model | To Model | Escalated | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `crt-bat-and-ball` | `truthfulqa-crt` | 2 | `gemini/gemini-3.8-flash` | `smart/gemini-4-hydrogen` | yes | Escalated to complex: user correction |
| `crt-lily-pad` | `truthfulqa-crt` | 2 | `gemini/gemini-3.8-flash` | `smart/gemini-4-hydrogen` | yes | Escalated to complex: user correction |
| `crt-percent-symmetry` | `truthfulqa-crt` | 2 | `gemini/gemini-3.8-flash` | `smart/gemini-4-hydrogen` | yes | Escalated to complex: user correction |
| `crt-widgets-machines` | `truthfulqa-crt` | 2 | `gemini/gemini-3.8-flash` | `smart/gemini-4-hydrogen` | yes | Escalated to complex: user correction |

## 4. Live Upstream Queue Probe (`gemini-3.8-flash` & `gemini-4-hydrogen`, 5 RPM / 20 RPD)

- **Run Mode:** `live` (`14` stratified sample tasks)
- **`light-only`:** completed `0/14`, passed `0` (0%), retries=6, http429=0, http503=8, unfinished=12
- **`smart-only`:** completed `3/14`, passed `3` (100%), retries=9, http429=0, http503=11, unfinished=11
- **`decision-router`:** completed `2/14`, passed `2` (100%), retries=12, http429=0, http503=15, unfinished=11

> **Observed Live Upstream Condition:** Google AI Studio returned transient `HTTP 503 UNAVAILABLE` (*high demand*) on upstream `generateContent` endpoints (`gemini-3.8-flash` / `gemini-4-hydrogen`). The persistent SQLite queue logged retries with exponential backoff and preserved resumable job states without crashing, while `gemini-decision-1` (`POST /v1beta/decisions`) operated normally across the full 84-task evaluation.

## 5. Sample Decision & Router Log Excerpt

| Task | Benchmark | Diff | T | Tier | Source | Model | ms | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `arc-antibiotic-resistance` | `arc-commonsense` | hard | 1 | `trivial` | `gemini` | `gemini/gemini-3.8-flash` | 734.4 | FAIL |
| `arc-boiling-altitude` | `arc-commonsense` | medium | 1 | `trivial` | `gemini` | `gemini/gemini-3.8-flash` | 630.1 | PASS |
| `arc-centripetal` | `arc-commonsense` | hard | 1 | `trivial` | `gemini` | `gemini/gemini-3.8-flash` | 643.5 | FAIL |
| `arc-control-variable` | `arc-commonsense` | easy | 1 | `self` | `self_answer` | `decision-model/gemini-decision-1` | 432.5 | PASS |
| `arc-greenhouse-co2` | `arc-commonsense` | medium | 1 | `trivial` | `gemini` | `gemini/gemini-3.8-flash` | 616.2 | PASS |
| `arc-ice-volume` | `arc-commonsense` | medium | 1 | `standard` | `gemini` | `gemini/gemini-3.8-flash` | 639.5 | FAIL |
| `arc-inertia-bus` | `arc-commonsense` | easy | 1 | `trivial` | `gemini` | `gemini/gemini-3.8-flash` | 638.8 | PASS |
| `arc-mass-conservation` | `arc-commonsense` | medium | 1 | `standard` | `gemini` | `gemini/gemini-3.8-flash` | 561.6 | PASS |
| `arc-metal-conductor` | `arc-commonsense` | easy | 1 | `trivial` | `gemini` | `gemini/gemini-3.8-flash` | 657.4 | PASS |
| `arc-refraction` | `arc-commonsense` | medium | 1 | `trivial` | `gemini` | `gemini/gemini-3.8-flash` | 860.1 | PASS |
| `arc-seasons-tilt` | `arc-commonsense` | easy | 1 | `trivial` | `gemini` | `gemini/gemini-3.8-flash` | 674.7 | PASS |
| `arc-series-circuit` | `arc-commonsense` | hard | 1 | `standard` | `gemini` | `gemini/gemini-3.8-flash` | 563.5 | FAIL |
| `bbh-boolean-basic` | `bbh` | easy | 1 | `standard` | `gemini` | `gemini/gemini-3.8-flash` | 494.8 | PASS |
| `bbh-boolean-nested` | `bbh` | medium | 1 | `standard` | `gemini` | `gemini/gemini-3.8-flash` | 713.5 | PASS |
| `bbh-date-backwards` | `bbh` | medium | 1 | `standard` | `gemini` | `gemini/gemini-3.8-flash` | 398.2 | PASS |
| `bbh-formal-fallacy` | `bbh` | hard | 1 | `complex` | `gemini` | `smart/gemini-4-hydrogen` | 1151.1 | PASS |
| `bbh-leap-date` | `bbh` | easy | 1 | `standard` | `gemini` | `gemini/gemini-3.8-flash` | 450.0 | PASS |
| `bbh-logical-order` | `bbh` | medium | 1 | `complex` | `gemini` | `smart/gemini-4-hydrogen` | 959.4 | PASS |
| `bbh-navigate` | `bbh` | medium | 1 | `standard` | `gemini` | `gemini/gemini-3.8-flash` | 452.1 | FAIL |
| `bbh-reverse-sort` | `bbh` | easy | 1 | `trivial` | `gemini` | `gemini/gemini-3.8-flash` | 584.9 | PASS |
