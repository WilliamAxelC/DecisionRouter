import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HardBenchGraderSpec, HardBenchTask, HardBenchToolCall } from "./types.js";

export interface HardGradeResult {
  passed: boolean;
  detail: string;
}

export type DecisionNoulJudgeFn = (
  input: string,
  instruction: string,
) => Promise<number | null>;

function resolveBenchPython(): string {
  const venvPy = path.resolve(".venv-bench/bin/python");
  return fs.existsSync(venvPy) ? venvPy : "python3";
}

export function extractPythonCode(raw: string): string {
  const trimmed = raw.trim();
  const fenced = [...trimmed.matchAll(/```(?:python|py)?\s*\r?\n([\s\S]*?)```/gi)];
  if (fenced.length > 0) {
    // Pick longest code block in case explanation included a small snippet
    return fenced
      .map((m) => m[1].trim())
      .sort((a, b) => b.length - a.length)[0];
  }
  return trimmed.replace(/^```(?:python|py)?/i, "").replace(/```$/i, "").trim();
}

export function gradeBigCodeBenchHard(
  responseText: string,
  grader: Extract<HardBenchGraderSpec, { kind: "bigcodebench" }>,
): HardGradeResult {
  const code = extractPythonCode(responseText);
  if (!code || code.length < 10) {
    return { passed: false, detail: "empty python solution" };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-bcb-"));
  const scriptPath = path.join(tmpDir, "test_solution.py");
  const fullScript = [
    code,
    "",
    "# --- BigCodeBench Unit Tests ---",
    grader.testCode,
    "",
    'if __name__ == "__main__":',
    "    import unittest",
    "    unittest.main(verbosity=1)",
    "",
  ].join("\n");

  fs.writeFileSync(scriptPath, fullScript, "utf8");

  try {
    execFileSync(resolveBenchPython(), ["-I", scriptPath], {
      cwd: tmpDir,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MPLBACKEND: "Agg",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
      },
    });
    return { passed: true, detail: `pytest/unittest passed (${grader.entryPoint})` };
  } catch (err) {
    const e = err as { status?: number; killed?: boolean; signal?: string; stderr?: string; stdout?: string };
    if (e.killed || e.signal === "SIGTERM") {
      return { passed: false, detail: "execution timed out (>15s)" };
    }
    const msg = String(e.stderr || e.stdout || "unittest failed")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-3)
      .join(" | ")
      .slice(0, 180);
    return { passed: false, detail: `python test failed: ${msg}` };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function extractLastBoxed(text: string): string | null {
  const results: string[] = [];
  let idx = 0;
  while (idx < text.length) {
    const pos = text.indexOf("\\boxed{", idx);
    if (pos === -1) break;
    let depth = 0;
    let i = pos + "\\boxed{".length;
    const start = i;
    depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    if (depth === 0) {
      results.push(text.slice(start, i - 1).trim());
    }
    idx = i;
  }
  return results.length > 0 ? results[results.length - 1] : null;
}

export function gradeAime25(responseText: string, expectedAnswer: string): HardGradeResult {
  const expectedInt = Number.parseInt(expectedAnswer.replace(/[^\d-]/g, ""), 10);
  if (Number.isNaN(expectedInt)) {
    return { passed: false, detail: `invalid gold answer: ${expectedAnswer}` };
  }

  const boxed = extractLastBoxed(responseText);
  if (boxed !== null) {
    const m = boxed.replace(/,/g, "").match(/-?\d+/);
    if (m) {
      const got = Number.parseInt(m[0], 10);
      return {
        passed: got === expectedInt,
        detail: `boxed=${got}, expected=${expectedInt}`,
      };
    }
  }

  const explicit = responseText.match(
    /(?:final answer(?:\s+is)?|answer\s*[:=]|FINAL:)\s*\*?\*?(-?\d{1,4})\b/i,
  );
  if (explicit) {
    const got = Number.parseInt(explicit[1], 10);
    return {
      passed: got === expectedInt,
      detail: `extracted=${got}, expected=${expectedInt}`,
    };
  }

  const tailNums = responseText.trim().slice(-200).match(/\b\d{1,3}\b/g);
  if (tailNums && tailNums.length > 0) {
    const got = Number.parseInt(tailNums[tailNums.length - 1], 10);
    return {
      passed: got === expectedInt,
      detail: `tail=${got}, expected=${expectedInt}`,
    };
  }

  return { passed: false, detail: `no integer found (expected ${expectedInt})` };
}

function normalizeTokenText(s: string): string {
  return s
    .replace(/\*\*/g, "")
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "$1/$2")
    .replace(/[\s,]+/g, " ")
    .replace(/[.;:!?]+$/g, "")
    .trim()
    .toLowerCase();
}

