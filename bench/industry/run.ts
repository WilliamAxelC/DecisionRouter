#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../src/config/loader.js";
import type { RouterConfig } from "../../src/config/schema.js";
import { DecisionEngine } from "../../src/router/engine.js";
import { createApp } from "../../src/server.js";
import { DecisionStore, type RouterStatsSummary } from "../../src/storage/db.js";
import { gradeResponse } from "../text-eval/grader.js";
import {
  INDUSTRY_BENCHMARK_NAMES,
  INDUSTRY_TASKS,
  type IndustryBenchmarkName,
  type IndustryTask,
} from "./datasets.js";
import {
  buildIndustrySimConfig,
  startIndustryMockServers,
} from "./mock-llms.js";
import {
  PersistentRateLimitQueue,
  type QueueTelemetrySummary,
} from "./queue.js";
import { renderIndustryReportMarkdown } from "./report.js";

export type IndustryBenchMode = "simulated" | "live-decision" | "live";

export interface IndustryArmTaskOutcome {
  taskId: string;
  benchmark: IndustryBenchmarkName;
  difficulty: IndustryTask["difficulty"];
  turns: number;
  passed: boolean;
  turn1Passed: boolean;
  finalModel: string;
  totalMs: number;
  status: "completed" | "rate_limited_unfinished" | "failed";
}

export interface IndustryArmSummary {
  armName: "light-only" | "smart-only" | "decision-router";
  modelLabel: string;
  totalTasks: number;
  completedTasks: number;
  passedTasks: number;
  accuracyPct: number;
  totalLatencyMs: number;
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  estimatedCostUsd: number;
  sqliteStats: RouterStatsSummary;
  queueTelemetry: QueueTelemetrySummary;
  outcomes: IndustryArmTaskOutcome[];
}

export interface IndustryRouterLogEntry {
  timestamp: string;
  taskId: string;
  benchmark: IndustryBenchmarkName;
  difficulty: IndustryTask["difficulty"];
  turn: number;
  tier: string;
  source: string;
  selfHandled: boolean;
  escalated: boolean;
  cacheSticky: boolean;
  switchedFrom: string | null;
  selectedModel: string;
  decisionMs: number;
  upstreamMs: number;
  totalMs: number;
  reason: string;
  answerPreview: string;
  passed: boolean;
  httpStatus: number;
  lightPassed?: boolean;
  smartPassed?: boolean;
  routerRegret?: boolean;
}

export interface IndustrySwitchEvent {
  taskId: string;
  benchmark: IndustryBenchmarkName;
  turn: number;
  fromModel: string;
  toModel: string;
  reason: string;
  escalated: boolean;
}

export interface IndustryBenchmarkBreakdownRow {
  benchmark: IndustryBenchmarkName;
  count: number;
  lightAccPct: number;
  smartAccPct: number;
  routerAccPct: number;
  lightAvgMs: number;
  smartAvgMs: number;
  routerAvgMs: number;
  selfCount: number;
  selfAccPct: number;
}

