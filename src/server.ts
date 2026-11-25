import { Hono, type Context } from "hono";
import { estimateCostUsd, parseModelRef } from "./config/loader.js";
import type { RouterConfig } from "./config/schema.js";
import { renderDashboardHtml } from "./dashboard/ui.js";
import {
  formatAnthropicResponse,
  formatAnthropicStream,
  parseAnthropicRequest,
} from "./protocols/anthropic.js";
import {
  formatOpenAIResponse,
  formatOpenAIStream,
  parseOpenAIRequest,
} from "./protocols/openai.js";
import { UpstreamError } from "./providers/base.js";
import { DecisionEngine } from "./router/engine.js";
import type { DecisionStore } from "./storage/db.js";
import type {
  CanonicalRequest,
  CanonicalStreamEvent,
  RoutingDecision,
  TokenUsage,
} from "./types/ir.js";

export interface AppDependencies {
  config: RouterConfig;
  engine: DecisionEngine;
  store: DecisionStore;
}

/**
 * Strips CR/LF, non-ASCII/non-printable characters, and truncates for safe HTTP header values.
 */
export function sanitizeHeaderValue(value: string, maxLen = 120): string {
  const cleaned = value.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, "");
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 3)}...` : cleaned;
}

function buildRouterHeaders(decision: RoutingDecision): Record<string, string> {
  return {
    "X-Router-Model": sanitizeHeaderValue(
      `${decision.selectedProvider}/${decision.selectedModel}`,
    ),
    "X-Router-Tier": sanitizeHeaderValue(
      decision.specialist
        ? `${decision.tier}:${decision.specialist}`
        : decision.tier,
    ),
    "X-Router-Profile": sanitizeHeaderValue(decision.profile),
    "X-Router-Source": sanitizeHeaderValue(decision.source),
    "X-Router-Reason": sanitizeHeaderValue(decision.reason, 120),
    "X-Router-Decision-Ms": String(decision.decisionMs),
    "X-Router-Cache-Sticky": String(decision.cacheSticky),
    "X-Router-Escalated": String(decision.escalated),
    "X-Router-Self-Handled": String(decision.selfHandled),
    "X-Router-Failovers": String(decision.failovers),
  };
}

function recordUsageToStore(
  store: DecisionStore,
  config: RouterConfig,
  req: CanonicalRequest,
  decision: RoutingDecision,
  usage: TokenUsage,
  totalMs: number,
  statusCode = 200,
): void {
  const effectiveUsage: TokenUsage = {
    inputTokens: usage.inputTokens || decision.estimatedInputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
  };

  const estimatedCostUsd = estimateCostUsd(
    config,
    decision.selectedProvider,
    decision.selectedModel,
    effectiveUsage,
  );

  const profile =
    config.profiles[decision.profile] ?? Object.values(config.profiles)[0];
  const baselineRef = parseModelRef(
    profile?.baselineModel ?? "anthropic/claude-opus-4-6",
  );
  const baselineCostUsd = estimateCostUsd(
    config,
    baselineRef.provider,
    baselineRef.model,
    effectiveUsage,
  );

  store.record({
    createdAtMs: Date.now(),
    protocol: req.protocol,
    requestedModel: req.requestedModel,
    profile: decision.profile,
    tier: decision.tier,
    specialist: decision.specialist,
    source: decision.source,
    reason: decision.reason,
    selectedProvider: decision.selectedProvider,
    selectedModel: decision.selectedModel,
    decisionMs: decision.decisionMs,
    totalMs: Math.round(totalMs * 100) / 100,
    cacheSticky: decision.cacheSticky,
    escalated: decision.escalated,
    selfHandled: decision.selfHandled,
    failovers: decision.failovers,
    inputTokens: effectiveUsage.inputTokens,
    outputTokens: effectiveUsage.outputTokens,
    cachedInputTokens: effectiveUsage.cachedInputTokens ?? 0,
    estimatedCostUsd,
    baselineCostUsd,
    statusCode,
  });
}

async function* tapStreamUsage(
  events: AsyncIterable<CanonicalStreamEvent>,
  onComplete: (usage: TokenUsage) => void,
): AsyncGenerator<CanonicalStreamEvent> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;

  try {
    for await (const ev of events) {
      if (ev.type === "message_start") {
        if (ev.inputTokens) inputTokens = ev.inputTokens;
        if (ev.cachedInputTokens) cachedInputTokens = ev.cachedInputTokens;
      } else if (ev.type === "message_delta" && ev.usage) {
        if (ev.usage.inputTokens) inputTokens = ev.usage.inputTokens;
        if (ev.usage.outputTokens) outputTokens = ev.usage.outputTokens;
        if (ev.usage.cachedInputTokens !== undefined) {
          cachedInputTokens = ev.usage.cachedInputTokens;
        }
      }
      yield ev;
    }
  } finally {
    onComplete({ inputTokens, outputTokens, cachedInputTokens });
  }
}

export function createApp(deps: AppDependencies): Hono {
  const { config, engine, store } = deps;
  const app = new Hono();

  // Optional bearer/x-api-key authentication (exempts /health)
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || !config.server.authToken) {
      return next();
    }
    const authHeader = c.req.header("authorization") ?? "";
    const apiKeyHeader = c.req.header("x-api-key") ?? "";
    const bearer = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";
    if (bearer === config.server.authToken || apiKeyHeader === config.server.authToken) {
      return next();
    }
    return c.json({ error: { message: "Unauthorized", type: "auth_error" } }, 401);
  });

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "decision-router",
      geminiKeysConfigured: config.decisionModel.apiKeys.length,
    });
  });

  app.get("/v1/models", (c) => {
    const now = Math.floor(Date.now() / 1000);
    const data: Array<Record<string, unknown>> = [];

    for (const profileName of Object.keys(config.profiles)) {
      data.push({
        id: profileName,
        object: "model",
        created: now,
        owned_by: "decision-router",
      });
    }

    for (const [providerName, providerCfg] of Object.entries(config.providers)) {
      for (const modelName of Object.keys(providerCfg.models)) {
        data.push({
          id: `direct/${providerName}/${modelName}`,
          object: "model",
          created: now,
          owned_by: providerName,
        });
      }
    }

    return c.json({ object: "list", data });
  });

  async function handleLlmRequest(
    protocol: "openai" | "anthropic",
    c: Context,
  ) {
    const startMs = performance.now();
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(
        { error: { message: "Invalid JSON request body", type: "invalid_request_error" } },
        400,
      );
    }

    const headers = c.req.header();
    const canonicalReq =
      protocol === "openai"
        ? parseOpenAIRequest(body, headers)
        : parseAnthropicRequest(body, headers);

    try {
      const { decision, result } = await engine.execute(canonicalReq);
      const routerHeaders = buildRouterHeaders(decision);
      const displayModel = `${decision.selectedProvider}/${decision.selectedModel}`;

      if (result.kind === "stream") {
        const tapped = tapStreamUsage(result.stream, (usage) => {
          recordUsageToStore(
            store,
            config,
            canonicalReq,
            decision,
            usage,
            performance.now() - startMs,
            200,
          );
        });

        const byteStream =
          protocol === "openai"
            ? formatOpenAIStream(tapped, displayModel)
            : formatAnthropicStream(tapped, displayModel);

        return new Response(byteStream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            ...routerHeaders,
          },
        });
      }

      recordUsageToStore(
        store,
        config,
        canonicalReq,
        decision,
        result.response.usage,
        performance.now() - startMs,
        200,
      );

      const formatted =
        protocol === "openai"
          ? formatOpenAIResponse(result.response, displayModel)
          : formatAnthropicResponse(result.response, displayModel);

      return c.json(formatted, 200, routerHeaders);
    } catch (err) {
      const status =
        err instanceof UpstreamError ? err.status : 500;
      const message =
        err instanceof Error ? err.message : "Internal router error";
      return c.json(
        {
          error: {
            message,
            type: err instanceof UpstreamError ? "upstream_error" : "router_error",
          },
        },
        status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503 | 504,
      );
    }
  }

  app.post("/v1/chat/completions", (c) => handleLlmRequest("openai", c));
  app.post("/v1/messages", (c) => handleLlmRequest("anthropic", c));

  if (config.server.dashboardEnabled) {
    app.get("/_router", (c) => c.html(renderDashboardHtml()));

    app.get("/_router/api/stats", (c) => {
      const hoursParam = Number(c.req.query("hours") ?? 24);
      const hours = Number.isFinite(hoursParam) && hoursParam > 0 ? hoursParam : 24;
      return c.json(store.getStats(hours));
    });

    app.get("/_router/api/recent", (c) => {
      const limitParam = Number(c.req.query("limit") ?? 50);
      const limit =
        Number.isFinite(limitParam) && limitParam > 0
          ? Math.min(limitParam, 200)
          : 50;
      return c.json({ items: store.getRecentDecisions(limit) });
    });

    app.get("/_router/api/status", (c) => {
      return c.json({
        geminiQuota: engine.classifier.getQuotaStatus(config.decisionModel),
        circuitBreakers: engine.breaker.getSnapshot(),
      });
    });
  }

  return app;
}
