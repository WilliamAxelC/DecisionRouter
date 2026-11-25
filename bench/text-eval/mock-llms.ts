import http from "node:http";
import { RouterConfigSchema, type RouterConfig } from "../../src/config/schema.js";

export interface TextEvalMockServers {
  classifierUrl: string;
  openaiUrl: string;
  anthropicUrl: string;
  geminiUrl: string;
  close: () => Promise<void>;
}

const LIGHT_ANSWERS: Array<[RegExp, string]> = [
  // decision-triage (7/8 right, 1 miss on JSON or subtle case -> 87.5%)
  [/classify the sentiment/i, "FINAL: NEGATIVE"],
  [/route this support ticket/i, "FINAL: SECURITY"],
  [/assign incident severity/i, "FINAL: P0"],
  [/contain pii/i, "FINAL: YES"],
  [/safe or phishing/i, "FINAL: PHISHING"],
  [/classify user intent/i, "FINAL: REFUND"],
  [/iso language code/i, "FINAL: FR"],
  [/purchased 45 days ago/i, '{"eligible":false,"reason_code":"OUT_OF_WINDOW"}'],

  // easy-text (6/6 right)
  [/35 degrees celsius/i, "FINAL: 95"],
  [/5 days after 2024-02-27/i, "FINAL: 2024-03-03"],
  [/acme coffee roasters/i, '{"vendor":"Acme Coffee Roasters","total":13.5}'],
  [/active admins/i, "FINAL: Ada,Cai"],
  [/capital city of australia/i, "FINAL: Canberra"],
  [/cron expression/i, "FINAL: 96"],

  // medium-reasoning (4/6 right, 2 realistic slips)
  [/warehouse a holds 140/i, "FINAL: 100"],
  [/list price \$200/i, "FINAL: 194.00"], // forgot order of tax/discount or shipping
  [/reduce\(\(acc, x\)/i, "FINAL: 18"],
  [/having sum\(amount\) >= 110/i, "FINAL: 2"],
  [/non-overlapping matches/i, "FINAL: 4"], // miscounted def345
  [/4,500 monthly fixed costs/i, "FINAL: 180"],

  // hard-reasoning (1/6 right)
  [/four engineers \(alice, bob, cara, dan\)/i, "FINAL: Dan"],
  [/rare bug affects 1%/i, "FINAL: 90"],
  [/def f\(x, acc=\[\]\)/i, "FINAL: 7"],
  [/buggy binary search/i, "FINAL: 3"],
  [/analog clock at 3:40/i, "FINAL: 120"],
  [/ttl=0 bypass storage/i, "FINAL: INVALID"],

  // multi-turn-escalation Turn 1 (classic intuitive traps!)
  [/bat and a ball/i, "FINAL: 0.10"],
  [/patch of lily pads/i, "FINAL: 24"],
  [/rises by 25% on monday/i, "FINAL: 5"],
  [/settimeout\(\(\) => console\.log\(2\)/i, "FINAL: 1,4,2,3"],
];

const SMART_ANSWERS: Array<[RegExp, string]> = [
  [/classify the sentiment/i, "FINAL: NEGATIVE"],
  [/route this support ticket/i, "FINAL: SECURITY"],
  [/assign incident severity/i, "FINAL: P0"],
  [/contain pii/i, "FINAL: YES"],
  [/safe or phishing/i, "FINAL: PHISHING"],
  [/classify user intent/i, "FINAL: REFUND"],
  [/iso language code/i, "FINAL: FR"],
  [/purchased 45 days ago/i, '{"eligible":false,"reason_code":"EXPIRED"}'],

  [/35 degrees celsius/i, "FINAL: 95"],
  [/5 days after 2024-02-27/i, "FINAL: 2024-03-03"],
  [/acme coffee roasters/i, '{"vendor":"Acme Coffee Roasters","total":13.5}'],
  [/active admins/i, "FINAL: Ada,Cai"],
  [/capital city of australia/i, "FINAL: Canberra"],
  [/cron expression/i, "FINAL: 96"],

  [/warehouse a holds 140/i, "FINAL: 100"],
  [/list price \$200/i, "FINAL: 195.6"],
  [/reduce\(\(acc, x\)/i, "FINAL: 18"],
  [/having sum\(amount\) >= 110/i, "FINAL: 2"],
  [/non-overlapping matches/i, "FINAL: 3"],
  [/4,500 monthly fixed costs/i, "FINAL: 180"],

  [/four engineers \(alice, bob, cara, dan\)/i, "FINAL: Cara"],
  [/rare bug affects 1%/i, "FINAL: 15.4"],
  [/def f\(x, acc=\[\]\)/i, "FINAL: 10"],
  [/buggy binary search/i, "FINAL: 2"],
  [/analog clock at 3:40/i, "FINAL: 130"],
  [/ttl=0 bypass storage/i, "FINAL: INVALID"],

  // multi-turn-escalation (Turn 1 or Turn 2 correction)
  [/bat and a ball|bat - ball = 1\.00/i, "FINAL: 0.05"],
  [/patch of lily pads|doubles each day/i, "FINAL: 47"],
  [/rises by 25% on monday|100 \* 1\.25 \* 0\.80/i, "FINAL: 0"],
  [/settimeout\(\(\) => console\.log\(2\)|microtask queue/i, "FINAL: 1,4,3,2"],
];

function lookupAnswer(table: Array<[RegExp, string]>, text: string): string {
  for (const [pattern, answer] of table) {
    if (pattern.test(text)) return answer;
  }
  return "FINAL: UNKNOWN";
}

function simulateClassifier(
  compactJson: string,
  allowSelfAnswer: boolean,
): Record<string, unknown> {
  let recentTurn = "";
  try {
    const parsed = JSON.parse(compactJson) as { recentTurn?: string };
    recentTurn = String(parsed.recentTurn ?? "");
  } catch {
    recentTurn = compactJson;
  }

  // Pure decision-triage tasks -> choose "self" with directAnswer when enabled!
  if (allowSelfAnswer) {
    if (/classify the sentiment/i.test(recentTurn)) {
      return { tier: "self", confidence: 0.96, reason: "simple sentiment label", directAnswer: "FINAL: NEGATIVE" };
    }
    if (/route this support ticket/i.test(recentTurn)) {
      return { tier: "self", confidence: 0.97, reason: "queue classification", directAnswer: "FINAL: SECURITY" };
    }
    if (/assign incident severity/i.test(recentTurn)) {
      return { tier: "self", confidence: 0.98, reason: "severity triage", directAnswer: "FINAL: P0" };
    }
    if (/contain pii/i.test(recentTurn)) {
      return { tier: "self", confidence: 0.99, reason: "binary PII check", directAnswer: "FINAL: YES" };
    }
    if (/safe or phishing/i.test(recentTurn)) {
      return { tier: "self", confidence: 0.97, reason: "phishing triage", directAnswer: "FINAL: PHISHING" };
    }
    if (/classify user intent/i.test(recentTurn)) {
      return { tier: "self", confidence: 0.96, reason: "intent classification", directAnswer: "FINAL: REFUND" };
    }
    if (/iso language code/i.test(recentTurn)) {
      return { tier: "self", confidence: 0.99, reason: "language detection", directAnswer: "FINAL: FR" };
    }
    if (/purchased 45 days ago/i.test(recentTurn)) {
      return {
        tier: "self",
        confidence: 0.94,
        reason: "policy decision JSON",
        directAnswer: '{"eligible":false,"reason_code":"EXPIRED"}',
      };
    }
  }

  // Hard reasoning tasks -> route to complex / frontier
  if (
    /four engineers|rare bug affects 1%|acc=\[\]|buggy binary search|analog clock at 3:40|ttl=0 bypass storage/i.test(
      recentTurn,
    )
  ) {
    return {
      tier: "complex",
      confidence: 0.91,
      reason: "multi-step formal/code/math reasoning",
    };
  }

  // Medium reasoning -> standard
  if (
    /warehouse a holds|list price \$200|reduce\(\(acc, x\)|having sum\(amount\)|non-overlapping matches|4,500 monthly/i.test(
      recentTurn,
    )
  ) {
    return {
      tier: "standard",
      confidence: 0.85,
      reason: "moderate calculation/trace",
    };
  }

  // Easy & deceptive Turn 1 intuition traps -> trivial
  return {
    tier: "trivial",
    confidence: 0.88,
    reason: "short direct question",
  };
}

function extractTextFromBody(body: Record<string, unknown>): string {
  if (Array.isArray(body.messages)) {
    return JSON.stringify(body.messages);
  }
  if (Array.isArray(body.contents)) {
    return JSON.stringify(body.contents);
  }
  return JSON.stringify(body);
}

async function startServer(
  handler: (req: http.IncomingMessage, body: Record<string, unknown>, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      handler(req, parsed, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

export async function startTextEvalMockServers(opts?: {
  fast?: boolean;
}): Promise<TextEvalMockServers> {
  const fast = Boolean(opts?.fast);
  const classifierDelay = fast ? 6 : 85;
  const lightDelay = fast ? 12 : 170;
  const smartDelay = fast ? 65 : 820;

  const classifier = await startServer((_req, body, res) => {
    const contents = Array.isArray(body.contents) ? body.contents : [];
    const first = (contents[0] ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(first.parts) ? first.parts : [];
    const compactJson = String((parts[0] as { text?: unknown } | undefined)?.text ?? "{}");
    const genCfg = (body.generationConfig ?? {}) as Record<string, unknown>;
    const schema = (genCfg.responseSchema ?? {}) as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    const allowSelf = Boolean(props.directAnswer);

    const decision = simulateClassifier(compactJson, allowSelf);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(decision) }],
              },
            },
          ],
        }),
      );
    }, classifierDelay);
  });

  const gemini = await startServer((_req, body, res) => {
    const text = extractTextFromBody(body);
    const ans = lookupAnswer(LIGHT_ANSWERS, text);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          responseId: "gem_eval",
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: ans }] } }],
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 15 },
        }),
      );
    }, lightDelay);
  });

  const openai = await startServer((_req, body, res) => {
    const text = extractTextFromBody(body);
    const model = String(body.model ?? "");
    const isSmart = /gpt-4\.1$|o4/i.test(model);
    const ans = lookupAnswer(isSmart ? SMART_ANSWERS : LIGHT_ANSWERS, text);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl_eval",
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: ans }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 80, completion_tokens: isSmart ? 45 : 15 },
        }),
      );
    }, isSmart ? smartDelay : lightDelay);
  });

  const anthropic = await startServer((_req, body, res) => {
    const text = extractTextFromBody(body);
    const model = String(body.model ?? "");
    const isLight = /haiku/i.test(model);
    const ans = lookupAnswer(isLight ? LIGHT_ANSWERS : SMART_ANSWERS, text);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_eval",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: ans }],
          stop_reason: "end_turn",
          usage: { input_tokens: 80, output_tokens: isLight ? 15 : 55 },
        }),
      );
    }, isLight ? lightDelay : smartDelay);
  });

  return {
    classifierUrl: classifier.url,
    openaiUrl: openai.url,
    anthropicUrl: anthropic.url,
    geminiUrl: gemini.url,
    close: async () => {
      await Promise.all(
        [classifier.server, openai.server, anthropic.server, gemini.server].map(
          (s) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      );
    },
  };
}

