#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../../src/config/loader.js";
import type { RouterConfig } from "../../src/config/schema.js";
import { verifyResponseStructurally } from "../../src/router/cascade.js";
import type { ClassifierDecision } from "../../src/router/gemini-classifier.js";
import type { CanonicalResponse } from "../../src/types/ir.js";
import { fetchHardBenchTasks } from "./fetch.js";
import { gradeHardTaskResponse, type DecisionNoulJudgeFn } from "./graders.js";
import {
  buildHardBenchmarkReportData,
  renderHardBenchmarkReport,
  type HardBenchmarkReportData,
} from "./report.js";
import {
  buildCanonicalRequestForTask,
  ResilientGeminiPool,
} from "./resilient-client.js";
import type {
  CascadeCheckRecord,
  DecisionProbeCache,
  HardBenchTask,
  HardBenchToolCall,
  LiveModelResponse,
  SelfGradeRecord,
} from "./types.js";

interface CliOpts {
  configPath?: string;
  refresh: boolean;
  statusOnly: boolean;
  maxHours: number;
  notify: boolean;
  dbPath: string;
  reportPath: string;
}

function parseCliArgs(argv: string[]): CliOpts {
  let configPath: string | undefined;
  let refresh = false;
  let statusOnly = false;
  let maxHours = 48;
  let notify = false;
  let dbPath = "data/benchmarks/hard-suite/hard-bench.db";
  let reportPath = "HARD_BENCHMARK_REPORT.md";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" && argv[i + 1]) configPath = argv[++i];
    else if (a === "--refresh") refresh = true;
    else if (a === "--status") statusOnly = true;
    else if (a === "--notify") notify = true;
    else if (a === "--max-hours" && argv[i + 1]) {
      maxHours = Math.max(0.01, Number(argv[++i]) || 48);
    } else if (a === "--db" && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (a === "--report" && argv[i + 1]) {
      reportPath = argv[++i];
    }
  }
  return { configPath, refresh, statusOnly, maxHours, notify, dbPath, reportPath };
}

function initHardBenchSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_responses (
      task_id TEXT NOT NULL,
      model_role TEXT NOT NULL,
      model_name TEXT NOT NULL,
      response_json TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      thinking_tokens INTEGER NOT NULL DEFAULT 0,
      passed INTEGER NOT NULL,
      grade_detail TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, model_role)
    );
    CREATE TABLE IF NOT EXISTS decision_cache (
      task_id TEXT PRIMARY KEY,
      classification_json TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS self_grades (
      task_id TEXT NOT NULL,
      profile TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      passed INTEGER NOT NULL,
      grade_detail TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, profile)
    );
    CREATE TABLE IF NOT EXISTS cascade_checks (
      task_id TEXT PRIMARY KEY,
      structural_triggered INTEGER NOT NULL,
      decision_triggered INTEGER NOT NULL,
      reason TEXT NOT NULL,
      verify_ms REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
  `);
}

function loadCachedState(db: DatabaseSync): {
  decisions: Map<string, DecisionProbeCache>;
  lightResponses: Map<string, LiveModelResponse>;
  highResponses: Map<string, LiveModelResponse>;
  selfGrades: Map<string, SelfGradeRecord>;
  cascadeChecks: Map<string, CascadeCheckRecord>;
} {
  const decisions = new Map<string, DecisionProbeCache>();
  for (const r of db.prepare(`SELECT * FROM decision_cache`).all() as Array<Record<string, unknown>>) {
    const taskId = String(r.task_id);
    decisions.set(taskId, {
      taskId,
      rawDecision: JSON.parse(String(r.classification_json)) as ClassifierDecision,
      latencyMs: Number(r.latency_ms),
      updatedAtMs: Number(r.updated_at_ms),
    });
  }

  const lightResponses = new Map<string, LiveModelResponse>();
  const highResponses = new Map<string, LiveModelResponse>();
  for (const r of db.prepare(`SELECT * FROM live_responses`).all() as Array<Record<string, unknown>>) {
    const payload = JSON.parse(String(r.response_json)) as {
      text: string;
      thinkingText?: string;
      toolCalls?: HardBenchToolCall[];
      finishReason?: string;
      httpStatus?: number;
    };
    const role = String(r.model_role) === "high" ? "high" : "light";
    const entry: LiveModelResponse = {
      taskId: String(r.task_id),
      modelRole: role,
      modelName: String(r.model_name),
      text: payload.text ?? "",
      thinkingText: payload.thinkingText,
      toolCalls: payload.toolCalls ?? [],
      finishReason: payload.finishReason ?? "STOP",
      httpStatus: payload.httpStatus ?? 200,
      latencyMs: Number(r.latency_ms),
      promptTokens: Number(r.prompt_tokens),
      outputTokens: Number(r.output_tokens),
      thinkingTokens: Number(r.thinking_tokens),
      passed: Number(r.passed) === 1,
      gradeDetail: String(r.grade_detail),
      updatedAtMs: Number(r.updated_at_ms),
    };
    if (role === "high") highResponses.set(entry.taskId, entry);
    else lightResponses.set(entry.taskId, entry);
  }

  const selfGrades = new Map<string, SelfGradeRecord>();
  for (const r of db.prepare(`SELECT * FROM self_grades`).all() as Array<Record<string, unknown>>) {
    const taskId = String(r.task_id);
    const profile = String(r.profile);
    const rec: SelfGradeRecord = {
      taskId,
      profile,
      answerText: String(r.answer_text),
      passed: Number(r.passed) === 1,
      gradeDetail: String(r.grade_detail),
      updatedAtMs: Number(r.updated_at_ms),
    };
    selfGrades.set(`${taskId}:${profile}`, rec);
    if (!selfGrades.has(taskId)) selfGrades.set(taskId, rec);
  }

  const cascadeChecks = new Map<string, CascadeCheckRecord>();
  for (const r of db.prepare(`SELECT * FROM cascade_checks`).all() as Array<Record<string, unknown>>) {
    const taskId = String(r.task_id);
    cascadeChecks.set(taskId, {
      taskId,
      structuralTriggered: Number(r.structural_triggered) === 1,
      decisionTriggered: Number(r.decision_triggered) === 1,
      reason: String(r.reason),
      verifyMs: Number(r.verify_ms),
      updatedAtMs: Number(r.updated_at_ms),
    });
  }

  return { decisions, lightResponses, highResponses, selfGrades, cascadeChecks };
}

function getTargetModels(config: RouterConfig): {
  decisionModel: string;
  lightModel: string;
  highModel: string;
} {
  const decisionModel =
    config.decisionModel.models[0]?.id ?? "gemini-decision-1";
  const lightModel =
    config.tiers.standard.find((c) => c.provider === "gemini")?.model ??
    config.tiers.trivial.find((c) => c.provider === "gemini")?.model ??
    "gemini-3.8-flash";
  const highModel =
    config.tiers.frontier.find((c) => c.provider === "gemini")?.model ??
    config.tiers.complex.find((c) => c.provider === "gemini")?.model ??
    "gemini-4-hydrogen";
  return { decisionModel, lightModel, highModel };
}

function flushReportFiles(
  db: DatabaseSync,
  pool: ResilientGeminiPool,
  config: RouterConfig,
  tasks: HardBenchTask[],
  reportPath: string,
): HardBenchmarkReportData {
  const { decisions, lightResponses, highResponses, selfGrades, cascadeChecks } =
    loadCachedState(db);
  const { decisionModel, lightModel, highModel } = getTargetModels(config);
  const reportData = buildHardBenchmarkReportData({
    config,
    tasks,
    decisions,
    lightResponses,
    highResponses,
    selfGrades,
    cascadeChecks,
    apiTelemetry: pool.getApiTelemetrySummary(),
    lightModel,
    highModel,
    decisionModel,
  });

  const absReport = path.resolve(reportPath);
  fs.writeFileSync(absReport, renderHardBenchmarkReport(reportData), "utf8");

  const progressPath = path.resolve("data/benchmarks/hard-suite/progress.json");
  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(progressPath, JSON.stringify(reportData, null, 2), "utf8");
  return reportData;
}

function sendWorkerPing(reportData: HardBenchmarkReportData, status: "done" | "blocked", detail: string): void {
  const script = "/home/agent/.agents/skills/worker-ping/scripts/worker_ping.py";
  if (!fs.existsSync(script)) return;
  const qArm = reportData.arms.find((a) => a.label.includes("auto:quality"));
  const hArm = reportData.arms.find((a) => a.label.startsWith("Smart-Only"));
  const lArm = reportData.arms.find((a) => a.label.startsWith("Light-Only"));
  const summary =
    `Completed ${reportData.pairedCompleted}/${reportData.totalTasks} live unsaturated benchmark tasks across 9 families. ` +
    (hArm && lArm && qArm
      ? `Flash=${lArm.accuracyPct}%, Hydrogen=${hArm.accuracyPct}%, DecisionRouter(auto:quality)=${qArm.accuracyPct}% (regret=${qArm.regretCount}, speedup=${qArm.speedupVsHydrogen}x, saved=${qArm.costSavingsVsHydrogenPct}%). `
      : "") +
    detail;
  try {
    execFileSync(
      "python3",
      [
        script,
        "--status",
        status,
        "--task",
        "Hard Real-World Live Benchmark Suite",
        "--summary",
        summary,
        "--verify",
        `HARD_BENCHMARK_REPORT.md generated (${reportData.pairedCompleted}/${reportData.totalTasks} paired live runs)`,
      ],
      { stdio: "inherit", timeout: 15_000 },
    );
  } catch (err) {
    console.warn(`[HardBench] worker_ping warning: ${String(err)}`);
  }
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  const { config } = loadConfig(opts.configPath);
  const { decisionModel, lightModel, highModel } = getTargetModels(config);

  console.log(
    `[HardBench] Hydrating real tasks from HuggingFace / Gorilla BFCL GitHub...`,
  );
  const tasks = await fetchHardBenchTasks({ refresh: opts.refresh });
  console.log(`[HardBench] Loaded ${tasks.length} real tasks across 9 families.`);

  fs.mkdirSync(path.dirname(path.resolve(opts.dbPath)), { recursive: true });
  const db = new DatabaseSync(opts.dbPath);
  initHardBenchSchema(db);
  const pool = new ResilientGeminiPool(db, config);

  let stopRequested = false;
  const handleSig = () => {
    if (!stopRequested) {
      stopRequested = true;
      console.log(`\n[HardBench] Shutdown signal received; flushing report safely...`);
    }
  };
  process.on("SIGINT", handleSig);
  process.on("SIGTERM", handleSig);

  if (opts.statusOnly) {
    const data = flushReportFiles(db, pool, config, tasks, opts.reportPath);
    console.log(
      `[HardBench Status] decision=${data.decisionCompleted}/${data.totalTasks} light=${data.lightCompleted}/${data.totalTasks} high=${data.highCompleted}/${data.totalTasks} paired=${data.pairedCompleted}/${data.totalTasks}`,
    );
    for (const a of data.arms) {
      if (a.n > 0) {
        console.log(
          `  - ${a.label}: ${a.passed}/${a.n} (${a.accuracyPct}%) | mean=${a.meanLatencyMs}ms | speedup=${a.speedupVsHydrogen}x | saved=${a.costSavingsVsHydrogenPct}%`,
        );
      }
    }
    db.close();
    return;
  }

  const judgeFn: DecisionNoulJudgeFn = async (input, instruction) => {
    return await pool.callDecisionNoulJudge(input, instruction);
  };

  const deadlineMs = Date.now() + opts.maxHours * 3_600_000;
  let completedSinceFlush = 0;
  let lastWaitLogMs = 0;

  while (!stopRequested) {
    const nowMs = Date.now();
    if (nowMs >= deadlineMs) {
      console.log(`[HardBench] Reached --max-hours=${opts.maxHours}; saving report and exiting.`);
      break;
    }

    const state = loadCachedState(db);
    const pendingDecision = tasks.filter((t) => !state.decisions.has(t.id));
    const pendingLight = tasks.filter((t) => !state.lightResponses.has(t.id));
    const pendingHigh = tasks.filter((t) => !state.highResponses.has(t.id));

    // Grade any newly completed self-answers if decision_cache has directAnswer not yet in self_grades
    for (const t of tasks) {
      const probe = state.decisions.get(t.id);
      if (probe?.rawDecision.directAnswer && !state.selfGrades.has(`${t.id}:auto:quality`)) {
        const g = await gradeHardTaskResponse(
          t,
          probe.rawDecision.directAnswer,
          [],
          judgeFn,
        );
        db.prepare(
          `INSERT OR REPLACE INTO self_grades (task_id, profile, answer_text, passed, grade_detail, updated_at_ms) VALUES (?, 'auto:quality', ?, ?, ?, ?)`,
        ).run(
          t.id,
          probe.rawDecision.directAnswer,
          g.passed ? 1 : 0,
          g.detail,
          Date.now(),
        );
      }
      const light = state.lightResponses.get(t.id);
      if (light && !state.cascadeChecks.has(t.id)) {
        const casReq = buildCanonicalRequestForTask(t, "auto:quality", false);
        const casRes: CanonicalResponse = {
          id: t.id,
          model: lightModel,
          stopReason: light.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
          content: [
            ...(light.text ? [{ type: "text" as const, text: light.text }] : []),
            ...(light.toolCalls ?? []).map((tc, i) => ({
              type: "tool_use" as const,
              id: `tc_${i}`,
              name: tc.name,
              input: tc.arguments,
            })),
          ],
          usage: {
            inputTokens: light.promptTokens,
            outputTokens: light.outputTokens,
          },
        };
        const tCas0 = performance.now();
        const struct = verifyResponseStructurally(casReq, casRes);
        const verifyMs = Number((performance.now() - tCas0).toFixed(2));
        db.prepare(
          `INSERT OR REPLACE INTO cascade_checks (task_id, structural_triggered, decision_triggered, reason, verify_ms, updated_at_ms) VALUES (?, ?, 0, ?, ?, ?)`,
        ).run(
          t.id,
          struct.ok ? 0 : 1,
          struct.ok ? "structural_ok" : (struct.reason ?? "structural_fail"),
          verifyMs,
          Date.now(),
        );
      }
    }

    if (
      pendingDecision.length === 0 &&
      pendingLight.length === 0 &&
      pendingHigh.length === 0
    ) {
      console.log(`[HardBench] All ${tasks.length} tasks completed across Decision, Light, and Smart!`);
      break;
    }

    type BucketWork = {
      kind: "decision" | "light" | "high";
      model: string;
      task: HardBenchTask;
      readyAtMs: number;
      allQuarantined: boolean;
    };

    const candidateBuckets: BucketWork[] = [];
    if (pendingDecision.length > 0) {
      const r = pool.getNextReadyAtMs(decisionModel, nowMs);
      candidateBuckets.push({
        kind: "decision",
        model: decisionModel,
        task: pendingDecision[0],
        readyAtMs: r.readyAtMs,
        allQuarantined: r.allQuarantined,
      });
    }
    if (pendingLight.length > 0) {
      const r = pool.getNextReadyAtMs(lightModel, nowMs);
      candidateBuckets.push({
        kind: "light",
        model: lightModel,
        task: pendingLight[0],
        readyAtMs: r.readyAtMs,
        allQuarantined: r.allQuarantined,
      });
    }
    if (pendingHigh.length > 0) {
      const r = pool.getNextReadyAtMs(highModel, nowMs);
      candidateBuckets.push({
        kind: "high",
        model: highModel,
        task: pendingHigh[0],
        readyAtMs: r.readyAtMs,
        allQuarantined: r.allQuarantined,
      });
    }

    if (candidateBuckets.every((b) => b.allQuarantined)) {
      console.error(`[HardBench] All keys permanently quarantined across remaining buckets; stopping.`);
      if (opts.notify) {
        const finalData = flushReportFiles(db, pool, config, tasks, opts.reportPath);
        sendWorkerPing(finalData, "blocked", "All Gemini keys quarantined (401/403).");
      }
      break;
    }

    // Non-head-of-line-blocking: pick earliest ready bucket; when multiple are ready now,
    // finish decision probes first, then keep light & high advancing 1:1 so paired metrics grow steadily.
    const completedCountMap = {
      decision: state.decisions.size,
      light: state.lightResponses.size,
      high: state.highResponses.size,
    };
    candidateBuckets.sort((a, b) => {
      const aReady = a.readyAtMs <= nowMs;
      const bReady = b.readyAtMs <= nowMs;
      if (aReady && bReady) {
        if (a.kind === "decision" && b.kind !== "decision") return -1;
        if (b.kind === "decision" && a.kind !== "decision") return 1;
        return completedCountMap[a.kind] - completedCountMap[b.kind];
      }
      return a.readyAtMs - b.readyAtMs;
    });
    const chosen = candidateBuckets[0];

    if (chosen.readyAtMs > nowMs) {
      const waitMs = Math.min(chosen.readyAtMs - nowMs, deadlineMs - nowMs);
      if (nowMs - lastWaitLogMs >= 20_000 || waitMs >= 10_000) {
        lastWaitLogMs = nowMs;
        console.log(
          `[HardBench] progress dec=${state.decisions.size}/${tasks.length} light=${state.lightResponses.size}/${tasks.length} high=${state.highResponses.size}/${tasks.length} | backing off cleanly for ${Math.ceil(waitMs / 1000)}s (next=${chosen.model})`,
        );
      }
      await new Promise((r) => setTimeout(r, Math.max(100, Math.min(waitMs, 5000))));
      continue;
    }

    if (chosen.kind === "decision") {
      const res = await pool.callDecisionMultiProbe(chosen.task);
      if (res.ok) {
        db.prepare(
          `INSERT OR REPLACE INTO decision_cache (task_id, classification_json, latency_ms, updated_at_ms) VALUES (?, ?, ?, ?)`,
        ).run(
          chosen.task.id,
          JSON.stringify(res.decision),
          res.latencyMs,
          Date.now(),
        );
        console.log(
          `[decision] ${chosen.task.id} key#${res.keyIdx + 1} (${res.latencyMs}ms) -> ${res.decision.reason}`,
        );
        completedSinceFlush++;
      } else {
        console.warn(
          `[decision] ${chosen.task.id} key#${res.keyIdx + 1} HTTP ${res.status} -> ${res.transition.eventType} (${Math.round(res.transition.delayMs / 1000)}s cooldown)`,
        );
      }
    } else {
      const res = await pool.callGenerateContent(chosen.model, chosen.task);
      if (res.ok) {
        const graded = await gradeHardTaskResponse(
          chosen.task,
          res.output.text,
          res.output.toolCalls,
          judgeFn,
        );
        db.prepare(
          `INSERT OR REPLACE INTO live_responses (
            task_id, model_role, model_name, response_json, latency_ms,
            prompt_tokens, output_tokens, thinking_tokens, passed, grade_detail, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          chosen.task.id,
          chosen.kind,
          chosen.model,
          JSON.stringify({
            text: res.output.text,
            thinkingText: res.output.thinkingText,
            toolCalls: res.output.toolCalls,
            finishReason: res.output.finishReason,
            httpStatus: res.output.httpStatus,
          }),
          res.output.latencyMs,
          res.output.promptTokens,
          res.output.outputTokens,
          res.output.thinkingTokens,
          graded.passed ? 1 : 0,
          graded.detail,
          Date.now(),
        );
        console.log(
          `[${chosen.kind}] ${chosen.task.id} key#${res.keyIdx + 1} ${graded.passed ? "PASS" : "FAIL"} (${res.output.latencyMs}ms, out=${res.output.outputTokens}, think=${res.output.thinkingTokens}) ${graded.detail.slice(0, 70)}`,
        );
        completedSinceFlush++;
      } else {
        console.warn(
          `[${chosen.kind}] ${chosen.task.id} key#${res.keyIdx + 1} HTTP ${res.status} -> ${res.transition.eventType} (wait ${Math.round(res.transition.delayMs / 1000)}s): ${res.errorMessage.slice(0, 100)}`,
        );
      }
    }

    if (completedSinceFlush >= 5) {
      completedSinceFlush = 0;
      flushReportFiles(db, pool, config, tasks, opts.reportPath);
    }
  }

  const finalData = flushReportFiles(db, pool, config, tasks, opts.reportPath);
  if (
    opts.notify &&
    !stopRequested &&
    finalData.pairedCompleted >= finalData.totalTasks
  ) {
    sendWorkerPing(finalData, "done", "All 9 hard real-world benchmarks finished live.");
  }
  db.close();
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isEntrypoint) {
  main().catch((err) => {
    console.error("[HardBench] Fatal error:", err);
    process.exit(1);
  });
}