function normalizeTupleCsv(s: string): string {
  return s
    .split(",")
    .map((p) => p.replace(/\*\*/g, "").trim().toLowerCase())
    .filter(Boolean)
    .join(",");
}

export function gradeLiveBenchExact(
  responseText: string,
  expectedAnswer: string,
): HardGradeResult {
  const trimmed = responseText.trim();
  if (!trimmed) return { passed: false, detail: "empty response" };

  const expNorm = normalizeTokenText(expectedAnswer);
  const expCsv = normalizeTupleCsv(expectedAnswer);

  const candidates: string[] = [];
  const boxed = extractLastBoxed(trimmed);
  if (boxed) candidates.push(boxed);

  for (const m of trimmed.matchAll(/\*\*([^*\n]{1,120})\*\*/g)) {
    candidates.push(m[1]);
  }
  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 0) candidates.push(lines[lines.length - 1]);
  candidates.push(trimmed);

  for (const cand of candidates) {
    if (normalizeTokenText(cand) === expNorm) {
      return { passed: true, detail: `matched exact '${expectedAnswer}'` };
    }
    if (expectedAnswer.includes(",") && normalizeTupleCsv(cand) === expCsv) {
      return { passed: true, detail: `matched csv '${expCsv}'` };
    }
    // Check standalone number match inside candidate line
    const numExp = expectedAnswer.replace(/,/g, "").trim();
    if (/^-?\d+(?:\.\d+)?$/.test(numExp)) {
      const m = cand.replace(/,/g, "").match(/(?:^|\s|=)(-?\d+(?:\.\d+)?)(?:\s|$|\.)/);
      if (m && Number(m[1]) === Number(numExp)) {
        return { passed: true, detail: `matched numeric ${numExp}` };
      }
    }
  }

  return {
    passed: false,
    detail: `got '${(boxed ?? lines[lines.length - 1] ?? "").slice(0, 60)}', expected '${expectedAnswer.slice(0, 60)}'`,
  };
}

function deepJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-4;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    if (
      (typeof a === "number" || typeof a === "string") &&
      (typeof b === "number" || typeof b === "string") &&
      !Number.isNaN(Number(a)) &&
      !Number.isNaN(Number(b))
    ) {
      return Math.abs(Number(a) - Number(b)) <= 1e-4;
    }
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, idx) => deepJsonEqual(v, b[idx]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length || !ak.every((k, i) => k === bk[i])) {
      return false;
    }
    return ak.every((k) => deepJsonEqual(ao[k], bo[k]));
  }
  return false;
}

function extractJsonBlock(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw.trim();
  const objStart = body.indexOf("{");
  const arrStart = body.indexOf("[");
  let start = -1;
  if (objStart !== -1 && arrStart !== -1) start = Math.min(objStart, arrStart);
  else start = Math.max(objStart, arrStart);
  if (start === -1) return body;
  const endChar = body[start] === "[" ? "]" : "}";
  const end = body.lastIndexOf(endChar);
  return end > start ? body.slice(start, end + 1) : body;
}