export function buildTextEvalSimConfig(mocks: TextEvalMockServers): RouterConfig {
  return RouterConfigSchema.parse({
    server: { dashboardEnabled: false },
    decisionModel: {
      baseUrl: mocks.classifierUrl,
      timeoutMs: 600,
      cacheTtlSec: 0,
      allowSelfAnswer: true,
      apiKeys: ["sim-key"],
      models: [{ id: "gemini-2.5-flash-lite", rpm: 500, rpd: 10000 }],
    },
    providers: {
      gemini: {
        type: "gemini",
        baseUrl: mocks.geminiUrl,
        apiKey: "sim-gem",
        models: {
          "gemini-2.5-flash-lite": {
            contextWindow: 1000000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 0.1,
            cachedInputPer1M: 0.025,
            outputPer1M: 0.4,
          },
          "gemini-2.5-flash": {
            contextWindow: 1000000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 0.3,
            cachedInputPer1M: 0.075,
            outputPer1M: 2.5,
          },
        },
      },
      openai: {
        type: "openai",
        baseUrl: mocks.openaiUrl,
        apiKey: "sim-oa",
        models: {
          "gpt-4.1-mini": {
            contextWindow: 1047576,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 0.4,
            cachedInputPer1M: 0.1,
            outputPer1M: 1.6,
          },
          "gpt-4.1": {
            contextWindow: 1047576,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 2.0,
            cachedInputPer1M: 0.5,
            outputPer1M: 8.0,
          },
        },
      },
      anthropic: {
        type: "anthropic",
        baseUrl: mocks.anthropicUrl,
        apiKey: "sim-ant",
        models: {
          "claude-sonnet-4-6": {
            contextWindow: 200000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 3.0,
            cachedInputPer1M: 0.3,
            outputPer1M: 15.0,
          },
          "claude-opus-4-6": {
            contextWindow: 200000,
            supportsVision: true,
            supportsTools: true,
            inputPer1M: 15.0,
            cachedInputPer1M: 1.5,
            outputPer1M: 75.0,
          },
        },
      },
    },
    tiers: {
      trivial: [{ provider: "gemini", model: "gemini-2.5-flash-lite" }],
      standard: [{ provider: "gemini", model: "gemini-2.5-flash" }],
      complex: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
      frontier: [{ provider: "anthropic", model: "claude-opus-4-6" }],
    },
  });
}
