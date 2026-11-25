export type GradeSpec =
  | { kind: "enum"; expected: string }
  | { kind: "number"; expected: number; tolerance?: number }
  | { kind: "json"; expected: Record<string, unknown> }
  | { kind: "exact"; expected: string };

export function extractFinalAnswer(rawText: string): string {
  const cleaned = rawText
    .replace(/```(?:json|text|txt)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  const matches = [...cleaned.matchAll(/FINAL:\s*([^\n\r]+)/gi)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1]
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\.+$/, "")
      .trim();
  }

  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

export function gradeEnum(rawText: string, expected: string): boolean {
  const actual = extractFinalAnswer(rawText).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const exp = expected.toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  return actual === exp;
}

export function gradeNumber(
  rawText: string,
  expected: number,
  tolerance = 0.05,
): boolean {
  const ans = extractFinalAnswer(rawText);
  const normalized = ans.replace(/[$,%\s]/g, "").replace(/,/g, "");
  const numMatch = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!numMatch) return false;
  const val = Number(numMatch[0]);
  if (!Number.isFinite(val)) return false;
  return Math.abs(val - expected) <= tolerance;
}

export function gradeJson(
  rawText: string,
  expectedSubset: Record<string, unknown>,
): boolean {
  const stripped = rawText
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  const candidates = [extractFinalAnswer(rawText), stripped];
  const braceStart = stripped.indexOf("{");
  const braceEnd = stripped.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(stripped.slice(braceStart, braceEnd + 1));
  }

  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      let allMatch = true;
      for (const [k, v] of Object.entries(expectedSubset)) {
        if (parsed[k] !== v) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return true;
    } catch {
      // try next candidate
    }
  }
  return false;
}

export function gradeExact(rawText: string, expected: string): boolean {
  const actual = extractFinalAnswer(rawText)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const exp = expected.toLowerCase().replace(/\s+/g, " ").trim();
  return actual === exp;
}

export function gradeResponse(rawText: string, spec: GradeSpec): boolean {
  switch (spec.kind) {
    case "enum":
      return gradeEnum(rawText, spec.expected);
    case "number":
      return gradeNumber(rawText, spec.expected, spec.tolerance ?? 0.05);
    case "json":
      return gradeJson(rawText, spec.expected);
    case "exact":
      return gradeExact(rawText, spec.expected);
  }
}