export interface IndustryBenchmarkReport {
  runId: string;
  timestamp: string;
  mode: IndustryBenchMode;
  taskCount: number;
  arms: {
    lightOnly: IndustryArmSummary;
    smartOnly: IndustryArmSummary;
    decisionRouter: IndustryArmSummary;
  };
  comparisons: {
    accuracyDeltaVsLightPct: number;
    accuracyRetentionVsSmartPct: number;
    routerRegretCount: number;
    speedupVsSmart: number;
    speedupVsLight: number;
    costSavingsVsSmartPct: number;
  };
  benchmarkBreakdown: IndustryBenchmarkBreakdownRow[];
  routerLog: {
    entries: IndustryRouterLogEntry[];
    tierCounts: Record<string, number>;
    sourceCounts: Record<string, number>;
    selfHandledCount: number;
    selfHandledPassedCount: number;
    selfHandledAccuracyPct: number;
    selfHandledAvgMs: number;
    decisionP50Ms: number;
    decisionP95Ms: number;
    escalationCount: number;
    escalationRecoveredCount: number;
    switchEvents: IndustrySwitchEvent[];
    queueEventsSample: Array<{
      tsMs: number;
      jobId: string;
      eventType: string;
      modelBucket: string;
      detail: string;
    }>;
    logFilePath?: string;
    queueEventsFilePath?: string;
    reportFilePath?: string;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Number(sorted[idx].toFixed(2));
}

function extractResponseText(json: Record<string, unknown>): string {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const msg = (first.message ?? {}) as Record<string, unknown>;
  return typeof msg.content === "string" ? msg.content : "";
}

function selectStratifiedSample(
  tasks: IndustryTask[],
  sampleCount: number,
): IndustryTask[] {
  if (sampleCount >= tasks.length) return tasks;
  const buckets = INDUSTRY_BENCHMARK_NAMES.map((b) =>
    tasks.filter((t) => t.benchmark === b),
  );
  const picked: IndustryTask[] = [];
  let idx = 0;
  while (picked.length < sampleCount) {
    let added = false;
    for (const bucket of buckets) {
      if (idx < bucket.length && picked.length < sampleCount) {
        picked.push(bucket[idx]);
        added = true;
      }
    }
    if (!added) break;
    idx += 1;
  }
  return picked;
}

function configureQueueBuckets(
  queue: PersistentRateLimitQueue,
  config: RouterConfig,
  fastSimulated: boolean,
): void {
  const dm = config.decisionModel.models[0];
  if (dm) {
    queue.setBucketLimit("decision-router", {
      rpm: fastSimulated ? 1000 : Math.min(dm.rpm, 180),
      tpm: dm.tpm,
      rpd: dm.rpd,
    });
  }

  for (const [providerName, providerCfg] of Object.entries(config.providers)) {
    for (const [modelName, modelCfg] of Object.entries(providerCfg.models)) {
      queue.setBucketLimit(`${providerName}/${modelName}`, {
        rpm: fastSimulated ? 1000 : modelCfg.rpm ?? 60,
        tpm: modelCfg.tpm,
        rpd: modelCfg.rpd ?? 1000,
      });
    }
  }
}

async function runQueuedArm(opts: {
  armName: "light-only" | "smart-only" | "decision-router";
  modelParam: string;
  modelBucket: string;
  tasks: IndustryTask[];
  config: RouterConfig;
  queue: PersistentRateLimitQueue;
  maxAttempts: number;
  maxWaitSec: number;
  baseBackoffMs: number;
  liveLogging: boolean;
  baselineArmLogs?: {
    lightByTask?: Map<string, boolean>;
    smartByTask?: Map<string, boolean>;
  };
}): Promise<{
  summary: IndustryArmSummary;
  logs: IndustryRouterLogEntry[];
  switches: IndustrySwitchEvent[];
}> {
  const store = new DecisionStore(":memory:");
  const engine = new DecisionEngine(opts.config);
  const app = createApp({ config: opts.config, engine, store });

  const taskMap = new Map(opts.tasks.map((t) => [t.id, t]));
  const logs: IndustryRouterLogEntry[] = [];
  const switches: IndustrySwitchEvent[] = [];

  opts.queue.enqueue(
    opts.tasks.map((task) => ({
      id: `${opts.armName}:${task.id}`,
      arm: opts.armName,
      taskId: task.id,
      modelBucket: opts.modelBucket,
      payload: { taskId: task.id },
      maxAttempts: opts.maxAttempts,
    })),
  );

  const telemetry = await opts.queue.drain(
    async (job) => {
      const task = taskMap.get(job.taskId);
      if (!task) {
        return {
          ok: false,
          statusCode: 400,
          retryable: false,
          errorMessage: `Unknown task ${job.taskId}`,
        };
      }

      const sessionId = `ind-${opts.armName}-${task.id}`;
      const messages: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: task.prompt },
      ];

      let taskTotalMs = 0;
      let prevModel: string | null = null;
      let turn1Passed = false;
      let finalPassed = false;
      let finalModel = opts.modelBucket;
      let turnsExecuted = 0;
      let tokensSum = 0;

      const maxTurns = task.correctionPrompt ? 2 : 1;

      for (let turn = 1; turn <= maxTurns; turn++) {
        turnsExecuted = turn;
        const t0 = performance.now();
        const res = await app.request("/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-router-session": sessionId,
          },
          body: JSON.stringify({
            model: opts.modelParam,
            temperature: 0,
            messages,
          }),
        });
        const totalMs = Number((performance.now() - t0).toFixed(2));
        taskTotalMs += totalMs;

