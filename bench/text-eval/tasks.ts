import type { GradeSpec } from "./grader.js";

export type TextTaskCategory =
  | "decision-triage"
  | "easy-text"
  | "medium-reasoning"
  | "hard-reasoning"
  | "multi-turn-escalation";

export interface TextEvalTask {
  id: string;
  category: TextTaskCategory;
  selfEligible: boolean;
  prompt: string;
  correctionPrompt?: string;
  grade: GradeSpec;
}

export const TEXT_EVAL_TASKS: TextEvalTask[] = [
  // --- 1. DECISION-TRIAGE (8 tasks, selfEligible: true) ---
  {
    id: "dec-sentiment",
    category: "decision-triage",
    selfEligible: true,
    prompt:
      'Classify the sentiment of this customer review as POSITIVE, NEGATIVE, or NEUTRAL: "The package arrived 4 days late and the lid was cracked, though support replied quickly." End with ONLY FINAL: <LABEL>.',
    grade: { kind: "enum", expected: "NEGATIVE" },
  },
  {
    id: "dec-support-route",
    category: "decision-triage",
    selfEligible: true,
    prompt:
      'Route this support ticket to one queue (BILLING, TECHNICAL, SECURITY, or SALES): "We saw two unauthorized logins from an unknown IP after rotating our SSO certificate." End with ONLY FINAL: <QUEUE>.',
    grade: { kind: "enum", expected: "SECURITY" },
  },
  {
    id: "dec-severity",
    category: "decision-triage",
    selfEligible: true,
    prompt:
      'Assign incident severity (P0, P1, or P2): "All checkout API calls in us-east-1 are returning HTTP 500 for 100% of paying users." End with ONLY FINAL: <LEVEL>.',
    grade: { kind: "enum", expected: "P0" },
  },
  {
    id: "dec-pii-check",
    category: "decision-triage",
    selfEligible: true,
    prompt:
      'Does this log line contain PII (YES or NO)? "2026-11-25 INFO user_id=usr_9912 ssn=123-45-6789 action=login" End with ONLY FINAL: <YES|NO>.',
    grade: { kind: "enum", expected: "YES" },
  },
  {
    id: "dec-phishing",
    category: "decision-triage",
    selfEligible: true,
    prompt:
      'Classify this email as SAFE or PHISHING: "Urgent: your payroll account will be suspended in 2 hours unless you verify your password at http://payr0ll-verify-login.example.net." End with ONLY FINAL: <LABEL>.',
    grade: { kind: "enum", expected: "PHISHING" },
  },
  {
    id: "dec-intent",
    category: "decision-triage",
    selfEligible: true,
    prompt:
      'Classify user intent (REFUND, CANCEL, UPGRADE, or QUESTION): "I would like my money back for the duplicate annual charge from yesterday." End with ONLY FINAL: <INTENT>.',
    grade: { kind: "enum", expected: "REFUND" },
  },
  {
    id: "dec-language-id",
    category: "decision-triage",
    selfEligible: true,
    prompt:
      'Identify the ISO language code (EN, ES, FR, DE, or JA) of: "Veuillez redemarrer le serveur avant de continuer." End with ONLY FINAL: <CODE>.',
    grade: { kind: "enum", expected: "FR" },
  },
  {
    id: "dec-eligibility-json",
    category: "decision-triage",
    selfEligible: true,
    prompt:
      'Decide refund eligibility given policy "Eligible only within 30 days of purchase and unused". Input: purchased 45 days ago, unused. Return ONLY JSON: {"eligible":false,"reason_code":"EXPIRED"} or {"eligible":true,"reason_code":"OK"}.',
    grade: { kind: "json", expected: { eligible: false, reason_code: "EXPIRED" } },
  },

  // --- 2. EASY-TEXT (6 tasks) ---
  {
    id: "easy-c-to-f",
    category: "easy-text",
    selfEligible: false,
    prompt:
      "Convert 35 degrees Celsius to Fahrenheit. End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 95, tolerance: 0.01 },
  },
  {
    id: "easy-leap-date",
    category: "easy-text",
    selfEligible: false,
    prompt:
      "What calendar date (YYYY-MM-DD) is 5 days after 2024-02-27? Remember 2024 is a leap year. End with ONLY FINAL: <YYYY-MM-DD>.",
    grade: { kind: "exact", expected: "2024-03-03" },
  },
  {
    id: "easy-receipt-json",
    category: "easy-text",
    selfEligible: false,
    prompt:
      'Extract vendor and total from this receipt: "Receipt #441 - Acme Coffee Roasters - 2x Latte $9.00, 1x Bagel $4.50, Total Paid: $13.50". Return ONLY JSON with keys "vendor" and "total" (number).',
    grade: {
      kind: "json",
      expected: { vendor: "Acme Coffee Roasters", total: 13.5 },
    },
  },
  {
    id: "easy-csv-filter",
    category: "easy-text",
    selfEligible: false,
    prompt:
      "Given CSV lines:\nname,role,active\nAda,admin,true\nBob,user,false\nCai,admin,true\nList the names of active admins separated by a comma (no spaces). End with ONLY FINAL: <names>.",
    grade: { kind: "exact", expected: "Ada,Cai" },
  },
  {
    id: "easy-capital",
    category: "easy-text",
    selfEligible: false,
    prompt: "What is the capital city of Australia? End with ONLY FINAL: <city>.",
    grade: { kind: "exact", expected: "Canberra" },
  },
  {
    id: "easy-cron",
    category: "easy-text",
    selfEligible: false,
    prompt:
      "How many times does the cron expression `*/15 * * * *` execute in a 24-hour day? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 96, tolerance: 0.01 },
  },

  // --- 3. MEDIUM-REASONING (6 tasks) ---
  {
    id: "med-distractor-reading",
    category: "medium-reasoning",
    selfEligible: false,
    prompt:
      "Warehouse A holds 140 crates (30 damaged). Warehouse B holds 95 crates (15 reserved for export, none damaged). A truck moves 20 undamaged crates from A to B. How many undamaged, unreserved crates are now in Warehouse B? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 100, tolerance: 0.01 },
  },
  {
    id: "med-discount-tax",
    category: "medium-reasoning",
    selfEligible: false,
    prompt:
      "An item has list price $200. Apply a 15% discount first, then add 8% sales tax on the discounted price, then add $12 flat shipping (untaxed). What is the final total in dollars? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 195.6, tolerance: 0.05 },
  },
  {
    id: "med-js-reduce",
    category: "medium-reasoning",
    selfEligible: false,
    prompt:
      "What does `[1, 2, 3, 4].reduce((acc, x) => x % 2 === 0 ? acc + x * 2 : acc - x, 10)` evaluate to in JavaScript? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 18, tolerance: 0.01 },
  },
  {
    id: "med-sql-having",
    category: "medium-reasoning",
    selfEligible: false,
    prompt:
      "Table `orders(id, user_id, amount)`: (1,10,50), (2,10,60), (3,20,120), (4,30,40), (5,30,45), (6,30,30). How many rows are returned by `SELECT user_id FROM orders GROUP BY user_id HAVING SUM(amount) >= 110 AND COUNT(*) >= 2`? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 2, tolerance: 0.01 },
  },
  {
    id: "med-regex-matches",
    category: "medium-reasoning",
    selfEligible: false,
    prompt:
      'How many non-overlapping matches does `/\\b[a-z]{3}\\d{2}\\b/g` find in `"abc12 xy99 def345 ghi07 jkl88"`? End with ONLY FINAL: <number>.',
    grade: { kind: "number", expected: 3, tolerance: 0.01 },
  },
  {
    id: "med-breakeven",
    category: "medium-reasoning",
    selfEligible: false,
    prompt:
      "A SaaS team has $4,500 monthly fixed costs, $15 variable cost per seat, and charges $40 per seat/month. How many seats are needed to break even? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 180, tolerance: 0.01 },
  },

  // --- 4. HARD-REASONING (6 tasks) ---
  {
    id: "hard-seating-puzzle",
    category: "hard-reasoning",
    selfEligible: false,
    prompt:
      "Four engineers (Alice, Bob, Cara, Dan) sit in seats 1, 2, 3, 4 from left to right. Rules: (1) Bob is not at either end. (2) Alice sits immediately to the left of Cara. (3) Dan does not sit in seat 4 and is not adjacent to Bob. Who sits in seat 4? End with ONLY FINAL: <Name>.",
    grade: { kind: "exact", expected: "Cara" },
  },
  {
    id: "hard-bayes",
    category: "hard-reasoning",
    selfEligible: false,
    prompt:
      "A rare bug affects 1% of servers. A detector flags buggy servers 90% of the time (sensitivity) and falsely flags healthy servers 5% of the time (false positive rate). Given a server is flagged, what is the probability in percent (rounded to 1 decimal place) that it actually has the bug? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 15.4, tolerance: 0.2 },
  },
  {
    id: "hard-python-mutable-arg",
    category: "hard-reasoning",
    selfEligible: false,
    prompt:
      "In Python:\n```python\ndef f(x, acc=[]):\n    acc.append(x)\n    return acc\na = f(1)\nb = f(2, [])\nc = f(3)\nprint(sum(a) + sum(b) + sum(c))\n```\nWhat exact integer does this print? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 10, tolerance: 0.01 },
  },
  {
    id: "hard-binary-search-bug",
    category: "hard-reasoning",
    selfEligible: false,
    prompt:
      "Consider `arr = [2, 5, 8, 12, 16]` and `target = 12` in a buggy binary search: `lo = 0, hi = arr.length - 1; while (lo < hi) { mid = Math.floor((lo + hi) / 2); if (arr[mid] < target) lo = mid + 1; else hi = mid - 1; } return lo;`. What index does this buggy loop return? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 2, tolerance: 0.01 },
  },
  {
    id: "hard-clock-angle",
    category: "hard-reasoning",
    selfEligible: false,
    prompt:
      "What is the smaller angle in degrees between the hour hand and the minute hand of an analog clock at 3:40? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 130, tolerance: 0.1 },
  },
  {
    id: "hard-syllogism",
    category: "hard-reasoning",
    selfEligible: false,
    prompt:
      "Premises: (1) All caches with TTL=0 bypass storage. (2) Some fast paths have TTL=0. Conclusion: 'Therefore, all fast paths bypass storage.' Is this deductive argument VALID or INVALID? End with ONLY FINAL: <VALID|INVALID>.",
    grade: { kind: "enum", expected: "INVALID" },
  },

  // --- 5. MULTI-TURN-ESCALATION (4 deceptive two-turn tasks) ---
  {
    id: "mt-bat-and-ball",
    category: "multi-turn-escalation",
    selfEligible: false,
    prompt:
      "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost in dollars (e.g. 0.05)? End with ONLY FINAL: <number>.",
    correctionPrompt:
      "No, that's wrong. Double-check the algebra carefully (bat - ball = 1.00 and bat + ball = 1.10) and end with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 0.05, tolerance: 0.005 },
  },
  {
    id: "mt-lily-pad",
    category: "multi-turn-escalation",
    selfEligible: false,
    prompt:
      "In a lake, a patch of lily pads doubles in size every day. If it takes 48 days for the patch to cover the entire lake, how many days does it take to cover half of the lake? End with ONLY FINAL: <number>.",
    correctionPrompt:
      "No, that's wrong. Remember it DOUBLES each day, so work backwards 1 day from day 48. End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 47, tolerance: 0.01 },
  },
  {
    id: "mt-percent-symmetry",
    category: "multi-turn-escalation",
    selfEligible: false,
    prompt:
      "A stock rises by 25% on Monday and then drops by 20% on Tuesday. What is the net percentage change from the starting price? End with ONLY FINAL: <number>.",
    correctionPrompt:
      "No, that's wrong. Calculate starting from 100: 100 * 1.25 * 0.80, then give the net percentage change. End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 0, tolerance: 0.05 },
  },
  {
    id: "mt-js-microtasks",
    category: "multi-turn-escalation",
    selfEligible: false,
    prompt:
      "In JavaScript:\n`console.log(1); setTimeout(() => console.log(2), 0); Promise.resolve().then(() => console.log(3)); console.log(4);`\nWhat are the 4 numbers printed, comma-separated with no spaces? End with ONLY FINAL: <n1,n2,n3,n4>.",
    correctionPrompt:
      "No, that's wrong. Check synchronous execution vs microtask queue (Promise) vs macrotask queue (setTimeout). End with ONLY FINAL: <n1,n2,n3,n4>.",
    grade: { kind: "exact", expected: "1,4,3,2" },
  },
];
