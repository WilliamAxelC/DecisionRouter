import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type QueueJobStatus = "pending" | "rate_limited" | "completed" | "failed";

export interface BucketRateConfig {
  rpm: number;
  tpm?: number;
  rpd: number;
}

export interface QueueJob<TPayload = unknown> {
  id: string;
  arm: string;
  taskId: string;
  modelBucket: string;
  payload: TPayload;
  status: QueueJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAtMs: number;
  lastError?: string;
  result?: unknown;
}

export interface QueueExecutionOutcome {
  ok: boolean;
  result?: unknown;
  tokensUsed?: number;
  statusCode?: number;
  retryAfterMs?: number;
  errorMessage?: string;
  retryable?: boolean;
}

export interface QueueBucketTelemetry {
  modelBucket: string;
  rpmUsed: number;
  rpmLimit: number;
  tpmUsed: number;
  tpmLimit: number | null;
  rpdUsed: number;
  rpdLimit: number;
  cooldownUntilMs: number | null;
  completedCount: number;
  rateLimitedEvents: number;
  http429Count: number;
  http503Count: number;
}

export interface QueueTelemetrySummary {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  unfinishedJobs: number;
  rateLimitedRetries: number;
  http429Count: number;
  http503Count: number;
  eventsCount: number;
  elapsedWallMs: number;
  perBucket: QueueBucketTelemetry[];
}

interface BucketRuntimeState {
  minuteCalls: Array<{ ts: number; tokens: number }>;
  dayKey: string;
  dayCalls: number;
  cooldownUntilMs: number | null;
  completedCount: number;
  rateLimitedEvents: number;
  http429Count: number;
  http503Count: number;
}

export class PersistentRateLimitQueue {
  readonly db: DatabaseSync;
  private readonly buckets = new Map<string, BucketRuntimeState>();
  private readonly bucketLimits = new Map<string, BucketRateConfig>();

  constructor(
    dbPath: string,
    bucketConfigs: Record<string, BucketRateConfig> = {},
  ) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue_jobs (
        id TEXT PRIMARY KEY,
        arm TEXT NOT NULL,
        task_id TEXT NOT NULL,
        model_bucket TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 4,
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        result_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_qjobs_status_next
        ON queue_jobs(status, next_attempt_at_ms);

      CREATE TABLE IF NOT EXISTS queue_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        model_bucket TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);

