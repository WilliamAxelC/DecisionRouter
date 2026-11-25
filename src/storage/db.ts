import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DecisionLogRecord {
  id?: number;
  createdAtMs: number;
  protocol: string;
  requestedModel: string;
  profile: string;
  tier: string;
  specialist?: string;
  source: string;
  reason: string;
  selectedProvider: string;
  selectedModel: string;
  decisionMs: number;
  totalMs: number;
  cacheSticky: boolean;
  escalated: boolean;
  selfHandled?: boolean;
  failovers: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedCostUsd: number;
  baselineCostUsd: number;
  statusCode: number;
}

export interface TierBreakdownRow {
  tier: string;
  count: number;
  costUsd: number;
}

export interface ModelBreakdownRow {
  model: string;
  count: number;
  costUsd: number;
  avgMs: number;
}

export interface RouterStatsSummary {
  windowHours: number;
  totalRequests: number;
  totalCostUsd: number;
  baselineCostUsd: number;
  savingsUsd: number;
  savingsPct: number;
  avgDecisionMs: number;
  avgTotalMs: number;
  cacheStickyCount: number;
  escalatedCount: number;
  selfHandledCount: number;
  failoverCount: number;
  byTier: TierBreakdownRow[];
  byModel: ModelBreakdownRow[];
}

