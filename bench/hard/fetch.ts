import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sanitizeSchemaForGemini } from "../../src/providers/gemini-adapter.js";
import type { HardBenchTask, HardBenchToolDef } from "./types.js";

export const SUPPORTED_IFEVAL_INSTRUCTIONS = new Set<string>([
  "punctuation:no_comma",
  "length_constraints:number_words",
  "length_constraints:number_sentences",
  "length_constraints:number_paragraphs",
  "keywords:existence",
  "keywords:forbidden_words",
  "keywords:frequency",
  "keywords:letter_frequency",
  "detectable_format:json_format",
  "detectable_format:number_bullet_lists",
  "detectable_format:number_highlighted_sections",
  "detectable_format:title",
  "detectable_format:constrained_response",
  "change_case:english_lowercase",
  "change_case:english_capital",
  "startend:end_checker",
  "detectable_content:postscript",
  "detectable_content:number_placeholders",
]);

const INSTALLED_PYTHON_PACKAGES = new Set<string>([
  "numpy",
  "pandas",
  "scipy",
  "matplotlib",
  "requests",
  "bs4",
  "beautifulsoup4",
  "sklearn",
  "sympy",
  "PIL",
  "pytest",
]);

function getPythonStdlibSet(): Set<string> {
  const fallback = new Set([
    "os", "sys", "re", "json", "math", "random", "datetime", "time", "collections",
    "itertools", "functools", "subprocess", "csv", "zipfile", "glob", "pathlib",
    "threading", "socket", "ipaddress", "hashlib", "base64", "shutil", "tempfile",
    "io", "string", "statistics", "decimal", "fractions", "heapq", "bisect",
    "urllib", "http", "email", "html", "xml", "sqlite3", "unittest", "typing",
    "operator", "struct", "zlib", "gzip", "tarfile", "pickle", "copy", "enum",
    "dataclasses", "contextlib", "argparse", "logging", "warnings", "inspect",
    "traceback", "math", "cmath", "array", "queue", "multiprocessing", "concurrent",
  ]);
  for (const py of [".venv-bench/bin/python", "python3"]) {
    try {
      const abs = py.startsWith(".") ? path.resolve(py) : py;
      const out = execFileSync(
        abs,
        ["-c", "import sys, json; print(json.dumps(sorted(sys.stdlib_module_names)))"],
        { encoding: "utf8", timeout: 5000 },
      );
      const list = JSON.parse(out) as string[];
      for (const m of list) fallback.add(m);
      break;
    } catch {
      // try next python binary
    }
  }
  return fallback;
}

async function fetchJsonWithRetry<T>(url: string, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchTextWithRetry(url: string, retries = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface HfRowsResponse {
  rows: Array<{ row_idx: number; row: Record<string, unknown> }>;
}

async function fetchHfRows(
  dataset: string,
  config: string,
  split: string,
  offset: number,
  length: number,
): Promise<Array<{ row_idx: number; row: Record<string, unknown> }>> {
  const url =
    `https://datasets-server.huggingface.co/rows` +
    `?dataset=${encodeURIComponent(dataset)}` +
    `&config=${encodeURIComponent(config)}` +
    `&split=${encodeURIComponent(split)}` +
    `&offset=${offset}&length=${length}`;
  const json = await fetchJsonWithRetry<HfRowsResponse>(url);
  return json.rows ?? [];
}

function normalizeBfclSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object" };
  }
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const mapType = (t: string): string => {
    switch (t.toLowerCase()) {
      case "dict":
        return "object";
      case "float":
        return "number";
      case "int":
        return "integer";
      case "bool":
        return "boolean";
      case "list":
      case "tuple":
        return "array";
      case "any":
        return "string";
      default:
        return t.toLowerCase();
    }
  };

  for (const [k, v] of Object.entries(src)) {
    if (k === "type" && typeof v === "string") {
      out.type = mapType(v);
    } else if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const cleaned: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        cleaned[pk] = normalizeBfclSchema(pv);
      }
      out.properties = cleaned;
    } else if (k === "items") {
      out.items = normalizeBfclSchema(v);
    } else if (k === "enum" && Array.isArray(v)) {
      out.enum = v.map((item) => String(item));
    } else {
      out[k] = v;
    }
  }
  if (!out.type) out.type = "object";
  if (out.type === "array" && !out.items) {
    out.items = { type: "string" };
  }
  return sanitizeSchemaForGemini(out);
}

