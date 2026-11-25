import { serve } from "@hono/node-server";
import { loadConfig } from "./config/loader.js";
import type { RouterConfig } from "./config/schema.js";
import { DecisionEngine } from "./router/engine.js";
import { createApp } from "./server.js";
import { DecisionStore } from "./storage/db.js";

export * from "./types/ir.js";
export * from "./config/schema.js";
export * from "./config/loader.js";
export { DecisionEngine } from "./router/engine.js";
export { DecisionStore } from "./storage/db.js";
export { createApp } from "./server.js";

export function startRouterServer(overrides?: {
  configPath?: string;
  host?: string;
  port?: number;
}) {
  const loaded = loadConfig(overrides?.configPath);
  const config: RouterConfig = loaded.config;
  if (overrides?.host) config.server.host = overrides.host;
  if (overrides?.port) config.server.port = overrides.port;

  if (loaded.usedFallbackExample) {
    console.warn(
      `[DecisionRouter] Using fallback config: ${loaded.configPath} (create config.yaml to customize)`,
    );
  }

  if (config.decisionModel.apiKeys.length === 0) {
    console.warn(
      "[DecisionRouter] GEMINI_API_KEY not set — decision engine will run in fast-path + heuristic mode.",
    );
  }

  const store = new DecisionStore(config.server.dbPath);
  const engine = new DecisionEngine(config);
  const app = createApp({ config, engine, store });

  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.server.host,
      port: config.server.port,
    },
    (info) => {
      const base = `http://${config.server.host}:${info.port}`;
      console.log(`[DecisionRouter] Listening on ${base}`);
      console.log(`[DecisionRouter]   OpenAI endpoint:    ${base}/v1/chat/completions`);
      console.log(`[DecisionRouter]   Anthropic endpoint: ${base}/v1/messages`);
      if (config.server.dashboardEnabled) {
        console.log(`[DecisionRouter]   Dashboard UI:       ${base}/_router`);
      }
    },
  );

  const shutdown = () => {
    server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, store, engine, config };
}