export class DecisionStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        protocol TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        profile TEXT NOT NULL,
        tier TEXT NOT NULL,
        specialist TEXT,
        source TEXT NOT NULL,
        reason TEXT NOT NULL,
        selected_provider TEXT NOT NULL,
        selected_model TEXT NOT NULL,
        decision_ms REAL NOT NULL,
        total_ms REAL NOT NULL,
        cache_sticky INTEGER NOT NULL DEFAULT 0,
        escalated INTEGER NOT NULL DEFAULT 0,
        self_handled INTEGER NOT NULL DEFAULT 0,
        failovers INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        baseline_cost_usd REAL NOT NULL DEFAULT 0,
        status_code INTEGER NOT NULL DEFAULT 200
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at_ms DESC);
    `);
    try {
      this.db.exec(
        "ALTER TABLE decisions ADD COLUMN self_handled INTEGER NOT NULL DEFAULT 0;",
      );
    } catch {
      // Column already exists on newer schemas
    }
  }

  record(entry: DecisionLogRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO decisions (
        created_at_ms, protocol, requested_model, profile, tier, specialist,
        source, reason, selected_provider, selected_model,
        decision_ms, total_ms, cache_sticky, escalated, self_handled, failovers,
        input_tokens, output_tokens, cached_input_tokens,
        estimated_cost_usd, baseline_cost_usd, status_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const res = stmt.run(
      entry.createdAtMs,
      entry.protocol,
      entry.requestedModel,
      entry.profile,
      entry.tier,
      entry.specialist ?? null,
      entry.source,
      entry.reason,
      entry.selectedProvider,
      entry.selectedModel,
      entry.decisionMs,
      entry.totalMs,
      entry.cacheSticky ? 1 : 0,
      entry.escalated ? 1 : 0,
      entry.selfHandled ? 1 : 0,
      entry.failovers,
      entry.inputTokens,
      entry.outputTokens,
      entry.cachedInputTokens,
      entry.estimatedCostUsd,
      entry.baselineCostUsd,
      entry.statusCode,
    );
    return Number(res.lastInsertRowid);
  }

  getRecentDecisions(limit = 50): DecisionLogRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM decisions
      ORDER BY created_at_ms DESC, id DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      createdAtMs: Number(r.created_at_ms),
      protocol: String(r.protocol),
      requestedModel: String(r.requested_model),
      profile: String(r.profile),
      tier: String(r.tier),
      specialist: r.specialist ? String(r.specialist) : undefined,
      source: String(r.source),
      reason: String(r.reason),
      selectedProvider: String(r.selected_provider),
      selectedModel: String(r.selected_model),
      decisionMs: Number(r.decision_ms),
      totalMs: Number(r.total_ms),
      cacheSticky: Number(r.cache_sticky) === 1,
      escalated: Number(r.escalated) === 1,
      selfHandled: Number(r.self_handled ?? 0) === 1,
      failovers: Number(r.failovers),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cachedInputTokens: Number(r.cached_input_tokens),
      estimatedCostUsd: Number(r.estimated_cost_usd),
      baselineCostUsd: Number(r.baseline_cost_usd),
      statusCode: Number(r.status_code),
    }));
  }

  getStats(windowHours = 24, nowMs = Date.now()): RouterStatsSummary {
    const sinceMs = nowMs - windowHours * 3600 * 1000;

    const agg = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total_requests,
          COALESCE(SUM(estimated_cost_usd), 0) AS total_cost_usd,
          COALESCE(SUM(baseline_cost_usd), 0) AS baseline_cost_usd,
          COALESCE(AVG(decision_ms), 0) AS avg_decision_ms,
          COALESCE(AVG(total_ms), 0) AS avg_total_ms,
          COALESCE(SUM(cache_sticky), 0) AS cache_sticky_count,
          COALESCE(SUM(escalated), 0) AS escalated_count,
          COALESCE(SUM(self_handled), 0) AS self_handled_count,
          COALESCE(SUM(CASE WHEN failovers > 0 THEN 1 ELSE 0 END), 0) AS failover_count
        FROM decisions
        WHERE created_at_ms >= ?
      `)
      .get(sinceMs) as Record<string, unknown>;

    const totalCostUsd = Number(agg.total_cost_usd ?? 0);
    const baselineCostUsd = Number(agg.baseline_cost_usd ?? 0);
    const savingsUsd = Math.max(0, baselineCostUsd - totalCostUsd);
    const savingsPct =
      baselineCostUsd > 0 ? (savingsUsd / baselineCostUsd) * 100 : 0;

    const byTierRows = this.db
      .prepare(`
        SELECT tier, COUNT(*) AS count, COALESCE(SUM(estimated_cost_usd), 0) AS cost_usd
        FROM decisions
        WHERE created_at_ms >= ?
        GROUP BY tier
        ORDER BY count DESC
      `)
      .all(sinceMs) as Array<Record<string, unknown>>;

    const byModelRows = this.db
      .prepare(`
        SELECT
          selected_provider || '/' || selected_model AS model,
          COUNT(*) AS count,
          COALESCE(SUM(estimated_cost_usd), 0) AS cost_usd,
          COALESCE(AVG(total_ms), 0) AS avg_ms
        FROM decisions
        WHERE created_at_ms >= ?
        GROUP BY selected_provider, selected_model
        ORDER BY count DESC
      `)
      .all(sinceMs) as Array<Record<string, unknown>>;

    return {
      windowHours,
      totalRequests: Number(agg.total_requests ?? 0),
      totalCostUsd,
      baselineCostUsd,
      savingsUsd,
      savingsPct,
      avgDecisionMs: Number(agg.avg_decision_ms ?? 0),
      avgTotalMs: Number(agg.avg_total_ms ?? 0),
      cacheStickyCount: Number(agg.cache_sticky_count ?? 0),
      escalatedCount: Number(agg.escalated_count ?? 0),
      selfHandledCount: Number(agg.self_handled_count ?? 0),
      failoverCount: Number(agg.failover_count ?? 0),
      byTier: byTierRows.map((r) => ({
        tier: String(r.tier),
        count: Number(r.count),
        costUsd: Number(r.cost_usd),
      })),
      byModel: byModelRows.map((r) => ({
        model: String(r.model),
        count: Number(r.count),
        costUsd: Number(r.cost_usd),
        avgMs: Number(r.avg_ms),
      })),
    };
  }

  close(): void {
    this.db.close();
  }
}