export function sanitizeToolName(rawName: string): string {
  return rawName.replace(/[^A-Za-z0-9_-]/g, "__").slice(0, 64);
}

function stratifiedTake<T>(
  items: T[],
  keyFn: (item: T) => string,
  count: number,
): T[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const list = buckets.get(k) ?? [];
    list.push(item);
    buckets.set(k, list);
  }
  const keys = [...buckets.keys()];
  const out: T[] = [];
  let idx = 0;
  while (out.length < count) {
    let pushed = false;
    for (const k of keys) {
      const list = buckets.get(k)!;
      if (idx < list.length && out.length < count) {
        out.push(list[idx]);
        pushed = true;
      }
    }
    if (!pushed) break;
    idx += 1;
  }
  return out;
}

async function fetchBigCodeBenchHard(count = 10): Promise<HardBenchTask[]> {
  const stdlib = getPythonStdlibSet();
  const allowedLibs = new Set([...stdlib, ...INSTALLED_PYTHON_PACKAGES]);
  const rows = [
    ...(await fetchHfRows("bigcode/bigcodebench-hard", "default", "v0.1.4", 0, 75)),
    ...(await fetchHfRows("bigcode/bigcodebench-hard", "default", "v0.1.4", 75, 73)),
  ];

  const candidates: HardBenchTask[] = [];
  for (const { row } of rows) {
    const libs = Array.isArray(row.libs) ? row.libs.map(String) : [];
    const testCode = String(row.test ?? "");
    const instructPrompt = String(row.instruct_prompt ?? "");
    const codePrompt = String(row.code_prompt ?? "");
    const entryPoint = String(row.entry_point ?? "task_func");
    const taskId = String(row.task_id ?? "");

    if (
      !libs.every((l) => allowedLibs.has(l.split(".")[0])) ||
      /ftplib|smtplib|telnetlib|wget|urllib\.request\.urlopen\(["']http|matplotlib\.pyplot\.show\(/i.test(
        testCode,
      ) ||
      /flask|seaborn|wordcloud|statsmodels|django|sqlite/i.test(testCode)
    ) {
      continue;
    }
    if (instructPrompt.length < 40 || testCode.length < 40) continue;

    candidates.push({
      id: `bcb-${taskId.replace(/[^A-Za-z0-9_-]+/g, "-")}`,
      family: "bigcodebench-hard",
      sourceDataset: "bigcode/bigcodebench-hard",
      sourceId: taskId,
      messages: [
        {
          role: "user",
          content:
            `${instructPrompt.trim()}\n\n` +
            `Starter signature/imports for reference:\n\`\`\`python\n${codePrompt.trim()}\n\`\`\`\n\n` +
            `Return a complete, self-contained runnable Python implementation of \`${entryPoint}\` inside a single \`\`\`python code block.`,
        },
      ],
      grader: {
        kind: "bigcodebench",
        entryPoint,
        codePrompt,
        testCode,
        libs,
      },
    });
  }

  // Spread across task numbers for variety
  const step = Math.max(1, Math.floor(candidates.length / count));
  const picked: HardBenchTask[] = [];
  for (let i = 0; i < candidates.length && picked.length < count; i += step) {
    picked.push(candidates[i]);
  }
  return picked.slice(0, count);
}

async function fetchAime25(count = 8): Promise<HardBenchTask[]> {
  const rows = await fetchHfRows("math-ai/aime25", "default", "test", 0, 30);
  return rows.slice(0, count).map(({ row }) => {
    const id = String(row.id ?? "0");
    return {
      id: `aime25-${id}`,
      family: "aime25",
      sourceDataset: "math-ai/aime25",
      sourceId: id,
      messages: [
        {
          role: "user",
          content:
            `Solve the following AIME 2025 competition math problem carefully. All AIME answers are integers from 000 to 999.\n\n` +
            `${String(row.problem ?? "").trim()}\n\n` +
            `Show your final integer answer in the form \\boxed{N} at the end.`,
        },
      ],
      grader: {
        kind: "aime25",
        expectedAnswer: String(row.answer ?? "").trim(),
      },
    };
  });
}

async function fetchLiveBenchReasoning(count = 8): Promise<HardBenchTask[]> {
  const rows = [
    ...(await fetchHfRows("livebench/reasoning", "default", "test", 0, 40)),
    ...(await fetchHfRows("livebench/reasoning", "default", "test", 65, 40)),
    ...(await fetchHfRows("livebench/reasoning", "default", "test", 130, 40)),
  ];
  const valid = rows
    .filter(({ row }) => {
      const turns = Array.isArray(row.turns) ? row.turns : [];
      return typeof turns[0] === "string" && turns[0].length > 20 && turns[0].length <= 9000;
    })
    .map(({ row }) => {
      const qid = String(row.question_id ?? "");
      const task = String(row.task ?? "reasoning");
      const turns = row.turns as string[];
      return {
        id: `lb-reas-${qid.slice(0, 10)}`,
        family: "livebench-reasoning" as const,
        sourceDataset: "livebench/reasoning",
        sourceId: qid,
        messages: [{ role: "user" as const, content: turns[0] }],
        grader: {
          kind: "livebench-exact" as const,
          subtask: task,
          expectedAnswer: String(row.ground_truth ?? "").trim(),
        },
      };
    });
  return stratifiedTake(valid, (t) => (t.grader as { subtask: string }).subtask, count);
}

async function fetchLiveBenchMath(count = 8): Promise<HardBenchTask[]> {
  const rows = [
    ...(await fetchHfRows("livebench/math", "default", "test", 0, 40)),
    ...(await fetchHfRows("livebench/math", "default", "test", 120, 40)),
    ...(await fetchHfRows("livebench/math", "default", "test", 240, 40)),
  ];
  const valid = rows
    .filter(({ row }) => {
      const turns = Array.isArray(row.turns) ? row.turns : [];
      const gt = String(row.ground_truth ?? "").trim();
      return (
        typeof turns[0] === "string" &&
        turns[0].length > 20 &&
        turns[0].length <= 8000 &&
        gt.length > 0 &&
        gt.length <= 120
      );
    })
    .map(({ row }) => {
      const qid = String(row.question_id ?? "");
      const subtask = String(row.subtask ?? row.task ?? "math");
      const turns = row.turns as string[];
      return {
        id: `lb-math-${qid.slice(0, 10)}`,
        family: "livebench-math" as const,
        sourceDataset: "livebench/math",
        sourceId: qid,
        messages: [{ role: "user" as const, content: turns[0] }],
        grader: {
          kind: "livebench-exact" as const,
          subtask,
          expectedAnswer: String(row.ground_truth ?? "").trim(),
          expressions: row.expressions,
        },
      };
    });
  return stratifiedTake(valid, (t) => (t.grader as { subtask: string }).subtask, count);
}

async function fetchLiveBenchData(count = 8): Promise<HardBenchTask[]> {
  const rows = [
    ...(await fetchHfRows("livebench/data_analysis", "default", "test", 0, 40)),
    ...(await fetchHfRows("livebench/data_analysis", "default", "test", 50, 40)),
    ...(await fetchHfRows("livebench/data_analysis", "default", "test", 100, 40)),
  ];
  const valid = rows
    .filter(({ row }) => {
      const turns = Array.isArray(row.turns) ? row.turns : [];
      const gt = String(row.ground_truth ?? "").trim();
      return (
        typeof turns[0] === "string" &&
        turns[0].length > 30 &&
        turns[0].length <= 10000 &&
        gt.length > 0
      );
    })
    .map(({ row }) => {
      const qid = String(row.question_id ?? "");
      const subtask = String(row.task ?? "data_analysis");
      const turns = row.turns as string[];
      return {
        id: `lb-data-${qid.slice(0, 10)}`,
        family: "livebench-data" as const,
        sourceDataset: "livebench/data_analysis",
        sourceId: qid,
        messages: [{ role: "user" as const, content: turns[0] }],
        grader: {
          kind: "livebench-data" as const,
          subtask,
          expectedAnswer: String(row.ground_truth ?? "").trim(),
        },
      };
    });
  return stratifiedTake(valid, (t) => (t.grader as { subtask: string }).subtask, count);
}

async function fetchSimpleQaVerified(count = 10): Promise<HardBenchTask[]> {
  const rows = await fetchHfRows(
    "google/simpleqa-verified",
    "simpleqa_verified",
    "eval",
    0,
    80,
  );
  const valid = rows.map(({ row, row_idx }) => {
    const idx = String(row.original_index ?? row_idx);
    return {
      id: `sqa-${idx}`,
      family: "simpleqa-verified" as const,
      sourceDataset: "google/simpleqa-verified",
      sourceId: idx,
      messages: [
        {
          role: "user" as const,
          content:
            `${String(row.problem ?? "").trim()}\n\n` +
            `Answer as concisely and accurately as possible (just the direct answer; if you are not certain, give your best single factual answer without hedging).`,
        },
      ],
      grader: {
        kind: "simpleqa" as const,
        expectedAnswer: String(row.answer ?? "").trim(),
        topic: String(row.topic ?? ""),
        answerType: String(row.answer_type ?? ""),
      },
    };
  });
  return stratifiedTake(valid, (t) => (t.grader as { topic: string }).topic, count);
}

async function fetchIfEval(count = 10): Promise<HardBenchTask[]> {
  const rows = await fetchHfRows("google/IFEval", "default", "train", 0, 100);
  const picked: HardBenchTask[] = [];
  for (const { row } of rows) {
    const ids = Array.isArray(row.instruction_id_list)
      ? row.instruction_id_list.map(String)
      : [];
    const kwargs = Array.isArray(row.kwargs)
      ? (row.kwargs as Array<Record<string, unknown>>)
      : [];
    if (ids.length === 0 || !ids.every((id) => SUPPORTED_IFEVAL_INSTRUCTIONS.has(id))) {
      continue;
    }
    const key = String(row.key ?? picked.length);
    picked.push({
      id: `ifeval-${key}`,
      family: "ifeval",
      sourceDataset: "google/IFEval",
      sourceId: key,
      messages: [{ role: "user", content: String(row.prompt ?? "").trim() }],
      grader: {
        kind: "ifeval",
        instructionIdList: ids,
        kwargsList: kwargs,
      },
    });
    if (picked.length >= count) break;
  }
  return picked;
}

async function fetchBfclV4(count = 10): Promise<HardBenchTask[]> {
  const [promptsRaw, answersRaw] = await Promise.all([
    fetchTextWithRetry(
      "https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/bfcl_eval/data/BFCL_v4_live_multiple.json",
    ),
    fetchTextWithRetry(
      "https://raw.githubusercontent.com/ShishirPatil/gorilla/main/berkeley-function-call-leaderboard/bfcl_eval/data/possible_answer/BFCL_v4_live_multiple.json",
    ),
  ]);

  const ansMap = new Map<string, Array<Record<string, Record<string, unknown[]>>>>();
  for (const line of answersRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed) as {
      id: string;
      ground_truth: Array<Record<string, Record<string, unknown[]>>>;
    };
    ansMap.set(obj.id, obj.ground_truth);
  }

  const picked: HardBenchTask[] = [];
  const promptLines = promptsRaw.split("\n").filter((l) => l.trim().length > 0);
  const step = Math.max(1, Math.floor(promptLines.length / (count * 3)));

  for (let i = 0; i < promptLines.length && picked.length < count; i += step) {
    const obj = JSON.parse(promptLines[i]) as {
      id: string;
      question: Array<Array<{ role: string; content: string }>>;
      function: Array<{
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
      }>;
    };
    const possible = ansMap.get(obj.id);
    if (!possible || !Array.isArray(obj.function) || obj.function.length === 0) continue;
    const firstTurn = obj.question?.[0] ?? [];
    const userMsg = firstTurn.find((m) => m.role === "user")?.content?.trim();
    if (!userMsg || firstTurn.length > 3) continue;

    const tools: HardBenchToolDef[] = obj.function.map((fn) => ({
      name: sanitizeToolName(fn.name),
      description: String(fn.description ?? "").slice(0, 600),
      parameters: normalizeBfclSchema(fn.parameters ?? { type: "object" }),
    }));

    const messages = firstTurn
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: String(m.content ?? ""),
      }));
    if (messages[messages.length - 1]?.role !== "user") continue;

    picked.push({
      id: `bfcl-${obj.id}`,
      family: "bfcl-v4",
      sourceDataset: "gorilla-llm/BFCL_v4_live_multiple",
      sourceId: obj.id,
      messages,
      tools,
      grader: {
        kind: "bfcl",
        possibleAnswers: possible,
      },
    });
  }
  return picked;
}

