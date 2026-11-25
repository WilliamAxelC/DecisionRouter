#!/usr/bin/env node
import { loadConfig } from "./config/loader.js";
import { parseOpenAIRequest } from "./protocols/openai.js";
import { DecisionEngine } from "./router/engine.js";
import { startRouterServer } from "./index.js";
import { DecisionStore } from "./storage/db.js";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i += 1;
        } else {
          flags[arg.slice(2)] = "true";
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printUsage(): void {
  console.log(`DecisionRouter CLI

Usage:
  decision-router start [--config path] [--port 4000] [--host 127.0.0.1]
  decision-router stats [--hours 24] [--db path] [--config path]
  decision-router test-route "<prompt>" [--profile auto] [--config path]`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? "start";

  if (command === "help" || flags.help === "true") {
    printUsage();
    return;
  }

  if (command === "start") {
    const port = flags.port ? Number(flags.port) : undefined;
    startRouterServer({
      configPath: flags.config,
      host: flags.host,
      port: Number.isFinite(port) ? port : undefined,
    });
    return;
  }

  if (command === "stats") {
    let dbPath = flags.db;
    if (!dbPath) {
      const loaded = loadConfig(flags.config);
      dbPath = loaded.config.server.dbPath;
    }
    const hours = flags.hours ? Number(flags.hours) : 24;
    const store = new DecisionStore(dbPath);
    try {
      const stats = store.getStats(Number.isFinite(hours) ? hours : 24);
      console.log(JSON.stringify(stats, null, 2));
    } finally {
      store.close();
    }
    return;
  }

  if (command === "test-route") {
    const prompt = positional.slice(1).join(" ").trim();
    if (!prompt) {
      console.error('Error: provide a prompt, e.g. decision-router test-route "Fix the bug"');
      process.exit(1);
    }
    const profile = flags.profile ?? "auto";
    const loaded = loadConfig(flags.config);
    const engine = new DecisionEngine(loaded.config);
    const req = parseOpenAIRequest({
      model: profile,
      messages: [{ role: "user", content: prompt }],
    });
    const plan = await engine.decide(req);
    console.log(
      JSON.stringify(
        {
          decision: plan.decision,
          candidates: plan.candidates,
          features: {
            estimatedTotalTokens: plan.features.estimatedTotalTokens,
            hasImages: plan.features.hasImages,
            toolCount: plan.features.toolCount,
            isToolLoopContinuation: plan.features.isToolLoopContinuation,
            consecutiveToolErrors: plan.features.consecutiveToolErrors,
            repeatedToolLoop: plan.features.repeatedToolLoop,
            userCorrectionSignal: plan.features.userCorrectionSignal,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error("[DecisionRouter] Fatal error:", err);
  process.exit(1);
});