        if (!res.ok) {
          const errTxt = await res.text().catch(() => "");
          const retryAfterHdr = res.headers.get("retry-after");
          const retryAfterMs =
            retryAfterHdr && Number.isFinite(Number(retryAfterHdr))
              ? Number(retryAfterHdr) * 1000
              : undefined;
          const retryable =
            res.status === 429 ||
            res.status === 502 ||
            res.status === 503 ||
            res.status === 504;

          if (opts.liveLogging) {
            console.error(
              `[queue] ${opts.armName} ${task.id} t${turn} -> HTTP ${res.status} (${errTxt.slice(0, 90)})`,
            );
          }

          return {
            ok: false,
            statusCode: res.status,
            retryAfterMs,
            retryable,
            errorMessage: `HTTP ${res.status}: ${errTxt.slice(0, 140)}`,
          };
        }

        const json = (await res.json()) as Record<string, unknown>;
        const usage = (json.usage ?? {}) as Record<string, unknown>;
        tokensSum += Number(usage.total_tokens ?? 120);

        const answerText = extractResponseText(json);
        const passed = gradeResponse(answerText, task.grade);
        const selectedModel = res.headers.get("x-router-model") ?? opts.modelParam;
        const tier = res.headers.get("x-router-tier") ?? "unknown";
        const source = res.headers.get("x-router-source") ?? "unknown";
        const reason = res.headers.get("x-router-reason") ?? "";
        const decisionMs = Number(res.headers.get("x-router-decision-ms") ?? 0);
        const selfHandled = res.headers.get("x-router-self-handled") === "true";
        const escalated = res.headers.get("x-router-escalated") === "true";
        const cacheSticky = res.headers.get("x-router-cache-sticky") === "true";
        const upstreamMs = Number(Math.max(0, totalMs - decisionMs).toFixed(2));

        if (prevModel && prevModel !== selectedModel) {
          switches.push({
            taskId: task.id,
            benchmark: task.benchmark,
            turn,
            fromModel: prevModel,
            toModel: selectedModel,
            reason,
            escalated,
          });
        }

        const lightPassed = opts.baselineArmLogs?.lightByTask?.get(task.id);
        const smartPassed = opts.baselineArmLogs?.smartByTask?.get(task.id);

        logs.push({
          timestamp: new Date().toISOString(),
          taskId: task.id,
          benchmark: task.benchmark,
          difficulty: task.difficulty,
          turn,
          tier,
          source,
          selfHandled,
          escalated,
          cacheSticky,
          switchedFrom:
            prevModel && prevModel !== selectedModel ? prevModel : null,
          selectedModel,
          decisionMs,
          upstreamMs,
          totalMs,
          reason,
          answerPreview: answerText.replace(/\s+/g, " ").slice(0, 80),
          passed,
          httpStatus: res.status,
          ...(turn === maxTurns && lightPassed !== undefined ? { lightPassed } : {}),
          ...(turn === maxTurns && smartPassed !== undefined ? { smartPassed } : {}),
          ...(turn === maxTurns && smartPassed !== undefined
            ? { routerRegret: Boolean(smartPassed && !passed) }
            : {}),
        });

