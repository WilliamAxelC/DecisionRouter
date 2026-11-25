import type { AgentLoopScenario } from "../types.js";

const CODING_TOOLS = [
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "Search files in workspace",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit file contents",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          replacement: { type: "string" },
        },
        required: ["path", "replacement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description: "Run test suite",
      parameters: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
      },
    },
  },
];

function buildFeatureLoop12Step(): AgentLoopScenario {
  // ~45k tokens of stable repo/system context (~180k chars) realistic for Claude Code / OpenCode
  const systemPrompt =
    "You are a senior software engineer working in a large TypeScript monorepo.\n" +
    "// REPO_INDEX\n" +
    "export interface RepoModule { id: string; owner: string; deps: string[]; }\n".repeat(
      2300,
    );

  const history: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content:
        "Refactor the session token middleware to enforce concurrency-safe refresh token rotation and add unit tests.",
    },
  ];

  const steps: AgentLoopScenario["steps"] = [];

  // Step 1: Initial planning/search request
  steps.push({
    label: "1. Initial user prompt (plan & grep)",
    messages: [...history],
    tools: CODING_TOOLS,
    minRequiredTier: "complex",
    expectedOutputTokens: 180,
  });

  const toolSequence: Array<{
    label: string;
    tool: string;
    args: Record<string, unknown>;
    output: string;
    minTier: "standard" | "complex";
    expectSticky: boolean;
  }> = [
    {
      label: "2. grep_search result -> read auth.ts",
      tool: "grep_search",
      args: { query: "refreshToken" },
      output: "src/auth/refresh.ts:42\nsrc/auth/middleware.ts:18",
      minTier: "standard",
      expectSticky: true,
    },
    {
      label: "3. read_file auth/refresh.ts",
      tool: "read_file",
      args: { path: "src/auth/refresh.ts" },
      output: "export async function rotateRefresh(id: string) { /* ... */ }",
      minTier: "standard",
      expectSticky: true,
    },
    {
      label: "4. read_file auth/middleware.ts",
      tool: "read_file",
      args: { path: "src/auth/middleware.ts" },
      output: "export function authMiddleware() { /* ... */ }",
      minTier: "standard",
      expectSticky: true,
    },
    {
      label: "5. read_file tests/auth.test.ts",
      tool: "read_file",
      args: { path: "tests/auth.test.ts" },
      output: "describe('auth', () => { it('rotates', async () => {}); });",
      minTier: "standard",
      expectSticky: true,
    },
    {
      label: "6. edit_file auth/refresh.ts",
      tool: "edit_file",
      args: { path: "src/auth/refresh.ts", replacement: "// atomic rotation" },
      output: "Updated src/auth/refresh.ts (+24/-8)",
      minTier: "standard",
      expectSticky: true,
    },
    {
      label: "7. edit_file auth/middleware.ts",
      tool: "edit_file",
      args: { path: "src/auth/middleware.ts", replacement: "// lock guard" },
      output: "Updated src/auth/middleware.ts (+12/-4)",
      minTier: "standard",
      expectSticky: true,
    },
    {
      label: "8. edit_file tests/auth.test.ts",
      tool: "edit_file",
      args: { path: "tests/auth.test.ts", replacement: "// concurrency tests" },
      output: "Updated tests/auth.test.ts (+38/-2)",
      minTier: "standard",
      expectSticky: true,
    },
    {
      label: "9. run_tests (initial pass)",
      tool: "run_tests",
      args: { target: "tests/auth.test.ts" },
      output: "PASS tests/auth.test.ts (14 passed, 0 failed)",
      minTier: "standard",
      expectSticky: true,
    },
    {
      label: "10. edit_file cleanup comments",
      tool: "edit_file",
      args: { path: "src/auth/refresh.ts", replacement: "// clean docstring" },
      output: "Updated src/auth/refresh.ts (+3/-1)",
      minTier: "standard",
      expectSticky: true,
    },
    {
      label: "11. run_tests (final verification)",
      tool: "run_tests",
      args: { target: "tests/" },
      output: "PASS all suites (48 passed, 0 failed)",
      minTier: "standard",
      expectSticky: true,
    },
  ];

  for (let i = 0; i < toolSequence.length; i++) {
    const item = toolSequence[i];
    const callId = `call_feat_${i + 1}`;
    history.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: item.tool,
            arguments: JSON.stringify(item.args),
          },
        },
      ],
    });
    history.push({
      role: "tool",
      tool_call_id: callId,
      content: item.output,
    });
    steps.push({
      label: item.label,
      messages: [...history],
      tools: CODING_TOOLS,
      minRequiredTier: item.minTier,
      expectCacheSticky: item.expectSticky,
      expectedOutputTokens: 200,
    });
  }

  // Step 12: New user follow-up inside same warm session
  history.push({
    role: "assistant",
    content: "All 48 tests pass with atomic refresh rotation.",
  });
  history.push({
    role: "user",
    content: "Summarize the files you changed in 3 bullets.",
  });
  steps.push({
    label: "12. Final short summary turn (cache-sticky test)",
    messages: [...history],
    tools: CODING_TOOLS,
    minRequiredTier: "trivial",
    expectCacheSticky: true,
    expectedOutputTokens: 120,
  });

  return {
    id: "feature-loop-12step",
    name: "12-Step Feature Refactor Loop (45k-token warm repo prefix)",
    description:
      "Measures true cache-aware cost vs Always-Opus, Always-Sonnet, and Naive-Stateless when carrying a 45k-token prefix across 12 agent steps.",
    systemPromptChars: systemPrompt.length,
    steps,
  };
}