async function fetchMultiChallenge(count = 8): Promise<HardBenchTask[]> {
  const rows = await fetchHfRows("ScaleAI/MultiChallenge", "default", "test", 0, 80);
  const valid: HardBenchTask[] = [];
  for (const { row } of rows) {
    const qid = String(row.question_id ?? "");
    const axis = String(row.axis ?? "");
    const conv = row.conversation as
      | { role?: string[]; content?: string[] }
      | Array<{ role: string; content: string }>;
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (Array.isArray(conv)) {
      for (const m of conv) {
        if ((m.role === "user" || m.role === "assistant") && m.content) {
          messages.push({ role: m.role, content: String(m.content) });
        }
      }
    } else if (conv && Array.isArray(conv.role) && Array.isArray(conv.content)) {
      for (let i = 0; i < Math.min(conv.role.length, conv.content.length); i++) {
        const r = conv.role[i];
        const c = conv.content[i];
        if ((r === "user" || r === "assistant") && c) {
          messages.push({ role: r, content: String(c) });
        }
      }
    }
    const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
    if (
      messages.length < 2 ||
      messages[messages.length - 1].role !== "user" ||
      totalChars > 14_000
    ) {
      continue;
    }

    valid.push({
      id: `mc-${qid.slice(0, 12)}`,
      family: "multichallenge",
      sourceDataset: "ScaleAI/MultiChallenge",
      sourceId: qid,
      messages,
      grader: {
        kind: "multichallenge",
        axis,
        targetQuestion: String(row.target_question ?? ""),
        passCriteria: String(row.pass_criteria ?? "YES"),
      },
    });
  }
  return stratifiedTake(valid, (t) => (t.grader as { axis: string }).axis, count);
}

export async function fetchHardBenchTasks(opts?: {
  cachePath?: string;
  refresh?: boolean;
}): Promise<HardBenchTask[]> {
  const cachePath = path.resolve(
    opts?.cachePath ?? "data/benchmarks/hard-suite/tasks.json",
  );
  if (!opts?.refresh && fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as HardBenchTask[];
    if (Array.isArray(cached) && cached.length >= 40) {
      return cached;
    }
  }

  const [
    bcb,
    aime,
    lbReas,
    lbMath,
    lbData,
    sqa,
    ifeval,
    bfcl,
    mc,
  ] = await Promise.all([
    fetchBigCodeBenchHard(10),
    fetchAime25(8),
    fetchLiveBenchReasoning(8),
    fetchLiveBenchMath(8),
    fetchLiveBenchData(8),
    fetchSimpleQaVerified(10),
    fetchIfEval(10),
    fetchBfclV4(10),
    fetchMultiChallenge(8),
  ]);

  const tasks = [
    ...bcb,
    ...aime,
    ...lbReas,
    ...lbMath,
    ...lbData,
    ...sqa,
    ...ifeval,
    ...bfcl,
    ...mc,
  ];

  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(tasks, null, 2), "utf8");
  return tasks;
}