        if (opts.liveLogging) {
          console.error(
            `[queue] ${opts.armName} ${task.id} t${turn} -> ${selectedModel} (${tier}/${source}) ${passed ? "PASS" : "FAIL"} ${totalMs}ms`,
          );
        }

        if (turn === 1) turn1Passed = passed;
        finalPassed = passed;
        finalModel = selectedModel;
        prevModel = selectedModel;

        if (turn === 1 && maxTurns === 2) {
          if (passed) break;
          messages.push({ role: "assistant", content: answerText });
          messages.push({ role: "user", content: task.correctionPrompt! });
        }
      }

      return {
        ok: true,
        tokensUsed: tokensSum,
        result: {
          taskId: task.id,
          benchmark: task.benchmark,
          difficulty: task.difficulty,
          turns: turnsExecuted,
          passed: finalPassed,
          turn1Passed,
          finalModel,
          totalMs: Number(taskTotalMs.toFixed(2)),
        },
      };
    },
    {
      arm: opts.armName,
      maxWaitSec: opts.maxWaitSec,
      baseBackoffMs: opts.baseBackoffMs,
    },
  );

  const jobs = opts.queue.getJobs(opts.armName);
  const outcomes: IndustryArmTaskOutcome[] = jobs.map((j) => {
    const t = taskMap.get(j.taskId)!;
    if (j.status === "completed" && j.result) {
      const r = j.result as IndustryArmTaskOutcome;
      return { ...r, status: "completed" };
    }
    return {
      taskId: j.taskId,
      benchmark: t?.benchmark ?? "superglue-nlu",
      difficulty: t?.difficulty ?? "easy",
      turns: 0,
      passed: false,
      turn1Passed: false,
      finalModel: j.modelBucket,
      totalMs: 0,
      status: j.status === "failed" ? "failed" : "rate_limited_unfinished",
    };
  });

  const completed = outcomes.filter((o) => o.status === "completed");
  const passedTasks = completed.filter((o) => o.passed).length;
  const latencies = completed.map((o) => o.totalMs);
  const totalLatencyMs = Number(
    latencies.reduce((a, b) => a + b, 0).toFixed(2),
  );
  const sorted = [...latencies].sort((a, b) => a - b);

  const sqliteStats = store.getStats(24);
  store.close();

  return {
    summary: {
      armName: opts.armName,
      modelLabel: opts.modelParam,
      totalTasks: outcomes.length,
      completedTasks: completed.length,
      passedTasks,
      accuracyPct:
        completed.length > 0
          ? Number(((passedTasks / completed.length) * 100).toFixed(1))
          : 0,
      totalLatencyMs,
      meanLatencyMs:
        completed.length > 0
          ? Number((totalLatencyMs / completed.length).toFixed(2))
          : 0,
      p50LatencyMs: percentile(sorted, 50),
      p95LatencyMs: percentile(sorted, 95),
      estimatedCostUsd: Number(sqliteStats.totalCostUsd.toFixed(6)),
      sqliteStats,
      queueTelemetry: telemetry,
      outcomes,
    },
    logs,
    switches,
  };
}

