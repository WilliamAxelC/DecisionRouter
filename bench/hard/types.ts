import type { ClassifierDecision } from "../../src/router/gemini-classifier.js";

export type HardBenchmarkFamily =
  | "bigcodebench-hard"
  | "aime25"
  | "livebench-reasoning"
  | "livebench-math"
  | "livebench-data"
  | "simpleqa-verified"
  | "ifeval"
  | "bfcl-v4"
  | "multichallenge";

export const HARD_BENCHMARK_FAMILIES: HardBenchmarkFamily[] = [
  "bigcodebench-hard",
  "aime25",
  "livebench-reasoning",
  "livebench-math",
  "livebench-data",
  "simpleqa-verified",
  "ifeval",
  "bfcl-v4",
  "multichallenge",
];

export interface HardBenchToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface HardBenchToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type HardBenchGraderSpec =
  | {
      kind: "bigcodebench";
      entryPoint: string;
      codePrompt: string;
      testCode: string;
      libs: string[];
    }
  | {
      kind: "aime25";
      expectedAnswer: string;
    }
  | {
      kind: "livebench-exact";
      subtask: string;
      expectedAnswer: string;
      expressions?: unknown;
    }
  | {
      kind: "livebench-data";
      subtask: string;
      expectedAnswer: string;
    }
  | {
      kind: "simpleqa";
      expectedAnswer: string;
      topic: string;
      answerType: string;
    }
  | {
      kind: "ifeval";
      instructionIdList: string[];
      kwargsList: Array<Record<string, unknown>>;
    }
  | {
      kind: "bfcl";
      possibleAnswers: Array<Record<string, Record<string, unknown[]>>>;
    }
  | {
      kind: "multichallenge";
      axis: string;
      targetQuestion: string;
      passCriteria: string;
    };

export interface HardBenchTask {
  id: string;
  family: HardBenchmarkFamily;
  sourceDataset: string;
  sourceId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  systemPrompt?: string;
  tools?: HardBenchToolDef[];
  grader: HardBenchGraderSpec;
}

export interface LiveModelResponse {
  taskId: string;
  modelRole: "light" | "high";
  modelName: string;
  text: string;
  thinkingText?: string;
  toolCalls?: HardBenchToolCall[];
  finishReason: string;
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  httpStatus: number;
  passed: boolean;
  gradeDetail: string;
  updatedAtMs: number;
}

export interface DecisionProbeCache {
  taskId: string;
  rawDecision: ClassifierDecision;
  latencyMs: number;
  updatedAtMs: number;
}

export interface SelfGradeRecord {
  taskId: string;
  profile: string;
  answerText: string;
  passed: boolean;
  gradeDetail: string;
  updatedAtMs: number;
}

export interface CascadeCheckRecord {
  taskId: string;
  structuralTriggered: boolean;
  decisionTriggered: boolean;
  reason: string;
  verifyMs: number;
  updatedAtMs: number;
}

export interface HardBenchStatsSnapshot {
  totalTasks: number;
  decisionCached: number;
  lightCompleted: number;
  highCompleted: number;
  pairedCompleted: number;
  selfGraded: number;
  cascadeChecked: number;
}
