# DecisionRouter v2 — Hard Real-World Live Benchmark Report

- **Generated:** 2026-11-27T17:10:42.989Z
- **Dataset Scope:** 80 real unsaturated tasks across 9 public benchmarks (`BigCodeBench-Hard`, `AIME 2025`, `LiveBench Reasoning/Math/Data`, `SimpleQA Verified`, `IFEval`, `BFCL v4`, `MultiChallenge`)
- **Live Models:** Classifier `gemini-decision-1` (`POST /v1beta/decisions`) | Light `gemini-4-hydrogen@LOW` | Smart `gemini-4-hydrogen@XHIGH`
- **Live Completion Status:** Decision `80/80` | Light `0/80` | Smart `0/80` | **Paired Graded Pairs:** `0/80 (0.0%)`

> **Waiting for first completed Light + Smart + Decision pair.** Runner is actively draining queued jobs cleanly across API backoffs/cooldowns.

## 2. Per-Benchmark Breakdown (9 Real Families)

| Benchmark Family | Pairs Done | Light (`gemini-4-hydrogen@LOW`) | Smart (`gemini-4-hydrogen@XHIGH`) | Oracle Ceiling | `auto:quality` | `auto:balanced` | `auto:eco` | Avg `riskScore` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bigcodebench-hard` | 0/10 | 0% | **0%** | 0% | **0%** | 0% | 0% | 0.000 |
| `aime25` | 0/8 | 0% | **0%** | 0% | **0%** | 0% | 0% | 0.000 |
| `livebench-reasoning` | 0/8 | 0% | **0%** | 0% | **0%** | 0% | 0% | 0.000 |
| `livebench-math` | 0/8 | 0% | **0%** | 0% | **0%** | 0% | 0% | 0.000 |
| `livebench-data` | 0/8 | 0% | **0%** | 0% | **0%** | 0% | 0% | 0.000 |
| `simpleqa-verified` | 0/10 | 0% | **0%** | 0% | **0%** | 0% | 0% | 0.000 |
| `ifeval` | 0/10 | 0% | **0%** | 0% | **0%** | 0% | 0% | 0.000 |
| `bfcl-v4` | 0/10 | 0% | **0%** | 0% | **0%** | 0% | 0% | 0.000 |
| `multichallenge` | 0/8 | 0% | **0%** | 0% | **0%** | 0% | 0% | 0.000 |

## 3. Free API Resilience & Backoff Telemetry

| Model | Total Calls | HTTP 200 | HTTP 429 | HTTP 503 | Other/Timeout | Quarantined Keys |
| --- | --- | --- | --- | --- | --- | --- |