function buildFailingTestsEscalationLoop(): AgentLoopScenario {
  const sys = "You are a coding agent.\n" + "// context\n".repeat(1200);
  const baseMsgs: Array<Record<string, unknown>> = [
    { role: "system", content: sys },
    { role: "user", content: "Add pagination helper and make tests pass." },
  ];

  const s1 = [...baseMsgs];
  const s2 = [
    ...s1,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "edit_file", arguments: '{"path":"src/page.ts"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "Updated src/page.ts" },
  ];
  const s3 = [
    ...s2,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c2",
          type: "function",
          function: { name: "run_tests", arguments: '{"target":"page.test.ts"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "c2",
      content: "FAIL: AssertionError expected 2 to equal 3 (exit code 1)",
    },
  ];
  const s4 = [
    ...s3,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c3",
          type: "function",
          function: { name: "run_tests", arguments: '{"target":"page.test.ts --verbose"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "c3",
      content: "Error: Traceback exit code 1 - off-by-one still failing",
    },
  ];

  return {
    id: "failing-tests-escalation",
    name: "Consecutive Test Failure Escalation (4 steps)",
    description:
      "Starts at standard tier, experiences 2 consecutive failing test runs, and should escalate immediately.",
    systemPromptChars: sys.length,
    steps: [
      {
        label: "1. Initial task",
        messages: s1,
        tools: CODING_TOOLS,
        minRequiredTier: "standard",
        expectedOutputTokens: 160,
      },
      {
        label: "2. Successful edit (sticky)",
        messages: s2,
        tools: CODING_TOOLS,
        minRequiredTier: "standard",
        expectCacheSticky: true,
        expectedOutputTokens: 140,
      },
      {
        label: "3. First test failure",
        messages: s3,
        tools: CODING_TOOLS,
        minRequiredTier: "standard",
        expectCacheSticky: true,
        expectedOutputTokens: 180,
      },
      {
        label: "4. Second consecutive test failure -> escalate",
        messages: s4,
        tools: CODING_TOOLS,
        minRequiredTier: "complex",
        expectEscalated: true,
        expectedOutputTokens: 320,
      },
    ],
  };
}

function buildStuckToolLoop(): AgentLoopScenario {
  const sys = "You are a coding agent.";
  const s1: Array<Record<string, unknown>> = [
    { role: "system", content: sys },
    { role: "user", content: "Fix the build script in package.json." },
  ];
  const repeatedCall = {
    id: "rep1",
    type: "function",
    function: { name: "run_tests", arguments: '{"target":"build"}' },
  };
  const s2 = [
    ...s1,
    { role: "assistant", content: null, tool_calls: [repeatedCall] },
    { role: "tool", tool_call_id: "rep1", content: "Build finished with warnings" },
  ];
  const s3 = [
    ...s2,
    {
      role: "assistant",
      content: null,
      tool_calls: [{ ...repeatedCall, id: "rep2" }],
    },
    { role: "tool", tool_call_id: "rep2", content: "Build finished with warnings" },
  ];

  return {
    id: "stuck-tool-loop",
    name: "Repeated Identical Tool-Call Loop Detection",
    description:
      "Detects when an agent repeats the exact same tool call + args and escalates tier.",
    systemPromptChars: sys.length,
    steps: [
      {
        label: "1. Initial prompt",
        messages: s1,
        tools: CODING_TOOLS,
        minRequiredTier: "standard",
        expectedOutputTokens: 120,
      },
      {
        label: "2. First run_tests",
        messages: s2,
        tools: CODING_TOOLS,
        minRequiredTier: "standard",
        expectCacheSticky: true,
        expectedOutputTokens: 120,
      },
      {
        label: "3. Repeated identical run_tests -> escalate",
        messages: s3,
        tools: CODING_TOOLS,
        minRequiredTier: "complex",
        expectEscalated: true,
        expectedOutputTokens: 250,
      },
    ],
  };
}