    for (const [k, v] of Object.entries(bucketConfigs)) {
      this.bucketLimits.set(k, v);
    }
  }

  setBucketLimit(modelBucket: string, cfg: BucketRateConfig): void {
    this.bucketLimits.set(modelBucket, cfg);
  }

  private getLimit(modelBucket: string): BucketRateConfig {
    return (
      this.bucketLimits.get(modelBucket) ?? {
        rpm: 120,
        rpd: 10_000,
      }
    );
  }

  private getBucketState(modelBucket: string, nowMs: number): BucketRuntimeState {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    let st = this.buckets.get(modelBucket);
    if (!st) {
      st = {
        minuteCalls: [],
        dayKey: today,
        dayCalls: 0,
        cooldownUntilMs: null,
        completedCount: 0,
        rateLimitedEvents: 0,
        http429Count: 0,
        http503Count: 0,
      };
      this.buckets.set(modelBucket, st);
    }
    if (st.dayKey !== today) {
      st.dayKey = today;
      st.dayCalls = 0;
    }
    const cutoff = nowMs - 60_000;
    st.minuteCalls = st.minuteCalls.filter((c) => c.ts > cutoff);
    if (st.cooldownUntilMs !== null && nowMs >= st.cooldownUntilMs) {
      st.cooldownUntilMs = null;
    }
    return st;
  }

  /**
   * Computes earliest timestamp when `modelBucket` can next accept a job.
   */
  private getBucketReadyAtMs(modelBucket: string, nowMs: number): number {
    const st = this.getBucketState(modelBucket, nowMs);
    const lim = this.getLimit(modelBucket);

    let readyAt = nowMs;
    if (st.cooldownUntilMs !== null && st.cooldownUntilMs > readyAt) {
      readyAt = st.cooldownUntilMs;
    }
    if (st.dayCalls >= lim.rpd) {
      // Daily quota exhausted -> push out 24h
      readyAt = Math.max(readyAt, nowMs + 86_400_000);
    }
    if (st.minuteCalls.length >= lim.rpm && st.minuteCalls.length > 0) {
      const oldestTs = st.minuteCalls[0].ts;
      readyAt = Math.max(readyAt, oldestTs + 60_200);
    }
    if (lim.tpm !== undefined) {
      const totalTokens = st.minuteCalls.reduce((s, c) => s + c.tokens, 0);
      if (totalTokens >= lim.tpm && st.minuteCalls.length > 0) {
        const oldestTs = st.minuteCalls[0].ts;
        readyAt = Math.max(readyAt, oldestTs + 60_200);
      }
    }
    return readyAt;
  }

  enqueue(jobs: Array<{
    id: string;
    arm: string;
    taskId: string;
    modelBucket: string;
    payload: unknown;
    maxAttempts?: number;
  }>): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO queue_jobs (
        id, arm, task_id, model_bucket, payload_json, status,
        attempts, max_attempts, next_attempt_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 0, ?, ?)
    `);

    for (const j of jobs) {
      stmt.run(
        j.id,
        j.arm,
        j.taskId,
        j.modelBucket,
        JSON.stringify(j.payload),
        j.maxAttempts ?? 4,
        now,
        now,
      );
    }
  }

  private logEvent(
    jobId: string,
    eventType: string,
    modelBucket: string,
    detail: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO queue_events (ts_ms, job_id, event_type, model_bucket, detail) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), jobId, eventType, modelBucket, detail.slice(0, 400));
  }

  getJobs(arm?: string): QueueJob[] {
    const rows = (
      arm
        ? this.db
            .prepare(`SELECT * FROM queue_jobs WHERE arm = ? ORDER BY created_at_ms ASC, id ASC`)
            .all(arm)
        : this.db
            .prepare(`SELECT * FROM queue_jobs ORDER BY created_at_ms ASC, id ASC`)
            .all()
    ) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      arm: String(r.arm),
      taskId: String(r.task_id),
      modelBucket: String(r.model_bucket),
      payload: JSON.parse(String(r.payload_json)),
      status: String(r.status) as QueueJobStatus,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      nextAttemptAtMs: Number(r.next_attempt_at_ms),
      lastError: r.last_error ? String(r.last_error) : undefined,
      result: r.result_json ? JSON.parse(String(r.result_json)) : undefined,
    }));
  }

  getRecentEvents(limit = 50): Array<{
    tsMs: number;
    jobId: string;
    eventType: string;
    modelBucket: string;
    detail: string;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM queue_events ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      tsMs: Number(r.ts_ms),
      jobId: String(r.job_id),
      eventType: String(r.event_type),
      modelBucket: String(r.model_bucket),
      detail: String(r.detail),
    }));
  }

  /**
   * Drains pending/rate_limited jobs with non-head-of-line-blocking scheduling
   * and exponential backoff on 429/503 until all jobs finish or maxWaitSec elapses.
   */
  async drain<TPayload = unknown>(
    worker: (job: QueueJob<TPayload>) => Promise<QueueExecutionOutcome>,
    opts?: {
      arm?: string;
      maxWaitSec?: number;
      baseBackoffMs?: number;
      onProgress?: (info: {
        job: QueueJob<TPayload>;
        outcome: QueueExecutionOutcome;
      }) => void;
    },
  ): Promise<QueueTelemetrySummary> {
    const startWallMs = Date.now();
    const deadlineMs =
      opts?.maxWaitSec && opts.maxWaitSec > 0
        ? startWallMs + opts.maxWaitSec * 1000
        : Number.POSITIVE_INFINITY;
    const baseBackoffMs = opts?.baseBackoffMs ?? 6000;

    while (true) {
      const nowMs = Date.now();
      const runnable = this.getJobs(opts?.arm).filter(
        (j) => j.status === "pending" || j.status === "rate_limited",
      ) as Array<QueueJob<TPayload>>;

      if (runnable.length === 0) {
        break;
      }

      // Pick first job whose job backoff AND modelBucket rate limits are both ready
      let selected: QueueJob<TPayload> | undefined;
      let earliestReadyAt = Number.POSITIVE_INFINITY;

      for (const job of runnable) {
        const bucketReadyAt = this.getBucketReadyAtMs(job.modelBucket, nowMs);
        const jobReadyAt = Math.max(nowMs, job.nextAttemptAtMs, bucketReadyAt);
        if (jobReadyAt <= nowMs) {
          selected = job;
          break;
        }
        if (jobReadyAt < earliestReadyAt) {
          earliestReadyAt = jobReadyAt;
        }
      }

      if (!selected) {
        const sleepMs = Math.max(25, earliestReadyAt - nowMs);
        if (nowMs + sleepMs > deadlineMs) {
          this.logEvent(
            "scheduler",
            "max_wait_reached",
            "all",
            `Stopping queue drain after maxWaitSec=${opts?.maxWaitSec}s with ${runnable.length} job(s) remaining`,
          );
          break;
        }
        await new Promise((r) => setTimeout(r, sleepMs));
        continue;
      }

      const st = this.getBucketState(selected.modelBucket, nowMs);
      st.minuteCalls.push({ ts: nowMs, tokens: 250 });
      st.dayCalls += 1;

      const nextAttempts = selected.attempts + 1;
      const outcome = await worker(selected);
      const finishedNow = Date.now();

      if (outcome.tokensUsed && outcome.tokensUsed > 0) {
        const lastEntry = st.minuteCalls[st.minuteCalls.length - 1];
        if (lastEntry) lastEntry.tokens = outcome.tokensUsed;
      }

      if (outcome.ok) {
        st.completedCount += 1;
        this.db
          .prepare(
            `UPDATE queue_jobs SET status = 'completed', attempts = ?, result_json = ?, last_error = NULL, updated_at_ms = ? WHERE id = ?`,
          )
          .run(nextAttempts, JSON.stringify(outcome.result ?? null), finishedNow, selected.id);
        this.logEvent(
          selected.id,
          "completed",
          selected.modelBucket,
          `attempt=${nextAttempts}`,
        );
      } else {
        const status = outcome.statusCode ?? 0;
        const isRateOrTransient =
          outcome.retryable !== false &&
          (status === 429 || status === 502 || status === 503 || status === 504 || status === 0);

        if (status === 429) st.http429Count += 1;
        if (status === 503 || status === 504 || status === 502) st.http503Count += 1;

        if (isRateOrTransient && nextAttempts < selected.maxAttempts) {
          st.rateLimitedEvents += 1;
          const expBackoff = baseBackoffMs * Math.pow(2, nextAttempts - 1);
          const delayMs = outcome.retryAfterMs
            ? Math.max(outcome.retryAfterMs, baseBackoffMs)
            : expBackoff;
          const nextAttemptAt = finishedNow + delayMs;
          st.cooldownUntilMs = Math.max(st.cooldownUntilMs ?? 0, nextAttemptAt);

          this.db
            .prepare(
              `UPDATE queue_jobs SET status = 'rate_limited', attempts = ?, next_attempt_at_ms = ?, last_error = ?, updated_at_ms = ? WHERE id = ?`,
            )
            .run(
              nextAttempts,
              nextAttemptAt,
              outcome.errorMessage ?? `HTTP ${status}`,
              finishedNow,
              selected.id,
            );
          this.logEvent(
            selected.id,
            status === 429 ? "rate_limited_429" : "transient_retry",
            selected.modelBucket,
            `HTTP ${status}; retry #${nextAttempts} in ${delayMs}ms`,
          );
        } else {
          this.db
            .prepare(
              `UPDATE queue_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at_ms = ? WHERE id = ?`,
            )
            .run(
              nextAttempts,
              outcome.errorMessage ?? `HTTP ${status}`,
              finishedNow,
              selected.id,
            );
          this.logEvent(
            selected.id,
            "failed",
            selected.modelBucket,
            outcome.errorMessage ?? `HTTP ${status}`,
          );
        }
      }

      opts?.onProgress?.({ job: selected, outcome });
    }

    return this.getTelemetry(Date.now() - startWallMs, opts?.arm);
  }

  getTelemetry(elapsedWallMs = 0, arm?: string): QueueTelemetrySummary {
    const jobs = this.getJobs(arm);
    const nowMs = Date.now();
    const completedJobs = jobs.filter((j) => j.status === "completed").length;
    const failedJobs = jobs.filter((j) => j.status === "failed").length;
    const unfinishedJobs = jobs.filter(
      (j) => j.status === "pending" || j.status === "rate_limited",
    ).length;

    const eventsRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM queue_events`)
      .get() as { cnt: number };

    let rateLimitedRetries = 0;
    let http429Count = 0;
    let http503Count = 0;
    const perBucket: QueueBucketTelemetry[] = [];

    for (const [modelBucket] of this.buckets.entries()) {
      const st = this.getBucketState(modelBucket, nowMs);
      const lim = this.getLimit(modelBucket);
      rateLimitedRetries += st.rateLimitedEvents;
      http429Count += st.http429Count;
      http503Count += st.http503Count;
      perBucket.push({
        modelBucket,
        rpmUsed: st.minuteCalls.length,
        rpmLimit: lim.rpm,
        tpmUsed: st.minuteCalls.reduce((s, c) => s + c.tokens, 0),
        tpmLimit: lim.tpm ?? null,
        rpdUsed: st.dayCalls,
        rpdLimit: lim.rpd,
        cooldownUntilMs: st.cooldownUntilMs,
        completedCount: st.completedCount,
        rateLimitedEvents: st.rateLimitedEvents,
        http429Count: st.http429Count,
        http503Count: st.http503Count,
      });
    }

    return {
      totalJobs: jobs.length,
      completedJobs,
      failedJobs,
      unfinishedJobs,
      rateLimitedRetries,
      http429Count,
      http503Count,
      eventsCount: Number(eventsRow.cnt ?? 0),
      elapsedWallMs,
      perBucket,
    };
  }

  close(): void {
    this.db.close();
  }
}