export async function runIndustryBenchmark(opts?: {
  mode?: IndustryBenchMode;
  fast?: boolean;
  injectFaults?: boolean;
  configPath?: string;
  lightModel?: string;
  smartModel?: string;
  profile?: string;
  tasks?: IndustryTask[];
  sample?: number;
  maxWaitSec?: number;
  maxAttempts?: number;
  outDir?: string;
  saveArtifacts?: boolean;
  writeMarkdownReport?: string;
}): Promise<IndustryBenchmarkReport> {
  const mode: IndustryBenchMode = opts?.mode ?? "simulated";
  const saveArtifacts = opts?.saveArtifacts ?? true;
  const baseTasks = opts?.tasks ?? INDUSTRY_TASKS;
  const tasks =
    opts?.sample && opts.sample > 0
      ? selectStratifiedSample(baseTasks, opts.sample)
      : baseTasks;
  const routerProfile = opts?.profile ?? "auto";

  let config: RouterConfig;
  let closeMocks: (() => Promise<void>) | null = null;
  let lightRef: string;
  let smartRef: string;

  if (mode === "simulated") {
    const mocks = await startIndustryMockServers({
      fast: opts?.fast,
      injectFaults: opts?.injectFaults,
    });
    closeMocks = mocks.close;
    config = buildIndustrySimConfig(mocks);
    lightRef = opts?.lightModel ?? "gemini/gemini-3.8-flash";
    smartRef = opts?.smartModel ?? "smart/gemini-4-hydrogen";
  } else if (mode === "live-decision") {
    const loaded = loadConfig(opts?.configPath);
    if (loaded.config.decisionModel.apiKeys.length === 0) {
      throw new Error("GEMINI_API_KEY is required for --mode live-decision");
    }
    const mocks = await startIndustryMockServers({ fast: opts?.fast ?? true });
    closeMocks = mocks.close;
    const liveDm = {
      ...loaded.config.decisionModel,
      cacheTtlSec: 0,
      timeoutMs: Math.max(loaded.config.decisionModel.timeoutMs, 5000),
    };
    config = buildIndustrySimConfig(mocks, liveDm, loaded.config.profiles);
    lightRef = opts?.lightModel ?? "gemini/gemini-3.8-flash";
    smartRef = opts?.smartModel ?? "smart/gemini-4-hydrogen";
  } else {
    const loaded = loadConfig(opts?.configPath);
    config = loaded.config;
    config.decisionModel.cacheTtlSec = 0;
    if (config.decisionModel.apiKeys.length === 0) {
      throw new Error("GEMINI_API_KEY is required for --mode live");
    }
    const tLow = config.tiers.trivial[0];
    const tHigh = config.tiers.frontier[0] ?? config.tiers.complex[0];
    lightRef =
      opts?.lightModel ??
      (tLow ? `${tLow.provider}/${tLow.model}` : "gemini/gemini-3.8-flash");
    smartRef =
      opts?.smartModel ??
      (tHigh ? `${tHigh.provider}/${tHigh.model}` : "gemini/gemini-4-hydrogen");
  }

  const outDir = path.resolve(opts?.outDir ?? "data/benchmarks/industry");
  const queueDbPath = saveArtifacts
    ? path.join(outDir, "queue.db")
    : ":memory:";
  const queue = new PersistentRateLimitQueue(queueDbPath);
  configureQueueBuckets(queue, config, mode === "simulated" && Boolean(opts?.fast));

  const maxAttempts = opts?.maxAttempts ?? (mode === "live" ? 2 : 4);
  const maxWaitSec = opts?.maxWaitSec ?? (mode === "live" ? 60 : 120);
  const baseBackoffMs =
    mode === "simulated" ? (opts?.fast ? 25 : 200) : mode === "live-decision" ? 2000 : 6000;

  try {
    const lightArm = await runQueuedArm({
      armName: "light-only",
      modelParam: `direct/${lightRef}`,
      modelBucket: lightRef,
      tasks,
      config,
      queue,
      maxAttempts,
      maxWaitSec,
      baseBackoffMs,
      liveLogging: mode !== "simulated",
    });

    const smartArm = await runQueuedArm({
      armName: "smart-only",
      modelParam: `direct/${smartRef}`,
      modelBucket: smartRef,
      tasks,
      config,
      queue,
      maxAttempts,
      maxWaitSec,
      baseBackoffMs,
      liveLogging: mode !== "simulated",
    });

    const lightByTask = new Map(
      lightArm.summary.outcomes.map((o) => [o.taskId, o.passed]),
    );
    const smartByTask = new Map(
      smartArm.summary.outcomes.map((o) => [o.taskId, o.passed]),
    );

    const routerArm = await runQueuedArm({
      armName: "decision-router",
      modelParam: routerProfile,
      modelBucket: "decision-router",
      tasks,
      config,
      queue,
      maxAttempts,
      maxWaitSec,
      baseBackoffMs,
      liveLogging: mode !== "simulated",
      baselineArmLogs: { lightByTask, smartByTask },
    });

    const lSum = lightArm.summary;
    const sSum = smartArm.summary;
    const rSum = routerArm.summary;

    const routerRegretCount = rSum.outcomes.filter(
      (o) =>
        o.status === "completed" &&
        smartByTask.get(o.taskId) === true &&
        !o.passed,
    ).length;

    const benchmarkBreakdown: IndustryBenchmarkBreakdownRow[] =
      INDUSTRY_BENCHMARK_NAMES.map((benchName) => {
        const lSub = lSum.outcomes.filter((o) => o.benchmark === benchName);
        const sSub = sSum.outcomes.filter((o) => o.benchmark === benchName);
        const rSub = rSum.outcomes.filter((o) => o.benchmark === benchName);
        const pct = (arr: IndustryArmTaskOutcome[]) => {
          const done = arr.filter((x) => x.status === "completed");
          return done.length > 0
            ? Number(
                (
                  (done.filter((x) => x.passed).length / done.length) *
                  100
                ).toFixed(1),
              )
            : 0;
        };
        const avg = (arr: IndustryArmTaskOutcome[]) => {
          const done = arr.filter((x) => x.status === "completed");
          return done.length > 0
            ? Number(
                (
                  done.reduce((s, x) => s + x.totalMs, 0) / done.length
                ).toFixed(1),
              )
            : 0;
        };
        const selfEntries = routerArm.logs.filter(
          (e) => e.benchmark === benchName && e.selfHandled,
        );
        const selfAcc =
          selfEntries.length > 0
            ? Number(
                (
                  (selfEntries.filter((e) => e.passed).length /
                    selfEntries.length) *
                  100
                ).toFixed(1),
              )
            : 0;

        return {
          benchmark: benchName,
          count: rSub.length,
          lightAccPct: pct(lSub),
          smartAccPct: pct(sSub),
          routerAccPct: pct(rSub),
          lightAvgMs: avg(lSub),
          smartAvgMs: avg(sSub),
          routerAvgMs: avg(rSub),
          selfCount: selfEntries.length,
          selfAccPct: selfAcc,
        };
      }).filter((row) => row.count > 0);

    const tierCounts: Record<string, number> = {};
    const sourceCounts: Record<string, number> = {};
    const decisionLatencies: number[] = [];
    for (const entry of routerArm.logs) {
      tierCounts[entry.tier] = (tierCounts[entry.tier] ?? 0) + 1;
      sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
      decisionLatencies.push(entry.decisionMs);
    }
    const sortedDec = [...decisionLatencies].sort((a, b) => a - b);

    const selfEntries = routerArm.logs.filter((e) => e.selfHandled);
    const selfPassed = selfEntries.filter((e) => e.passed).length;
    const selfAvgMs =
      selfEntries.length > 0
        ? Number(
            (
              selfEntries.reduce((s, e) => s + e.totalMs, 0) /
              selfEntries.length
            ).toFixed(2),
          )
        : 0;

    const escalatedEntries = routerArm.logs.filter((e) => e.escalated);
    const escalatedIds = new Set(escalatedEntries.map((e) => e.taskId));
    const escalationRecoveredCount = rSum.outcomes.filter(
      (o) => escalatedIds.has(o.taskId) && o.passed,
    ).length;

    const runId = `industry-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const report: IndustryBenchmarkReport = {
      runId,
      timestamp: new Date().toISOString(),
      mode,
      taskCount: tasks.length,
      arms: {
        lightOnly: lSum,
        smartOnly: sSum,
        decisionRouter: rSum,
      },
      comparisons: {
        accuracyDeltaVsLightPct: Number(
          (rSum.accuracyPct - lSum.accuracyPct).toFixed(1),
        ),
        accuracyRetentionVsSmartPct:
          sSum.accuracyPct > 0
            ? Number(((rSum.accuracyPct / sSum.accuracyPct) * 100).toFixed(1))
            : 100,
        routerRegretCount,
        speedupVsSmart:
          rSum.totalLatencyMs > 0
            ? Number((sSum.totalLatencyMs / rSum.totalLatencyMs).toFixed(2))
            : 1,
        speedupVsLight:
          rSum.totalLatencyMs > 0
            ? Number((lSum.totalLatencyMs / rSum.totalLatencyMs).toFixed(2))
            : 1,
        costSavingsVsSmartPct:
          sSum.estimatedCostUsd > 0
            ? Number(
                (
                  ((sSum.estimatedCostUsd - rSum.estimatedCostUsd) /
                    sSum.estimatedCostUsd) *
                  100
                ).toFixed(1),
              )
            : 0,
      },
      benchmarkBreakdown,
      routerLog: {
        entries: routerArm.logs,
        tierCounts,
        sourceCounts,
        selfHandledCount: selfEntries.length,
        selfHandledPassedCount: selfPassed,
        selfHandledAccuracyPct:
          selfEntries.length > 0
            ? Number(((selfPassed / selfEntries.length) * 100).toFixed(1))
            : 0,
        selfHandledAvgMs: selfAvgMs,
        decisionP50Ms: percentile(sortedDec, 50),
        decisionP95Ms: percentile(sortedDec, 95),
        escalationCount: escalatedEntries.length,
        escalationRecoveredCount,
        switchEvents: routerArm.switches,
        queueEventsSample: queue.getRecentEvents(40),
      },
    };

    if (saveArtifacts) {
      fs.mkdirSync(outDir, { recursive: true });
      const logFilePath = path.join(outDir, `${runId}-router-log.jsonl`);
      const queueEventsFilePath = path.join(
        outDir,
        `${runId}-queue-events.jsonl`,
      );
      const reportFilePath = path.join(outDir, `${runId}-report.json`);
      report.routerLog.logFilePath = logFilePath;
      report.routerLog.queueEventsFilePath = queueEventsFilePath;
      report.routerLog.reportFilePath = reportFilePath;

      fs.writeFileSync(
        logFilePath,
        routerArm.logs.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      fs.writeFileSync(
        queueEventsFilePath,
        queue
          .getRecentEvents(500)
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
      );
      fs.writeFileSync(reportFilePath, JSON.stringify(report, null, 2));
    }

    if (opts?.writeMarkdownReport) {
      const md = renderIndustryReportMarkdown({ primary: report });
      fs.writeFileSync(path.resolve(opts.writeMarkdownReport), md, "utf8");
    }

    return report;
  } finally {
    queue.close();
    if (closeMocks) await closeMocks();
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function printIndustrySummary(r: IndustryBenchmarkReport): void {
  const { lightOnly: l, smartOnly: s, decisionRouter: d } = r.arms;
  const c = r.comparisons;

  console.log(
    `\n=== Industry Benchmark Suite (${r.mode} | tasks=${r.taskCount}) ===`,
  );
  console.log(`\n[1] 3-Way Comparison`);
  console.log(
    `  ${pad("Arm", 18)} ${pad("Completed", 10)} ${pad("Accuracy", 16)} ${pad("Total ms", 11)} ${pad("p50/p95 ms", 16)} Cost`,
  );
  for (const arm of [l, s, d]) {
    console.log(
      `  ${pad(arm.armName, 18)} ${pad(`${arm.completedTasks}/${arm.totalTasks}`, 10)} ${pad(`${arm.passedTasks}/${arm.completedTasks} (${arm.accuracyPct}%)`, 16)} ${pad(String(arm.totalLatencyMs), 11)} ${pad(`${arm.p50LatencyMs}/${arm.p95LatencyMs}`, 16)} $${arm.estimatedCostUsd.toFixed(6)}`,
    );
  }
  console.log(
    `  Accuracy vs Light: ${c.accuracyDeltaVsLightPct >= 0 ? "+" : ""}${c.accuracyDeltaVsLightPct} pts | Retention vs Smart: ${c.accuracyRetentionVsSmartPct}% | Regret: ${c.routerRegretCount}`,
  );
  console.log(
    `  Speedup vs Smart: ${c.speedupVsSmart}x | Cost Savings vs Smart: ${c.costSavingsVsSmartPct}%`,
  );

  console.log(`\n[2] Breakdown Across 7 Industry Benchmarks`);
  console.log(
    `  ${pad("Benchmark", 18)} ${pad("N", 4)} ${pad("Light", 14)} ${pad("Smart", 14)} ${pad("Router", 14)} Self ("self")`,
  );
  for (const row of r.benchmarkBreakdown) {
    console.log(
      `  ${pad(row.benchmark, 18)} ${pad(String(row.count), 4)} ${pad(`${row.lightAccPct}%/${row.lightAvgMs}ms`, 14)} ${pad(`${row.smartAccPct}%/${row.smartAvgMs}ms`, 14)} ${pad(`${row.routerAccPct}%/${row.routerAvgMs}ms`, 14)} ${row.selfCount} (${row.selfAccPct}%)`,
    );
  }

  const rl = r.routerLog;
  console.log(`\n[3] Router, Self-Answer, Queue & Escalation Summary`);
  console.log(`  Tiers:   ${JSON.stringify(rl.tierCounts)}`);
  console.log(`  Sources: ${JSON.stringify(rl.sourceCounts)}`);
  console.log(
    `  Decision Latency: p50=${rl.decisionP50Ms}ms p95=${rl.decisionP95Ms}ms`,
  );
  console.log(
    `  Self-Handled: ${rl.selfHandledCount} (${rl.selfHandledPassedCount}/${rl.selfHandledCount} = ${rl.selfHandledAccuracyPct}%, avg ${rl.selfHandledAvgMs}ms)`,
  );
  console.log(
    `  Escalations: ${rl.escalationCount} | Recovered: ${rl.escalationRecoveredCount} | Switches: ${rl.switchEvents.length}`,
  );
  if (rl.reportFilePath) {
    console.log(`  Report JSON:  ${rl.reportFilePath}`);
    console.log(`  Router Log:   ${rl.logFilePath}`);
    console.log(`  Queue Events: ${rl.queueEventsFilePath}`);
  }
  console.log("");
}

function parseCliArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i += 1;
        } else {
          flags[a.slice(2)] = "true";
        }
      }
    }
  }
  return flags;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).endsWith(
    `${path.sep}bench${path.sep}industry${path.sep}run.ts`,
  );

if (isMain) {
  const flags = parseCliArgs(process.argv.slice(2));
  const mode = (flags.mode ?? "simulated") as IndustryBenchMode;
  const sample = flags.sample ? Number(flags.sample) : undefined;
  const maxWaitSec = flags["max-wait-sec"]
    ? Number(flags["max-wait-sec"])
    : undefined;
  const maxAttempts = flags["max-attempts"]
    ? Number(flags["max-attempts"])
    : undefined;

  runIndustryBenchmark({
    mode,
    fast: flags.fast === "true",
    injectFaults: flags["inject-faults"] === "true",
    configPath: flags.config,
    lightModel: flags.light,
    smartModel: flags.smart,
    sample: Number.isFinite(sample) ? sample : undefined,
    maxWaitSec: Number.isFinite(maxWaitSec) ? maxWaitSec : undefined,
    maxAttempts: Number.isFinite(maxAttempts) ? maxAttempts : undefined,
    outDir: flags["out-dir"],
    saveArtifacts: flags["no-save"] !== "true",
    writeMarkdownReport: flags["write-report"],
  })
    .then((report) => {
      if (flags.json === "true") {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printIndustrySummary(report);
      }
    })
    .catch((err) => {
      console.error(
        "[IndustryBench] Error:",
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    });
}
