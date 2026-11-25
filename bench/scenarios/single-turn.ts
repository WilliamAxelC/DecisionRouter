import type { SingleTurnScenario } from "../types.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export const SINGLE_TURN_SCENARIOS: SingleTurnScenario[] = [
  // --- TRIVIAL (4) ---
  {
    id: "triv-commit-msg",
    category: "trivial",
    prompt:
      "Write a conventional commit message for: 'fix typo in README install command'.",
    minRequiredTier: "trivial",
    idealTier: "trivial",
    expectedOutputTokens: 30,
    tags: ["git", "boilerplate"],
  },
  {
    id: "triv-json-format",
    category: "trivial",
    prompt: 'Format this JSON cleanly: {"a":1,"b":[2,3],"c":{"ok":true}}',
    minRequiredTier: "trivial",
    idealTier: "trivial",
    expectedOutputTokens: 40,
    tags: ["formatting"],
  },
  {
    id: "triv-jq-explain",
    category: "trivial",
    prompt: "Explain what this jq filter does in 2 sentences: `.items[] | select(.active) | .id`",
    minRequiredTier: "trivial",
    idealTier: "trivial",
    expectedOutputTokens: 60,
    tags: ["cli", "qa"],
  },
  {
    id: "triv-email-regex",
    category: "trivial",
    prompt: "Give me a basic regex to match an email address in JavaScript.",
    minRequiredTier: "trivial",
    idealTier: "trivial",
    expectedOutputTokens: 50,
    tags: ["regex"],
  },

  // --- STANDARD (5) ---
  {
    id: "std-ts-guard",
    category: "standard",
    prompt:
      "Write a TypeScript type guard `isApiError(err: unknown): err is { status: number; message: string }` with null and typeof checks.",
    minRequiredTier: "standard",
    idealTier: "standard",
    expectedOutputTokens: 160,
    tags: ["typescript", "coding"],
  },
  {
    id: "std-vitest-pagination",
    category: "standard",
    prompt:
      "Write Vitest unit tests covering boundary cases (page 0, negative limit, empty items, last partial page) for a `paginate(items, page, limit)` helper.",
    minRequiredTier: "standard",
    idealTier: "standard",
    expectedOutputTokens: 280,
    tags: ["testing", "typescript"],
  },
  {
    id: "std-sql-window",
    category: "standard",
    prompt:
      "Write a PostgreSQL query using `ROW_NUMBER()` over `(PARTITION BY user_id ORDER BY created_at DESC)` to fetch each user's most recent non-cancelled order.",
    minRequiredTier: "standard",
    idealTier: "standard",
    expectedOutputTokens: 180,
    tags: ["sql"],
  },
  {
    id: "std-hono-ratelimit",
    category: "standard",
    prompt:
      "Implement a lightweight in-memory sliding-window rate-limit middleware for Hono keyed by `x-forwarded-for` or remote IP, returning HTTP 429 with `Retry-After`.",
    minRequiredTier: "standard",
    idealTier: "standard",
    expectedOutputTokens: 320,
    tags: ["middleware", "backend"],
  },
  {
    id: "std-py-keyerror",
    category: "standard",
    prompt:
      "Why does `dict.get('items', [])` avoid KeyError here while `payload['items'][0]` still raises `IndexError` when `items` is empty? Show a safe Python fix.",
    minRequiredTier: "standard",
    idealTier: "standard",
    expectedOutputTokens: 150,
    tags: ["python", "debugging"],
  },

  // --- COMPLEX (5) ---
  {
    id: "cpx-react-stale-closure",
    category: "complex",
    prompt:
      "Debug this React hook: rapid search input updates cause out-of-order responses to overwrite newer state, and debounced callbacks read a stale `filters` ref. Show how to fix both with `AbortController` and clean effect dependencies without causing extra fetches.",
    minRequiredTier: "complex",
    idealTier: "complex",
    expectedOutputTokens: 450,
    tags: ["react", "concurrency", "debugging"],
  },
  {
    id: "cpx-redis-fencing",
    category: "complex",
    prompt:
      "Our Redis-based distributed lock occasionally allows two workers to write to S3 simultaneously after a GC pause expires the TTL. Design a fencing-token solution with monotonic epoch validation on the storage layer and analyze failure modes.",
    minRequiredTier: "complex",
    idealTier: "complex",
    expectedOutputTokens: 550,
    tags: ["distributed-systems", "race-condition"],
  },
  {
    id: "cpx-pg-deadlock",
    category: "complex",
    prompt:
      "Two concurrent background jobs update `invoices` and `ledger_entries` in opposite lock acquisition orders under `READ COMMITTED`, causing periodic PostgreSQL deadlocks (`40P01`). Trace the exact lock graph and refactor both transactions + retry loop safely.",
    minRequiredTier: "complex",
    idealTier: "complex",
    expectedOutputTokens: 520,
    tags: ["postgres", "deadlock", "transactions"],
  },
  {
    id: "cpx-zero-downtime-mig",
    category: "complex",
    prompt:
      "Plan a zero-downtime PostgreSQL migration splitting `users.full_name` into `first_name` and `last_name` across a 40M-row table with rolling blue/green app deploys, dual-write triggers, batched backfill, and safe constraint validation.",
    minRequiredTier: "complex",
    idealTier: "complex",
    expectedOutputTokens: 600,
    tags: ["database", "migration"],
  },
  {
    id: "cpx-node-leak",
    category: "complex",
    prompt:
      "Diagnose why a long-lived Node.js WebSocket gateway grows RSS linearly by 120MB/hour under reconnect churn when each connection registers `bus.on('broadcast', handler)` and attaches closures over request buffers. Provide a heap-snapshot verification plan and fix.",
    minRequiredTier: "complex",
    idealTier: "complex",
    expectedOutputTokens: 480,
    tags: ["nodejs", "memory-leak"],
  },

  // --- FRONTIER (3) ---
  {
    id: "frt-raft-split-brain",
    category: "frontier",
    prompt:
      "Review this custom Raft-inspired lease-read optimization for a 5-node metadata store: followers serve reads locally while leader lease is valid, and membership changes use single-server steps. Prove or disprove linearizability under asymmetric network partitions and clock drift, and specify the exact safety invariants required.",
    minRequiredTier: "complex",
    idealTier: "frontier",
    expectedOutputTokens: 850,
    tags: ["consensus", "distributed-systems", "formal"],
  },
  {
    id: "frt-oauth-pkce-audit",
    category: "frontier",
    prompt:
      "Perform an end-to-end security threat model for an OAuth2 + PKCE BFF architecture spanning a SPA, edge API gateway, and downstream gRPC microservices using DPoP token binding. Identify subtle confused-deputy, token-replay, and CSRF vectors and specify exact cryptographic verification rules.",
    minRequiredTier: "complex",
    idealTier: "frontier",
    expectedOutputTokens: 900,
    tags: ["security", "oauth2", "architecture"],
  },
  {
    id: "frt-multi-region-ledger",
    category: "frontier",
    prompt:
      "Architect an active-active multi-region financial double-entry ledger supporting idempotent transfers with strict balance non-negativity, bounded cross-region latency (<120ms p99 for home-region accounts), and deterministic reconciliation during region isolation.",
    minRequiredTier: "complex",
    idealTier: "frontier",
    expectedOutputTokens: 950,
    tags: ["architecture", "fintech", "distributed-systems"],
  },

  // --- SPECIALIST (3) ---
  {
    id: "spec-vision-ui",
    category: "specialist",
    prompt: "Identify why the modal footer buttons overlap the sticky header in this screenshot.",
    hasImages: true,
    minRequiredTier: "specialist",
    idealTier: "specialist",
    specialist: "vision",
    expectedOutputTokens: 250,
    tags: ["vision", "ui"],
  },
  {
    id: "spec-long-context-logs",
    category: "specialist",
    prompt:
      "Correlate the root cause of the cascading 502 failures across these 95k tokens of Kubernetes ingress and worker logs.",
    estimatedExtraTokens: 95_000,
    minRequiredTier: "specialist",
    idealTier: "specialist",
    specialist: "long_context",
    expectedOutputTokens: 500,
    tags: ["long-context", "logs"],
  },
  {
    id: "spec-reasoning-dp",
    category: "specialist",
    prompt:
      "Prove the loop invariant and optimal substructure of this interval-scheduling dynamic programming recurrence with weighted cooldown penalties, and derive tight O(n log n) time complexity.",
    minRequiredTier: "complex",
    idealTier: "specialist",
    specialist: "reasoning",
    expectedOutputTokens: 600,
    tags: ["reasoning", "algorithms", "proof"],
  },
];

export function buildSingleTurnPayload(s: SingleTurnScenario): Record<string, unknown> {
  const extraPad =
    s.estimatedExtraTokens && s.estimatedExtraTokens > 0
      ? `\n\n[LOG_DUMP]\n${"2026-11-25T10:00:00Z INFO worker=ok\n".repeat(
          Math.ceil((s.estimatedExtraTokens * 4) / 36),
        )}`
      : "";

  const content = s.hasImages
    ? [
        { type: "text", text: s.prompt },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` },
        },
      ]
    : `${s.prompt}${extraPad}`;

  return {
    model: "auto",
    messages: [
      ...(s.system ? [{ role: "system", content: s.system }] : []),
      { role: "user", content },
    ],
    ...(s.tools ? { tools: s.tools } : {}),
  };
}
