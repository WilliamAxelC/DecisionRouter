import type { ContextTrapScenario } from "../types.js";

export const CONTEXT_TRAP_SCENARIOS: ContextTrapScenario[] = [
  {
    id: "trap-auth-middleware",
    name: "Short follow-up after JWT/RBAC security refactor",
    description:
      "Turn 1 designs a subtle tenant-isolation & JWT signature validation fix; Turn 3 is a 7-word follow-up.",
    minRequiredTier: "complex",
    expectedOutputTokens: 400,
    turns: [
      {
        role: "user",
        content:
          "Audit and refactor our multi-tenant session verifier to eliminate algorithm confusion (`alg: none`), enforce strict `kid` pinning, and prevent cross-tenant cache poisoning under concurrent key rotation.",
      },
      {
        role: "assistant",
        content:
          "Here is the hardened verifier for `sessionGuard.ts` with explicit RS256/EdDSA allowlisting, `kid` JWKS lookup pinning, and tenant-scoped cache keys.",
      },
      {
        role: "user",
        content: "ok do the same for the auth middleware",
      },
    ],
  },
  {
    id: "trap-payment-worker",
    name: "Tiny follow-up after idempotent billing race fix",
    description:
      "Turn 1 fixes a double-charge race condition; Turn 3 asks to apply it elsewhere in 6 words.",
    minRequiredTier: "complex",
    expectedOutputTokens: 380,
    turns: [
      {
        role: "user",
        content:
          "We have a race condition where Stripe webhook retries and user checkout polling both trigger `captureCharge()` simultaneously. Redesign the idempotency lock and PostgreSQL `SERIALIZABLE` / advisory lock guard.",
      },
      {
        role: "assistant",
        content:
          "I updated `checkoutCapture.ts` to claim a deterministic advisory lock and persist an idempotency state machine (`pending -> captured | failed`) inside a single transaction.",
      },
      {
        role: "user",
        content: "now apply that to the payment worker",
      },
    ],
  },
  {
    id: "trap-db-rollback",
    name: "Deceptively short rollback script request on production migration",
    description:
      "Turn 1 plans a zero-downtime 40M-row schema migration; Turn 3 asks for the rollback script.",
    minRequiredTier: "complex",
    expectedOutputTokens: 350,
    turns: [
      {
        role: "user",
        content:
          "Design a zero-downtime PostgreSQL migration to move `billing_accounts` to partitioned monthly tables with dual-write triggers and shadow verification.",
      },
      {
        role: "assistant",
        content:
          "Phase 1 creates the partitioned table and dual-write trigger; Phase 2 backfills in 50k-row chunks; Phase 3 swaps views atomically.",
      },
      {
        role: "user",
        content: "looks good, write the rollback script",
      },
    ],
  },
  {
    id: "trap-edge-cases",
    name: "Two-word 'edge cases?' after distributed consensus design",
    description:
      "Turn 1 asks for Raft/lease linearizability invariants; Turn 3 is 3 words.",
    minRequiredTier: "complex",
    expectedOutputTokens: 450,
    turns: [
      {
        role: "user",
        content:
          "Design the leader-lease renewal protocol and partition fencing invariants for our 5-node distributed lock coordinator so stale leaders cannot serve linearizable reads.",
      },
      {
        role: "assistant",
        content:
          "Using monotonic term epochs plus ReadIndex quorum heartbeats ensures reads observe all committed entries even under bounded clock skew.",
      },
      {
        role: "user",
        content: "what about edge cases?",
      },
    ],
  },
  {
    id: "trap-session-refresh",
    name: "Short follow-up on OAuth2 PKCE refresh token rotation",
    description:
      "Turn 1 establishes OAuth2 PKCE + token-theft detection; Turn 3 asks to ship refresh fix.",
    minRequiredTier: "complex",
    expectedOutputTokens: 380,
    turns: [
      {
        role: "user",
        content:
          "Perform a security architecture review of our OAuth2 PKCE refresh-token rotation family tracking so parallel browser tabs don't falsely trigger family revocation while stolen tokens still revoke immediately.",
      },
      {
        role: "assistant",
        content:
          "Use a 10-second grace window on the immediately preceding refresh token paired with single-flight client locking per browser origin.",
      },
      {
        role: "user",
        content: "ship the fix for session refresh too",
      },
    ],
  },
];