export function gradeLiveBenchData(
  responseText: string,
  expectedAnswer: string,
  subtask: string,
): HardGradeResult {
  const trimmed = responseText.trim();
  if (!trimmed) return { passed: false, detail: "empty response" };

  if (expectedAnswer.startsWith("{") || expectedAnswer.startsWith("[")) {
    try {
      const expObj = JSON.parse(expectedAnswer);
      const gotObj = JSON.parse(extractJsonBlock(trimmed));
      const eq = deepJsonEqual(gotObj, expObj);
      return {
        passed: eq,
        detail: eq
          ? `JSON deep equal (${subtask})`
          : `JSON mismatch (${subtask})`,
      };
    } catch {
      return { passed: false, detail: `invalid JSON (${subtask})` };
    }
  }

  return gradeLiveBenchExact(trimmed, expectedAnswer);
}

function countWords(text: string): number {
  return (text.match(/[A-Za-z0-9']+/g) ?? []).length;
}

function countSentences(text: string): number {
  const chunks = text
    .split(/[.!?]+(?:\s+|$)/)
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z0-9]/.test(s));
  return chunks.length;
}

function checkSingleIfEvalConstraint(
  text: string,
  instructionId: string,
  kw: Record<string, unknown>,
): boolean {
  const numVal = Number(
    kw.num_words ??
      kw.num_sentences ??
      kw.num_paragraphs ??
      kw.frequency ??
      kw.let_frequency ??
      kw.num_bullets ??
      kw.num_highlights ??
      kw.num_placeholders ??
      0,
  );
  const relation = String(kw.relation ?? "at least").toLowerCase();
  const cmp = (actual: number, target: number): boolean => {
    if (relation.includes("less")) return actual < target;
    if (relation.includes("equal") || relation === "exact") return actual === target;
    return actual >= target;
  };

  switch (instructionId) {
    case "punctuation:no_comma":
      return !text.includes(",");

    case "length_constraints:number_words":
      return cmp(countWords(text), numVal);

    case "length_constraints:number_sentences":
      return cmp(countSentences(text), numVal);

    case "length_constraints:number_paragraphs": {
      const paras = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
      if (kw.num_paragraphs !== undefined && kw.num_paragraphs !== null) {
        return paras.length === Number(kw.num_paragraphs);
      }
      return true;
    }

    case "keywords:existence": {
      const words = Array.isArray(kw.keywords) ? kw.keywords.map(String) : [];
      const lower = text.toLowerCase();
      return words.every((w) => lower.includes(w.toLowerCase()));
    }

    case "keywords:forbidden_words": {
      const words = Array.isArray(kw.forbidden_words)
        ? kw.forbidden_words.map(String)
        : [];
      const lower = text.toLowerCase();
      return words.every((w) => {
        const escaped = w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return !new RegExp(`\\b${escaped}\\b`, "i").test(lower);
      });
    }

    case "keywords:frequency": {
      const keyword = String(kw.keyword ?? "").toLowerCase();
      if (!keyword) return true;
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = text.toLowerCase().match(new RegExp(`\\b${escaped}\\b`, "g")) ?? [];
      return cmp(matches.length, numVal);
    }

    case "keywords:letter_frequency": {
      const letter = String(kw.letter ?? "").toLowerCase();
      if (!letter) return true;
      let hits = 0;
      for (const ch of text.toLowerCase()) {
        if (ch === letter) hits++;
      }
      return cmp(hits, numVal);
    }

    case "detectable_format:json_format": {
      try {
        JSON.parse(extractJsonBlock(text));
        return true;
      } catch {
        return false;
      }
    }

    case "detectable_format:number_bullet_lists": {
      const bullets = text
        .split("\n")
        .filter((l) => /^\s*(?:[-*]|\d+[.)])\s+/.test(l));
      return bullets.length >= Number(kw.num_bullets ?? 1);
    }

    case "detectable_format:number_highlighted_sections": {
      const highlights = text.match(/\*[^*\n]+\*/g) ?? [];
      return highlights.length >= Number(kw.num_highlights ?? 1);
    }

    case "detectable_format:title":
      return /<<[^<>]{2,}>>/.test(text);

    case "detectable_format:constrained_response": {
      const lower = text.toLowerCase();
      return (
        lower.includes("my answer is yes.") ||
        lower.includes("my answer is no.") ||
        lower.includes("my answer is maybe.")
      );
    }

    case "change_case:english_lowercase":
      return text === text.toLowerCase() && /[a-z]/.test(text);

    case "change_case:english_capital":
      return text === text.toUpperCase() && /[A-Z]/.test(text);

    case "startend:end_checker": {
      const endPhrase = String(kw.end_phrase ?? "").trim().toLowerCase();
      if (!endPhrase) return true;
      return text.trim().toLowerCase().endsWith(endPhrase);
    }

    case "detectable_content:postscript": {
      const marker = String(kw.postscript_marker ?? "P.S.").trim();
      const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(escaped, "i").test(text);
    }

    case "detectable_content:number_placeholders": {
      const holders = text.match(/\[[A-Za-z0-9 _-]{1,60}\]/g) ?? [];
      return holders.length >= Number(kw.num_placeholders ?? 1);
    }

    default:
      return false;
  }
}