function buildUserPushbackLoop(): AgentLoopScenario {
  const sys = "You are a coding agent.";
  const s1 = [
    { role: "system", content: sys },
    { role: "user", content: "Update the login helper to trim whitespace." },
  ];
  const s2 = [
    ...s1,
    { role: "assistant", content: "Done, trimmed username and password." },
    {
      role: "user",
      content:
        "No, that's wrong — trimming passwords broke auth tests. Revert and fix the root cause.",
    },
  ];

  return {
    id: "user-pushback-recovery",
    name: "User Correction / Pushback Escalation",
    description:
      "Detects explicit user correction on turn 2 and bumps up a tier immediately.",
    systemPromptChars: sys.length,
    steps: [
      {
        label: "1. Simple edit prompt",
        messages: s1,
        minRequiredTier: "standard",
        expectedOutputTokens: 120,
      },
      {
        label: "2. User pushback -> escalate",
        messages: s2,
        minRequiredTier: "complex",
        expectEscalated: true,
        expectedOutputTokens: 280,
      },
    ],
  };
}

function buildOscillatingCacheThrashLoop(): AgentLoopScenario {
  const sys =
    "You are a senior software engineer debugging a large distributed monorepo.\n" +
    "// REPO_CONTEXT\n" +
    "export interface ServiceModule { id: string; owner: string; deps: string[]; }\n".repeat(
      3100,
    );

  const history: Array<Record<string, unknown>> = [
    { role: "system", content: sys },
    {
      role: "user",
      content:
        "Refactor the distributed lock fencing middleware to fix the race condition across Redis and Postgres.",
    },
  ];

  const steps: AgentLoopScenario["steps"] = [
    {
      label: "1. Initial complex analysis",
      messages: [...history],
      tools: CODING_TOOLS,
      minRequiredTier: "complex",
      expectedOutputTokens: 200,
    },
  ];

  const alternatingSeq: Array<{
    label: string;
    tool: string;
    args: Record<string, unknown>;
    output: string;
    minTier: "complex" | "standard";
  }> = [
    {
      label: "2. read_file lock.ts (standard)",
      tool: "read_file",
      args: { path: "src/lock.ts" },
      output: "export async function acquireLock() { /* ... */ }",
      minTier: "standard",
    },
    {
      label: "3. edit_file fencing epoch (complex)",
      tool: "edit_file",
      args: { path: "src/lock.ts", replacement: "// fencing token epoch" },
      output: "Updated src/lock.ts (+30/-10)",
      minTier: "complex",
    },
    {
      label: "4. read_file store.ts (standard)",
      tool: "read_file",
      args: { path: "src/store.ts" },
      output: "export async function saveWithEpoch() { /* ... */ }",
      minTier: "standard",
    },
    {
      label: "5. edit_file Postgres epoch guard (complex)",
      tool: "edit_file",
      args: { path: "src/store.ts", replacement: "// WHERE epoch < $2" },
      output: "Updated src/store.ts (+18/-4)",
      minTier: "complex",
    },
    {
      label: "6. read_file lock.test.ts (standard)",
      tool: "read_file",
      args: { path: "tests/lock.test.ts" },
      output: "describe('lock', () => {});",
      minTier: "standard",
    },
    {
      label: "7. edit_file concurrency race test (complex)",
      tool: "edit_file",
      args: { path: "tests/lock.test.ts", replacement: "// simulated GC pause" },
      output: "Updated tests/lock.test.ts (+42/-0)",
      minTier: "complex",
    },
    {
      label: "8. run_tests verification (standard)",
      tool: "run_tests",
      args: { target: "tests/lock.test.ts" },
      output: "PASS tests/lock.test.ts (12 passed, 0 failed)",
      minTier: "standard",
    },
  ];

  for (let i = 0; i < alternatingSeq.length; i++) {
    const item = alternatingSeq[i];
    const callId = `call_osc_${i + 1}`;
    history.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: item.tool,
            arguments: JSON.stringify(item.args),
          },
        },
      ],
    });
    history.push({
      role: "tool",
      tool_call_id: callId,
      content: item.output,
    });
    steps.push({
      label: item.label,
      messages: [...history],
      tools: CODING_TOOLS,
      minRequiredTier: item.minTier,
      expectCacheSticky: true,
      expectedOutputTokens: 200,
    });
  }

  return {
    id: "oscillating-cache-thrash-8step",
    name: "8-Step Alternating Complexity Loop (60k-token warm prefix)",
    description:
      "Alternates complex and standard steps so naive stateless routing repeatedly pays Anthropic 1.25x cache-write penalties while cache-sticky DecisionRouter reuses the warm prefix.",
    systemPromptChars: sys.length,
    steps,
  };
}

export const AGENT_LOOP_SCENARIOS: AgentLoopScenario[] = [
  buildFeatureLoop12Step(),
  buildOscillatingCacheThrashLoop(),
  buildFailingTestsEscalationLoop(),
  buildStuckToolLoop(),
  buildUserPushbackLoop(),
];
