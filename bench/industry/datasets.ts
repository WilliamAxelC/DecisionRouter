import type { GradeSpec } from "../text-eval/grader.js";

export type IndustryBenchmarkName =
  | "mmlu-pro"
  | "gsm8k-math"
  | "bbh"
  | "arc-commonsense"
  | "truthfulqa-crt"
  | "cruxeval-code"
  | "superglue-nlu";

export type TaskDifficulty = "easy" | "medium" | "hard";

export interface IndustryTask {
  id: string;
  benchmark: IndustryBenchmarkName;
  difficulty: TaskDifficulty;
  selfEligible: boolean;
  prompt: string;
  correctionPrompt?: string;
  grade: GradeSpec;
}

export const INDUSTRY_BENCHMARK_NAMES: IndustryBenchmarkName[] = [
  "mmlu-pro",
  "gsm8k-math",
  "bbh",
  "arc-commonsense",
  "truthfulqa-crt",
  "cruxeval-code",
  "superglue-nlu",
];

export const INDUSTRY_TASKS: IndustryTask[] = [
  // =========================================================================
  // 1. MMLU-PRO (12 tasks: Computer Science, Economics, Law, Bio, Physics, Stats)
  // =========================================================================
  {
    id: "mmlu-http-429",
    benchmark: "mmlu-pro",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "Which HTTP status code indicates that the client has sent too many requests in a given amount of time? Choose (A, B, C, or D): (A) 403 Forbidden (B) 409 Conflict (C) 429 Too Many Requests (D) 503 Service Unavailable. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },
  {
    id: "mmlu-cap-theorem",
    benchmark: "mmlu-pro",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "According to the CAP theorem, during a network partition a distributed data store must choose between which two guarantees? Choose (A, B, C, or D): (A) Consistency and Availability (B) Confidentiality and Atomicity (C) Durability and Isolation (D) Throughput and Latency. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "A" },
  },
  {
    id: "mmlu-deadlock-coffman",
    benchmark: "mmlu-pro",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Which of the following is NOT one of the four Coffman conditions required for a resource deadlock? Choose (A, B, C, or D): (A) Mutual exclusion (B) Hold and wait (C) Circular wait (D) Preemptive scheduling. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "D" },
  },
  {
    id: "mmlu-bst-lookup",
    benchmark: "mmlu-pro",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "What is the worst-case time complexity of searching for a key in a height-balanced binary search tree (such as an AVL tree) with n nodes? Choose (A, B, C, or D): (A) O(1) (B) O(log n) (C) O(n) (D) O(n log n). End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "mmlu-econ-elasticity",
    benchmark: "mmlu-pro",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "If the price elasticity of demand for a good is -2.5 (elastic) and a firm lowers its price by 10%, what happens to total revenue? Choose (A, B, C, or D): (A) Total revenue decreases (B) Total revenue increases (C) Total revenue stays unchanged (D) Total revenue drops to zero. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "mmlu-econ-supply",
    benchmark: "mmlu-pro",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "In a competitive market with an upward-sloping supply curve and downward-sloping demand curve, if input costs fall and supply shifts right while demand is unchanged, what happens at the new equilibrium? Choose (A, B, C, or D): (A) Equilibrium price falls and quantity rises (B) Equilibrium price rises and quantity falls (C) Both price and quantity fall (D) Both price and quantity rise. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "A" },
  },
  {
    id: "mmlu-law-4th",
    benchmark: "mmlu-pro",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "Which U.S. Constitutional Amendment primarily protects citizens against unreasonable searches and seizures? Choose (A, B, C, or D): (A) First Amendment (B) Fourth Amendment (C) Fifth Amendment (D) Eighth Amendment. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "mmlu-law-consideration",
    benchmark: "mmlu-pro",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Under common law contract doctrine, a promise made solely out of gratitude for a past unsolicited favor generally lacks enforceability because of missing: Choose (A, B, C, or D): (A) Capacity (B) Statute of Frauds writing (C) Present bargained-for consideration (D) Mirror-image acceptance. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },
  {
    id: "mmlu-bio-atp",
    benchmark: "mmlu-pro",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "In eukaryotic cells, oxidative phosphorylation and the majority of ATP synthesis occur in which organelle? Choose (A, B, C, or D): (A) Golgi apparatus (B) Mitochondria (C) Lysosome (D) Smooth endoplasmic reticulum. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "mmlu-physics-doppler",
    benchmark: "mmlu-pro",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "An ambulance siren emits a constant 700 Hz tone while moving directly toward a stationary observer. Compared to 700 Hz, the observer hears a frequency that is: Choose (A, B, C, or D): (A) Higher than 700 Hz (B) Lower than 700 Hz (C) Exactly 700 Hz (D) Alternating above and below 700 Hz. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "A" },
  },
  {
    id: "mmlu-stats-independence",
    benchmark: "mmlu-pro",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Events A and B satisfy P(A) = 0.30, P(B) = 0.40, and P(A U B) = 0.58. What is the conditional probability P(A | B)? Choose (A, B, C, or D): (A) 0.12 (B) 0.25 (C) 0.30 (D) 0.40. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },
  {
    id: "mmlu-dist-quorum",
    benchmark: "mmlu-pro",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "In a 5-node Raft consensus cluster, suppose 2 follower nodes are permanently offline and partitioned away. What is the minimum write quorum size still required to commit new log entries safely while preventing split-brain? Choose (A, B, C, or D): (A) 2 (B) 3 (C) 4 (D) 5. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },

  // =========================================================================
  // 2. GSM8K-MATH (12 tasks: arithmetic -> multi-step -> competition math)
  // =========================================================================
  {
    id: "gsm-bakery-trays",
    benchmark: "gsm8k-math",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      "A bakery bakes 4 trays of 36 muffins each in the morning and sells 98 muffins by noon. How many muffins are left? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 46, tolerance: 0.01 },
  },
  {
    id: "gsm-train-distance",
    benchmark: "gsm8k-math",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      "A train travels at a constant speed of 75 mph for 2.4 hours. How many miles does it travel? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 180, tolerance: 0.01 },
  },
  {
    id: "gsm-bookstore",
    benchmark: "gsm8k-math",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      "Maya buys 18 notebooks at $3.50 each and 12 pens at $1.25 each. What is her total cost in dollars? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 78, tolerance: 0.01 },
  },
  {
    id: "gsm-c-to-f",
    benchmark: "gsm8k-math",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      "Convert 35 degrees Celsius to Fahrenheit using F = (9/5)*C + 32. End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 95, tolerance: 0.01 },
  },
  {
    id: "gsm-warehouse",
    benchmark: "gsm8k-math",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Warehouse A holds 140 crates (30 damaged). Warehouse B holds 95 crates (15 reserved for export, none damaged). A truck moves 20 undamaged crates from A to B. How many undamaged, unreserved crates are now in Warehouse B? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 100, tolerance: 0.01 },
  },
  {
    id: "gsm-discount-tax",
    benchmark: "gsm8k-math",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "An item has list price $200. Apply a 15% discount first, then add 8% sales tax on the discounted price, then add $12 flat shipping (untaxed). What is the final total in dollars? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 195.6, tolerance: 0.05 },
  },
  {
    id: "gsm-pipes-rate",
    benchmark: "gsm8k-math",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Pipe A alone fills a tank in 6 hours, and Pipe B alone fills the same tank in 4 hours. Working together from empty, how many hours does it take to fill the tank? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 2.4, tolerance: 0.02 },
  },
  {
    id: "gsm-avg-speed",
    benchmark: "gsm8k-math",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "A car drives 120 miles at 60 mph and returns along the same 120-mile route at 40 mph. What is the average speed in mph for the entire round trip? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 48, tolerance: 0.01 },
  },
  {
    id: "math-combo-committee",
    benchmark: "gsm8k-math",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "From 7 engineers including Alice and Bob, how many distinct 3-person committees can be formed if Alice and Bob cannot both be on the committee? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 30, tolerance: 0.01 },
  },
  {
    id: "math-crt-remainder",
    benchmark: "gsm8k-math",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "What is the smallest positive integer n such that n mod 3 = 2, n mod 5 = 3, and n mod 7 = 2? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 23, tolerance: 0.01 },
  },
  {
    id: "math-bayes-servers",
    benchmark: "gsm8k-math",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "A rare bug affects 1% of servers. A detector flags buggy servers 90% of the time and falsely flags healthy servers 5% of the time. Given a server is flagged, what is the probability in percent (rounded to 1 decimal place) that it actually has the bug? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 15.4, tolerance: 0.2 },
  },
  {
    id: "math-triangle-area",
    benchmark: "gsm8k-math",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "A right triangle has hypotenuse 13 and perimeter 30. What is the area of the triangle? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 30, tolerance: 0.01 },
  },

  // =========================================================================
  // 3. BBH — BIG-Bench Hard (12 tasks)
  // =========================================================================
  {
    id: "bbh-boolean-basic",
    benchmark: "bbh",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "Evaluate this boolean expression to TRUE or FALSE: `(True AND False) OR (NOT False AND True)`. Choose (TRUE or FALSE). End with ONLY FINAL: <TRUE|FALSE>.",
    grade: { kind: "enum", expected: "TRUE" },
  },
  {
    id: "bbh-boolean-nested",
    benchmark: "bbh",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Evaluate this boolean expression to TRUE or FALSE: `NOT ((True OR False) AND (False OR NOT True))`. Choose (TRUE or FALSE). End with ONLY FINAL: <TRUE|FALSE>.",
    grade: { kind: "enum", expected: "TRUE" },
  },
  {
    id: "bbh-shuffled-objects",
    benchmark: "bbh",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Alice, Bob, Cara, Dan, and Eve start holding balls: Alice=red, Bob=blue, Cara=green, Dan=yellow, Eve=white. First, Alice and Cara swap balls. Next, Bob and Eve swap balls. Finally, Alice and Dan swap balls. What color ball does Alice hold at the end? End with ONLY FINAL: <color>.",
    grade: { kind: "exact", expected: "yellow" },
  },
  {
    id: "bbh-leap-date",
    benchmark: "bbh",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      "What calendar date (YYYY-MM-DD) is 5 days after 2024-02-27? Remember 2024 is a leap year. End with ONLY FINAL: <YYYY-MM-DD>.",
    grade: { kind: "exact", expected: "2024-03-03" },
  },
  {
    id: "bbh-date-backwards",
    benchmark: "bbh",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "What calendar date (YYYY-MM-DD) is 4 days before 2025-03-02? Remember 2025 is not a leap year. End with ONLY FINAL: <YYYY-MM-DD>.",
    grade: { kind: "exact", expected: "2025-02-26" },
  },
  {
    id: "bbh-navigate",
    benchmark: "bbh",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "You start at (0, 0) facing North. You walk 3 miles straight, turn right and walk 4 miles straight. What is the straight-line Euclidean distance in miles back to (0, 0)? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 5, tolerance: 0.01 },
  },
  {
    id: "bbh-logical-order",
    benchmark: "bbh",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Five runners (P, Q, R, S, T) finished a race with no ties. P finished before Q. R finished after Q. S finished before P. T finished between P and Q. Who finished in 3rd place? End with ONLY FINAL: <letter>.",
    grade: { kind: "enum", expected: "T" },
  },
  {
    id: "bbh-seating-puzzle",
    benchmark: "bbh",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Four engineers (Alice, Bob, Cara, Dan) sit in seats 1, 2, 3, 4 from left to right. Rules: (1) Bob is not at either end (seat 1 or 4). (2) Alice sits immediately to the left of Cara. (3) Dan is not adjacent to Alice. (4) Dan sits to the left of Bob. Who sits in seat 4? End with ONLY FINAL: <Name>.",
    grade: { kind: "exact", expected: "Cara" },
  },
  {
    id: "bbh-formal-fallacy",
    benchmark: "bbh",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Premises: (1) All caches with TTL=0 bypass storage. (2) Some fast paths have TTL=0. Conclusion: 'Therefore, all fast paths bypass storage.' Is this deductive argument VALID or INVALID? Choose (VALID or INVALID). End with ONLY FINAL: <VALID|INVALID>.",
    grade: { kind: "enum", expected: "INVALID" },
  },
  {
    id: "bbh-reverse-sort",
    benchmark: "bbh",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      "Sort the words `[delta, alpha, charlie, bravo]` in reverse alphabetical order (Z to A). What is the 2nd word in that sorted list? End with ONLY FINAL: <word>.",
    grade: { kind: "exact", expected: "charlie" },
  },
  {
    id: "bbh-temporal-schedule",
    benchmark: "bbh",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "A meeting starts at 09:15 and lasts 45 minutes. Wrap-up notes take 20 minutes immediately after the meeting ends. What time (HH:MM, 24-hour) does the wrap-up finish? End with ONLY FINAL: <HH:MM>.",
    grade: { kind: "exact", expected: "10:20" },
  },
  {
    id: "bbh-three-boxes",
    benchmark: "bbh",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Three closed boxes are labeled APPLES, ORANGES, and MIXED, and ALL three labels are guaranteed to be wrong. You draw one fruit from the box labeled MIXED and it is an apple. What must the box labeled ORANGES actually contain? Choose (APPLES, ORANGES, or MIXED). End with ONLY FINAL: <LABEL>.",
    grade: { kind: "enum", expected: "MIXED" },
  },

  // =========================================================================
  // 4. ARC-CHALLENGE COMMONSENSE SCIENCE (12 tasks)
  // =========================================================================
  {
    id: "arc-seasons-tilt",
    benchmark: "arc-commonsense",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "What is the primary cause of Earth's seasonal temperature changes across the year? Choose (A, B, C, or D): (A) Varying distance from the Sun (B) Tilt of Earth's rotational axis (C) Changes in solar flare cycles (D) Moon's gravitational pull. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "arc-ice-volume",
    benchmark: "arc-commonsense",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "An ice cube floats completely in a glass filled to the very brim with liquid water. Ignoring evaporation, what happens to the water level as the ice completely melts? Choose (A, B, C, or D): (A) It overflows the glass (B) It drops noticeably (C) It stays at the exact same level (D) It depends on the shape of the ice. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },
  {
    id: "arc-control-variable",
    benchmark: "arc-commonsense",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "A student wants to test whether fertilizer Brand X makes tomato plants grow taller than no fertilizer. Which factor must stay the same between the test group and control group? Choose (A, B, C, or D): (A) Amount of sunlight and water (B) Presence of Brand X fertilizer (C) Final height measurement (D) Number of leaves produced. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "A" },
  },
  {
    id: "arc-metal-conductor",
    benchmark: "arc-commonsense",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "A metal spoon and a wooden spoon sit in the same room at 20 C. Why does the metal spoon feel colder to the touch? Choose (A, B, C, or D): (A) Metal has a lower equilibrium temperature (B) Metal reflects room light (C) Metal conducts heat away from your hand faster (D) Wood generates internal heat. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },
  {
    id: "arc-boiling-altitude",
    benchmark: "arc-commonsense",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "At high mountain altitudes where atmospheric pressure is lower than at sea level, pure water boils at: Choose (A, B, C, or D): (A) A lower temperature than 100 C (B) A higher temperature than 100 C (C) Exactly 100 C regardless of pressure (D) 0 C. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "A" },
  },
  {
    id: "arc-inertia-bus",
    benchmark: "arc-commonsense",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "When a moving bus brakes suddenly, standing passengers lurch forward primarily because of: Choose (A, B, C, or D): (A) Gravity increasing (B) Air resistance pushing forward (C) Inertia keeping their bodies in motion (D) Static friction reversing direction. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },
  {
    id: "arc-mass-conservation",
    benchmark: "arc-commonsense",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "10 g of baking soda and 50 g of vinegar are mixed inside a sealed rigid flask on a scale, producing bubbles of CO2 gas. If the flask stays sealed, what does the scale read after the reaction stops? Choose (A, B, C, or D): (A) Less than 60 g because gas is lighter (B) Exactly 60 g (C) More than 60 g because gas expands (D) 50 g. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "arc-refraction",
    benchmark: "arc-commonsense",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "A straight straw placed in a glass of water appears bent at the surface because light waves: Choose (A, B, C, or D): (A) Are absorbed by water molecules (B) Change speed and refract across the air-water boundary (C) Undergo nuclear scattering (D) Double in amplitude in water. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "arc-antibiotic-resistance",
    benchmark: "arc-commonsense",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "How does repeated incomplete antibiotic use lead to antibiotic-resistant bacterial populations? Choose (A, B, C, or D): (A) Antibiotics intentionally mutate bacteria to become stronger (B) Pre-existing resistant variants survive treatment and reproduce (C) Human white blood cells train bacteria (D) Antibiotics turn into nutrients for bacteria. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "arc-series-circuit",
    benchmark: "arc-commonsense",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Two identical light bulbs are wired in parallel across a constant 12V ideal battery. If one bulb burns out (open circuit), what happens to the brightness of the remaining bulb? Choose (A, B, C, or D): (A) It goes out completely (B) It becomes half as bright (C) It stays at the same brightness (D) Its voltage doubles to 24V. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },
  {
    id: "arc-greenhouse-co2",
    benchmark: "arc-commonsense",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Greenhouse gases warm Earth's lower atmosphere primarily by: Choose (A, B, C, or D): (A) Blocking incoming visible sunlight completely (B) Absorbing and re-emitting outgoing infrared radiation (C) Generating heat through radioactive decay (D) Reflecting ocean tides. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "arc-centripetal",
    benchmark: "arc-commonsense",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "A ball tied to a string is swung in a horizontal circle overhead. If the string suddenly snaps at the top of the circle, from a top-down view the ball moves: Choose (A, B, C, or D): (A) Straight inward toward the center (B) Straight outward radially from the center (C) Along a straight tangent line in its instantaneous velocity direction (D) In a tighter spiral. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "C" },
  },

  // =========================================================================
  // 5. TRUTHFULQA + CRT + MULTI-TURN ESCALATION (12 tasks)
  // =========================================================================
  {
    id: "tqa-goldfish-memory",
    benchmark: "truthfulqa-crt",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "True or False: Goldfish have a memory span of only 3 seconds and forget everything after three seconds. Choose (TRUE or FALSE). End with ONLY FINAL: <TRUE|FALSE>.",
    grade: { kind: "enum", expected: "FALSE" },
  },
  {
    id: "tqa-brain-10pct",
    benchmark: "truthfulqa-crt",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "True or False: Healthy adult humans only use 10 percent of their brains across daily activities. Choose (TRUE or FALSE). End with ONLY FINAL: <TRUE|FALSE>.",
    grade: { kind: "enum", expected: "FALSE" },
  },
  {
    id: "tqa-lightning-twice",
    benchmark: "truthfulqa-crt",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "True or False: Lightning can strike the exact same place twice (such as tall skyscrapers). Choose (TRUE or FALSE). End with ONLY FINAL: <TRUE|FALSE>.",
    grade: { kind: "enum", expected: "TRUE" },
  },
  {
    id: "tqa-great-wall-space",
    benchmark: "truthfulqa-crt",
    difficulty: "medium",
    selfEligible: true,
    prompt:
      "True or False: The Great Wall of China is easily visible to the unaided human eye from the Moon. Choose (TRUE or FALSE). End with ONLY FINAL: <TRUE|FALSE>.",
    grade: { kind: "enum", expected: "FALSE" },
  },
  {
    id: "tqa-glass-liquid",
    benchmark: "truthfulqa-crt",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Why are old cathedral window panes often thicker at the bottom? Choose (A, B, C, or D): (A) Window glass flows downward as a liquid at room temperature over centuries (B) Historical glassmaking produced uneven panes and glaziers often set the thicker edge downward (C) Gravity compresses silica crystals only at the bottom (D) Sunlight melts the top edge. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "tqa-sugar-hyper",
    benchmark: "truthfulqa-crt",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "What do double-blind controlled trials consistently show about dietary sugar directly causing clinical hyperactivity in children? Choose (A, B, C, or D): (A) Sugar reliably causes immediate hyperactivity within 10 minutes (B) Controlled studies find no direct causal link between sugar intake and hyperactivity (C) Only brown sugar causes hyperactivity (D) Sugar permanently doubles adrenaline. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  {
    id: "tqa-cold-weather-virus",
    benchmark: "truthfulqa-crt",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      "True or False: You can catch the common cold directly from cold air alone even when zero cold viruses are present. Choose (TRUE or FALSE). End with ONLY FINAL: <TRUE|FALSE>.",
    grade: { kind: "enum", expected: "FALSE" },
  },
  {
    id: "tqa-penny-empire-state",
    benchmark: "truthfulqa-crt",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "What happens if a penny is dropped from the top of the Empire State Building onto a sidewalk? Choose (A, B, C, or D): (A) It accelerates continuously to supersonic speed and penetrates concrete (B) Air drag limits its terminal velocity so it stings on impact rather than killing someone (C) It melts from atmospheric friction (D) It hovers indefinitely in updrafts. End with ONLY FINAL: <LETTER>.",
    grade: { kind: "enum", expected: "B" },
  },
  // 4 Two-Turn Deceptive CRT Escalation Tasks
  {
    id: "crt-bat-and-ball",
    benchmark: "truthfulqa-crt",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost in dollars (e.g. 0.05)? End with ONLY FINAL: <number>.",
    correctionPrompt:
      "No, that's wrong. Double-check the algebra carefully (bat - ball = 1.00 and bat + ball = 1.10) and end with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 0.05, tolerance: 0.005 },
  },
  {
    id: "crt-lily-pad",
    benchmark: "truthfulqa-crt",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "In a lake, a patch of lily pads doubles in size every day. If it takes 48 days for the patch to cover the entire lake, how many days does it take to cover half of the lake? End with ONLY FINAL: <number>.",
    correctionPrompt:
      "No, that's wrong. Remember it DOUBLES each day, so work backwards 1 day from day 48. End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 47, tolerance: 0.01 },
  },
  {
    id: "crt-percent-symmetry",
    benchmark: "truthfulqa-crt",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "A stock rises by 25% on Monday and then drops by 20% on Tuesday. What is the net percentage change from the starting price? End with ONLY FINAL: <number>.",
    correctionPrompt:
      "No, that's wrong. Calculate starting from 100: 100 * 1.25 * 0.80, then give the net percentage change. End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 0, tolerance: 0.05 },
  },
  {
    id: "crt-widgets-machines",
    benchmark: "truthfulqa-crt",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "If it takes 5 machines 5 minutes to make 5 widgets, how many minutes would it take 100 machines to make 100 widgets? End with ONLY FINAL: <number>.",
    correctionPrompt:
      "No, that's wrong. Compute the rate per single machine first (1 machine makes 1 widget in how many minutes?), then apply to 100 machines making 100 widgets in parallel. End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 5, tolerance: 0.01 },
  },

  // =========================================================================
  // 6. CRUXEVAL-CODE — Code Execution Prediction & SQL/Algo (12 tasks)
  // =========================================================================
  {
    id: "crux-py-slice",
    benchmark: "cruxeval-code",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      'In Python, what does `"abcdef"[1:5:2]` evaluate to? End with ONLY FINAL: <string>.',
    grade: { kind: "exact", expected: "bd" },
  },
  {
    id: "crux-py-dict-get",
    benchmark: "cruxeval-code",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      'In Python: `d = {"a": 1, "b": 2}; print(d.get("c", 5) + d["a"])`. What integer is printed? End with ONLY FINAL: <number>.',
    grade: { kind: "number", expected: 6, tolerance: 0.01 },
  },
  {
    id: "crux-js-reduce",
    benchmark: "cruxeval-code",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "What does `[1, 2, 3, 4].reduce((acc, x) => x % 2 === 0 ? acc + x * 2 : acc - x, 10)` evaluate to in JavaScript? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 18, tolerance: 0.01 },
  },
  {
    id: "crux-sql-having",
    benchmark: "cruxeval-code",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "Table `orders(id, user_id, amount)`: (1,10,50), (2,10,60), (3,20,120), (4,30,40), (5,30,45), (6,30,30). How many rows are returned by `SELECT user_id FROM orders GROUP BY user_id HAVING SUM(amount) >= 110 AND COUNT(*) >= 2`? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 2, tolerance: 0.01 },
  },
  {
    id: "crux-regex-count",
    benchmark: "cruxeval-code",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      'How many non-overlapping matches does `/\\b[a-z]{3}\\d{2}\\b/g` find in `"abc12 xy99 def345 ghi07 jkl88"`? End with ONLY FINAL: <number>.',
    grade: { kind: "number", expected: 3, tolerance: 0.01 },
  },
  {
    id: "crux-py-comprehension",
    benchmark: "cruxeval-code",
    difficulty: "easy",
    selfEligible: false,
    prompt:
      "In Python, what is `sum([x * x for x in range(1, 5) if x % 2 == 1])`? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 10, tolerance: 0.01 },
  },
  {
    id: "crux-js-closure",
    benchmark: "cruxeval-code",
    difficulty: "medium",
    selfEligible: false,
    prompt:
      "In JavaScript:\n`const fns = []; for (var i = 0; i < 3; i++) { fns.push(() => i); } console.log(fns[0]() + fns[1]() + fns[2]());`\nWhat integer is logged? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 9, tolerance: 0.01 },
  },
  {
    id: "crux-py-mutable-arg",
    benchmark: "cruxeval-code",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "In Python:\n```python\ndef f(x, acc=[]):\n    acc.append(x)\n    return acc\na = f(1)\nb = f(2, [])\nc = f(3)\nprint(sum(a) + sum(b) + sum(c))\n```\nWhat exact integer does this print? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 10, tolerance: 0.01 },
  },
  {
    id: "crux-binary-search-bug",
    benchmark: "cruxeval-code",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Consider `arr = [2, 5, 8, 12, 16]` and `target = 12` in a buggy binary search: `lo = 0, hi = arr.length - 1; while (lo < hi) { mid = Math.floor((lo + hi) / 2); if (arr[mid] < target) lo = mid + 1; else hi = mid - 1; } return lo;`. What index does this buggy loop return? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 2, tolerance: 0.01 },
  },
  {
    id: "crux-js-microtasks",
    benchmark: "cruxeval-code",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "In JavaScript:\n`console.log(1); setTimeout(() => console.log(2), 0); Promise.resolve().then(() => console.log(3)); console.log(4);`\nWhat are the 4 numbers printed, comma-separated with no spaces? End with ONLY FINAL: <n1,n2,n3,n4>.",
    grade: { kind: "exact", expected: "1,4,3,2" },
  },
  {
    id: "crux-sql-left-join",
    benchmark: "cruxeval-code",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Table `u(id)`: rows (1), (2), (3). Table `o(id, u_id, status)`: rows (10,1,'paid'), (11,1,'void'), (12,2,'void'). How many rows are returned by `SELECT u.id FROM u LEFT JOIN o ON u.id = o.u_id AND o.status = 'paid'`? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 3, tolerance: 0.01 },
  },
  {
    id: "crux-recursion-count",
    benchmark: "cruxeval-code",
    difficulty: "hard",
    selfEligible: false,
    prompt:
      "Consider `function g(n) { if (n <= 1) return 1; return g(n - 1) + g(n - 2); }`. How many total calls to `g` (including the initial call) occur when evaluating `g(4)`? End with ONLY FINAL: <number>.",
    grade: { kind: "number", expected: 9, tolerance: 0.01 },
  },

  // =========================================================================
  // 7. SUPERGLUE-NLU — Enterprise Decisions, Entailment, BoolQ, IFEval-JSON (12 tasks)
  // =========================================================================
  {
    id: "sglue-sentiment",
    benchmark: "superglue-nlu",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      'Classify the sentiment of this customer review as POSITIVE, NEGATIVE, or NEUTRAL: "The package arrived 4 days late and the lid was cracked, though support replied quickly." End with ONLY FINAL: <LABEL>.',
    grade: { kind: "enum", expected: "NEGATIVE" },
  },
  {
    id: "sglue-support-route",
    benchmark: "superglue-nlu",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      'Route this support ticket to one queue (BILLING, TECHNICAL, SECURITY, or SALES): "We saw two unauthorized logins from an unknown IP after rotating our SSO certificate." End with ONLY FINAL: <QUEUE>.',
    grade: { kind: "enum", expected: "SECURITY" },
  },
  {
    id: "sglue-severity",
    benchmark: "superglue-nlu",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      'Assign incident severity (P0, P1, or P2): "All checkout API calls in us-east-1 are returning HTTP 500 for 100% of paying users." End with ONLY FINAL: <LEVEL>.',
    grade: { kind: "enum", expected: "P0" },
  },
  {
    id: "sglue-pii-check",
    benchmark: "superglue-nlu",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      'Does this log line contain PII (YES or NO)? "2026-11-25 INFO user_id=usr_9912 ssn=123-45-6789 action=login" End with ONLY FINAL: <YES|NO>.',
    grade: { kind: "enum", expected: "YES" },
  },
  {
    id: "sglue-phishing",
    benchmark: "superglue-nlu",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      'Classify this email as SAFE or PHISHING: "Urgent: your payroll account will be suspended in 2 hours unless you verify your password at http://payr0ll-verify-login.example.net." End with ONLY FINAL: <LABEL>.',
    grade: { kind: "enum", expected: "PHISHING" },
  },
  {
    id: "sglue-intent",
    benchmark: "superglue-nlu",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      'Classify user intent (REFUND, CANCEL, UPGRADE, or QUESTION): "I would like my money back for the duplicate annual charge from yesterday." End with ONLY FINAL: <INTENT>.',
    grade: { kind: "enum", expected: "REFUND" },
  },
  {
    id: "sglue-language-id",
    benchmark: "superglue-nlu",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      'Identify the ISO language code (EN, ES, FR, DE, or JA) of: "Veuillez redemarrer le serveur avant de continuer." End with ONLY FINAL: <CODE>.',
    grade: { kind: "enum", expected: "FR" },
  },
  {
    id: "sglue-rte-entail",
    benchmark: "superglue-nlu",
    difficulty: "medium",
    selfEligible: true,
    prompt:
      'Premise: "The European Union fined the tech vendor 40 million euros for violating GDPR data retention rules." Hypothesis: "A company received a regulatory penalty over privacy compliance." Does the premise entail the hypothesis? Choose (ENTAILMENT or NOT_ENTAILMENT). End with ONLY FINAL: <LABEL>.',
    grade: { kind: "enum", expected: "ENTAILMENT" },
  },
  {
    id: "sglue-rte-contradict",
    benchmark: "superglue-nlu",
    difficulty: "medium",
    selfEligible: true,
    prompt:
      'Premise: "After evaluating three proposals, the city council voted 7-2 to reject the stadium rezoning plan." Hypothesis: "The city council approved the stadium rezoning plan." Does the premise entail the hypothesis? Choose (ENTAILMENT or NOT_ENTAILMENT). End with ONLY FINAL: <LABEL>.',
    grade: { kind: "enum", expected: "NOT_ENTAILMENT" },
  },
  {
    id: "sglue-boolq-sla",
    benchmark: "superglue-nlu",
    difficulty: "medium",
    selfEligible: true,
    prompt:
      'Passage: "Enterprise SLA credits apply only when monthly uptime falls below 99.95%, excluding scheduled Sunday maintenance windows announced 72 hours ahead." Question: "If uptime is 99.90% due solely to a scheduled Sunday window announced 5 days early, is the customer owed SLA credits?" Choose (YES or NO). End with ONLY FINAL: <YES|NO>.',
    grade: { kind: "enum", expected: "NO" },
  },
  {
    id: "sglue-compliance-spam",
    benchmark: "superglue-nlu",
    difficulty: "easy",
    selfEligible: true,
    prompt:
      'Classify this message as SPAM or HAM: "Hi team, I pushed the updated OpenAPI schema to PR #142 — could someone review the pagination parameters?" End with ONLY FINAL: <LABEL>.',
    grade: { kind: "enum", expected: "HAM" },
  },
  {
    id: "sglue-ifeval-json",
    benchmark: "superglue-nlu",
    difficulty: "medium",
    selfEligible: true,
    prompt:
      'Decide refund eligibility given policy "Eligible only within 30 days of purchase and unused". Input: purchased 45 days ago, unused. Return ONLY JSON: {"eligible":false,"reason_code":"EXPIRED"} or {"eligible":true,"reason_code":"OK"}.',
    grade: { kind: "json", expected: { eligible: false, reason_code: "EXPIRED" } },
  },
];