export function gradeIFEval(
  responseText: string,
  instructionIds: string[],
  kwargsList: Array<Record<string, unknown>>,
): HardGradeResult {
  const trimmed = responseText.trim();
  if (!trimmed) return { passed: false, detail: "empty response" };
  const failed: string[] = [];
  for (let i = 0; i < instructionIds.length; i++) {
    const ok = checkSingleIfEvalConstraint(
      trimmed,
      instructionIds[i],
      kwargsList[i] ?? {},
    );
    if (!ok) failed.push(instructionIds[i]);
  }
  return {
    passed: failed.length === 0,
    detail:
      failed.length === 0
        ? `all ${instructionIds.length} constraints passed`
        : `failed ${failed.join(", ")}`,
  };
}

function bfclValueMatches(actual: unknown, allowedList: unknown[]): boolean {
  if (!Array.isArray(allowedList)) return false;
  return allowedList.some((allowed) => {
    if (allowed === "" && (actual === undefined || actual === null)) return true;
    if (actual === allowed) return true;
    if (typeof actual === "number" && typeof allowed === "number") {
      return Math.abs(actual - allowed) <= 1e-4;
    }
    if (typeof actual === "string" && typeof allowed === "string") {
      return (
        actual.trim().toLowerCase().replace(/\s+/g, " ") ===
        allowed.trim().toLowerCase().replace(/\s+/g, " ")
      );
    }
    if (Array.isArray(actual) && Array.isArray(allowed)) {
      return (
        actual.length === allowed.length &&
        actual.every((v, idx) => {
          const al = allowed[idx];
          return Array.isArray(al) ? bfclValueMatches(v, al) : deepJsonEqual(v, al);
        })
      );
    }
    if (
      actual &&
      allowed &&
      typeof actual === "object" &&
      typeof allowed === "object" &&
      !Array.isArray(actual) &&
      !Array.isArray(allowed)
    ) {
      const actObj = actual as Record<string, unknown>;
      const allObj = allowed as Record<string, unknown[]>;
      for (const [k, allowedVals] of Object.entries(allObj)) {
        if (!bfclValueMatches(actObj[k], allowedVals)) return false;
      }
      return true;
    }
    return false;
  });
}

export function gradeBfclV4(
  toolCalls: HardBenchToolCall[],
  possibleAnswers: Array<Record<string, Record<string, unknown[]>>>,
): HardGradeResult {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { passed: false, detail: "no tool calls emitted" };
  }

  const normalizeName = (n: string) => n.replace(/__/g, ".").trim();

  // Check each expected call spec can be satisfied by some emitted toolCall
  const used = new Set<number>();
  for (const expectedCall of possibleAnswers) {
    const [expectedFn, expectedArgs] = Object.entries(expectedCall)[0] ?? [];
    if (!expectedFn || !expectedArgs) continue;

    let matchedIdx = -1;
    for (let i = 0; i < toolCalls.length; i++) {
      if (used.has(i)) continue;
      const tc = toolCalls[i];
      if (normalizeName(tc.name) !== normalizeName(expectedFn)) continue;

      let argsOk = true;
      for (const [argName, allowedVals] of Object.entries(expectedArgs)) {
        const val = tc.arguments?.[argName];
        if (!bfclValueMatches(val, allowedVals)) {
          argsOk = false;
          break;
        }
      }
      if (argsOk) {
        matchedIdx = i;
        break;
      }
    }
    if (matchedIdx === -1) {
      return {
        passed: false,
        detail: `tool call mismatch for ${expectedFn} (got ${toolCalls.map((t) => normalizeName(t.name)).join(",")})`,
      };
    }
    used.add(matchedIdx);
  }

  return { passed: true, detail: `matched ${possibleAnswers.length} tool call(s)` };
}

