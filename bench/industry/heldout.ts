import type { IndustryTask } from "./datasets.js";

/**
 * 21 brand-new unseen validation tasks (3 per each of the 7 benchmark families:
 * 1 easy, 1 medium, 1 hard) held out strictly from threshold tuning.
 */
export const HELDOUT_TASKS: IndustryTask[] = [
  // 1. MMLU-PRO (3)
  {
    id: "ho-mmlu-easy",
    benchmark: "mmlu-pro",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "Which packet sequence establishes a standard TCP connection during the 3-way handshake? Choose (A, B, C, or D): (A) ACK, SYN, FIN (B) SYN, SYN-ACK, ACK (C) SYN, FIN, ACK (D) RST, SYN, ACK. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "ho-mmlu-med",
    benchmark: "mmlu-pro",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "In relational databases, which ACID property guarantees that concurrent transactions do not expose uncommitted dirty writes to one another? Choose (A, B, C, or D): (A) Atomicity (B) Consistency (C) Isolation (D) Durability. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },
  {
    id: "ho-mmlu-hard",
    benchmark: "mmlu-pro",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Let X be the outcome of rolling a fair 6-sided die once. What is E[X^2] (rounded to 2 decimal places)? Choose (A, B, C, or D): (A) 12.25 (B) 14.00 (C) 14.50 (D) 15.17. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "D" },
  },

  // 2. GSM8K-MATH (3)
  {
    id: "ho-gsm-easy",
    benchmark: "gsm8k-math",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      "A school orders 15 boxes of 24 pencils each and distributes 115 pencils to students. How many pencils remain? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 245, tolerance: 0.01 },
  },
  {
    id: "ho-gsm-med",
    benchmark: "gsm8k-math",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "A jacket wholesales for $80. A store marks the price up by 25%, then discounts the marked-up price by 20% for a holiday sale. What is the sale price in dollars? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 80, tolerance: 0.01 },
  },
  {
    id: "ho-gsm-hard",
    benchmark: "gsm8k-math",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "What is the sum of all positive two-digit integers that are divisible by 7? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 728, tolerance: 0.01 },
  },

  // 3. BBH (3)
  {
    id: "ho-bbh-easy",
    benchmark: "bbh",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "Evaluate this boolean expression to TRUE or FALSE: `NOT (True AND (False OR True))`. Choose (TRUE or FALSE). End with ONLY FINAL: <TRUE|FALSE>.",
    grade: { kind: "enum", expected: "FALSE" },
  },
  {
    id: "ho-bbh-med",
    benchmark: "bbh",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "You start at (0, 0) facing East. You walk 6 miles straight, turn left 90 degrees, and walk 8 miles straight. What is the straight-line Euclidean distance in miles back to (0, 0)? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 10, tolerance: 0.01 },
  },
  {
    id: "ho-bbh-hard",
    benchmark: "bbh",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Alex, Blake, and Casey each wear a different shirt color: Red, Blue, or Green. Alex does not wear Red. Blake wears neither Red nor Green. Which person wears the Green shirt? End with ONLY FINAL: <Name>.",
    grade: { kind: "exact", expected: "Alex" },
  },

  // 4. ARC-COMMONSENSE (3)
  {
    id: "ho-arc-easy",
    benchmark: "arc-commonsense",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "Which state of matter has neither a fixed shape nor a fixed volume and expands to fill its container? Choose (A, B, C, or D): (A) Solid (B) Liquid (C) Gas (D) Crystal. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },
  {
    id: "ho-arc-med",
    benchmark: "arc-commonsense",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Why does spreading rock salt on icy winter roads cause ice to melt at temperatures slightly below 0 C? Choose (A, B, C, or D): (A) Salt generates exothermic nuclear heat (B) Dissolved ions interfere with water molecules forming a solid ice crystal lattice, lowering freezing point (C) Salt absorbs sunlight into black ice (D) Salt increases atmospheric pressure. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "ho-arc-hard",
    benchmark: "arc-commonsense",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "A sealed, thermally insulated room contains a plugged-in household refrigerator whose door is propped wide open. After running for 1 hour, what happens to the average air temperature inside the room? Choose (A, B, C, or D): (A) It increases because electrical power consumed by the compressor adds net heat to the room (B) It decreases because cold air spills out continuously (C) It stays identical by conservation of energy (D) It oscillates around zero change. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "A" },
  },

  // 5. TRUTHFULQA-CRT (3)
  {
    id: "ho-tqa-easy",
    benchmark: "truthfulqa-crt",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "True or False: Bats are completely blind and have non-functional eyes. Choose (TRUE or FALSE). End with ONLY FINAL: <TRUE|FALSE>.",
    grade: { kind: "enum", expected: "FALSE" },
  },
  {
    id: "ho-tqa-med",
    benchmark: "truthfulqa-crt",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Why do astronauts float inside the International Space Station while orbiting 400 km above Earth? Choose (A, B, C, or D): (A) Earth's gravity is zero at 400 km altitude (B) Centrifugal force shields the hull from gravity (C) Both the station and astronauts are in continuous free-fall around Earth (D) Cabin air pressure cancels gravity. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },
  {
    id: "ho-tqa-crt",
    benchmark: "truthfulqa-crt",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "A snail starts at the bottom of a 10-foot well. Each day it climbs 3 feet up, and each night it slides 2 feet down. On which day does the snail first reach the top (10 feet)? End with ONLY FINAL: <number>.",
    correctionPrompt:
      "No, that's wrong. Track the snail's peak height DURING the day (after climbing +3 ft, before night slide) starting at Day 1=3ft, Day 2=4ft... On which day does it first hit 10 ft? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 8, tolerance: 0.01 },
  },

  // 6. CRUXEVAL-CODE (3)
  {
    id: "ho-crux-easy",
    benchmark: "cruxeval-code",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      "In Python, what does `len(set([1, 2, 2, 3, 3, 3]))` evaluate to? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 3, tolerance: 0.01 },
  },
  {
    id: "ho-crux-med",
    benchmark: "cruxeval-code",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "In JavaScript, what does `[10, 20, 30].map((v, i) => v + i).filter(x => x > 20).reduce((a, b) => a + b, 0)` evaluate to? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 53, tolerance: 0.01 },
  },
  {
    id: "ho-crux-hard",
    benchmark: "cruxeval-code",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "In Python:\n```python\nx = [[0] * 2] * 3\nx[0][1] = 7\nprint(sum(sum(r) for r in x))\n```\nWhat exact integer is printed? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 21, tolerance: 0.01 },
  },

  // 7. SUPERGLUE-NLU (3)
  {
    id: "ho-sglue-easy",
    benchmark: "superglue-nlu",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      'Assign incident severity (P0, P1, or P2): "Minor typo in the blog footer copyright year on staging." End with ONLY FINAL: <LEVEL>.',
    grade: { kind: "enum", expected: "P2" },
  },
  {
    id: "ho-sglue-med",
    benchmark: "superglue-nlu",
    difficulty: "medium",
    selfEligible: true,
    prompt:
      'Premise: "All production deploys require two engineering approvals; PR #91 was deployed to production." Hypothesis: "PR #91 received at least two engineering approvals." Does the premise entail the hypothesis? Choose (ENTAILMENT or NOT_ENTAILMENT). End with ONLY FINAL: <LABEL>.',
    grade: { kind: "enum", expected: "ENTAILMENT" },
  },
  {
    id: "ho-sglue-hard",
    benchmark: "superglue-nlu",
    difficulty: "hard",
    selfEligible: true,
    prompt:
      'Decide trial extension given policy "Grant ONLY if account is active AND previous extensions == 0". Input: active=true, previous_extensions=1. Return ONLY JSON: {"grant":false,"reason":"ALREADY_EXTENDED"} or {"grant":true,"reason":"ELIGIBLE"}.',
    grade: { kind: "json", expected: { grant: false, reason: "ALREADY_EXTENDED" } },
  },
];