export async function gradeSimpleQA(
  responseText: string,
  expectedAnswer: string,
  judgeFn?: DecisionNoulJudgeFn,
): Promise<HardGradeResult> {
  const trimmed = responseText.trim();
  if (!trimmed) return { passed: false, detail: "empty response" };

  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[,$€£]/g, "")
      .replace(/\b(the|a|an)\b/g, " ")
      .replace(/[^a-z0-9. ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const a = norm(trimmed);
  const b = norm(expectedAnswer);
  if (a === b || (b.length >= 4 && a.includes(b))) {
    return { passed: true, detail: `exact factual match ('${expectedAnswer}')` };
  }

  if (judgeFn) {
    const prob = await judgeFn(
      `GOLD ANSWER: ${expectedAnswer}\nCANDIDATE ANSWER: ${trimmed.slice(0, 600)}`,
      "Does CANDIDATE ANSWER express the exact same factual entity, date, or quantity as GOLD ANSWER without contradicting it?",
    );
    if (prob !== null) {
      return {
        passed: prob >= 0.55,
        detail: `decision-judge p=${prob.toFixed(2)} (gold='${expectedAnswer.slice(0, 40)}')`,
      };
    }
  }

  return {
    passed: false,
    detail: `got '${trimmed.slice(0, 50)}', expected '${expectedAnswer.slice(0, 50)}'`,
  };
}

export async function gradeMultiChallenge(
  responseText: string,
  targetQuestion: string,
  passCriteria: string,
  judgeFn?: DecisionNoulJudgeFn,
): Promise<HardGradeResult> {
  const trimmed = responseText.trim();
  if (!trimmed) return { passed: false, detail: "empty response" };

  if (judgeFn) {
    const prob = await judgeFn(
      `ASSISTANT FINAL RESPONSE:\n${trimmed.slice(0, 3500)}\n\nEVALUATION QUESTION:\n${targetQuestion}`,
      `Evaluate the ASSISTANT FINAL RESPONSE against the EVALUATION QUESTION. Respond true ONLY if the answer to "${targetQuestion}" is YES.`,
    );
    if (prob !== null) {
      const gotYes = prob >= 0.5;
      const wantYes = passCriteria.trim().toUpperCase() === "YES";
      return {
        passed: gotYes === wantYes,
        detail: `criteria=${passCriteria}, judge=${gotYes ? "YES" : "NO"} (p=${prob.toFixed(2)})`,
      };
    }
  }

  return { passed: false, detail: "judge unavailable for MultiChallenge rubric" };
}

export async function gradeHardTaskResponse(
  task: HardBenchTask,
  responseText: string,
  toolCalls: HardBenchToolCall[] = [],
  judgeFn?: DecisionNoulJudgeFn,
): Promise<HardGradeResult> {
  const g = task.grader;
  switch (g.kind) {
    case "bigcodebench":
      return gradeBigCodeBenchHard(responseText, g);
    case "aime25":
      return gradeAime25(responseText, g.expectedAnswer);
    case "livebench-exact":
      return gradeLiveBenchExact(responseText, g.expectedAnswer);
    case "livebench-data":
      return gradeLiveBenchData(responseText, g.expectedAnswer, g.subtask);
    case "ifeval":
      return gradeIFEval(responseText, g.instructionIdList, g.kwargsList);
    case "bfcl":
      return gradeBfclV4(toolCalls, g.possibleAnswers);
    case "simpleqa":
      return await gradeSimpleQA(responseText, g.expectedAnswer, judgeFn);
    case "multichallenge":
      return await gradeMultiChallenge(
        responseText,
        g.targetQuestion,
        g.passCriteria,
        judgeFn,
      );
  }
}
