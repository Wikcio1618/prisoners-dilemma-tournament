import { describe, expect, it } from "vitest";

/**
 * The scoring oracle, written BEFORE the implementation exists. This is the whole reason this
 * rollout phase is sequenced ahead of S-04.
 *
 * ============================ READ THIS BEFORE EDITING ============================
 *
 * Every expected value below was derived BY HAND from the PRD's Business Logic ->
 * "Scoring specification" subsection, which was ratified on 2026-08-01. None of it was
 * generated from, or checked against, any implementation — because none existed when this
 * file was written.
 *
 * That ordering is the only thing that makes these tests an oracle. An expected value lifted
 * from the code under test is tautological: it green-lights whatever the implementation
 * currently does, including its bugs, and can never fail for the right reason.
 *
 * So: if a case here fails once `src/lib/scoring.ts` exists, the default assumption is that
 * the IMPLEMENTATION is wrong. Change a number here only after re-deriving it from the PRD
 * text and concluding the PRD says something different from what this file claims — and then
 * fix the PRD too, so the two never disagree silently.
 *
 * The cases are `test.todo` rather than `test.skip`. Todo reports as
 * "not yet implemented" and shows in Vitest's summary as a standing reminder; skip reads as
 * "temporarily disabled", which is not what this is. S-04 turns them on by uncommenting the
 * assertion bodies and importing the module.
 *
 * ==================================================================================
 *
 * A note on vocabulary. The shipped move type is
 * `Move = "cooperate" | "sabotage"` (`src/durable/match-message.ts`), and that is what the
 * module below should take. The fixtures here use `"C"` / `"S"` purely as shorthand so a
 * five-round sequence stays readable on one line; the todo titles use the same shorthand for
 * the same reason. When S-04 turns these on it maps `C -> "cooperate"` and `S -> "sabotage"` —
 * the shorthand is a fixture-authoring convenience, never a second vocabulary to support.
 *
 * Intended module surface (`src/lib/scoring.ts`, owned by S-04):
 *
 *   payoff(own: Move, opponent: Move): number
 *   scoreFor(playerId: string, matches: MatchHistory[]): number
 *   matchesPlayed(playerId: string, matches: MatchHistory[]): number
 *   initialAggression(playerId: string, matches: MatchHistory[]): number | undefined
 *   forgiveness(playerId: string, matches: MatchHistory[]): number | undefined
 *
 * `undefined` — not `null`, not `0` — is the specified return for an undefined statistic, and
 * the PRD requires it to render as an em dash.
 */

/** Shorthand for the fixtures: C = Współpraca (cooperate), S = Sabotaż (sabotage). */
type M = "C" | "S";

interface Fixture {
  readonly label: string;
  readonly playerA: string;
  readonly playerB: string;
  /** Round-by-round, index-aligned. `movesA[i]` and `movesB[i]` are the same round. */
  readonly movesA: readonly M[];
  readonly movesB: readonly M[];
}

/**
 * Three matches over four players.
 *
 * Three properties of this set are deliberate. Preserve them if it is ever edited, or the
 * fixture stops discriminating between a correct implementation and a plausible wrong one:
 *
 *   1. Alice's and Bob's totals are ASYMMETRIC (19 vs 14), so an implementation that swaps
 *      the two players' payoffs cannot pass.
 *   2. Dave is NEVER PROVOKED, so his forgiveness exercises the undefined case. An
 *      implementation returning 0 or 1.0 there fails — both are wrong in opposite directions.
 *   3. The ranking INVERTS under normalization: Alice leads on total (19 > 14) but Bob leads
 *      on points per round (2.8 > 2.71). This is exactly why matches-played is displayed, and
 *      it makes that product decision testable rather than decorative.
 */
const FIXTURES: readonly Fixture[] = [
  {
    label: "Match A — Alice vs Bob, 5 rounds",
    playerA: "alice",
    playerB: "bob",
    movesA: ["C", "C", "S", "S", "C"],
    movesB: ["S", "C", "C", "S", "S"],
  },
  {
    label: "Match B — Carol vs Dave, 3 rounds, mutual cooperation throughout",
    playerA: "carol",
    playerB: "dave",
    movesA: ["C", "C", "C"],
    movesB: ["C", "C", "C"],
  },
  {
    label: "Match C — Alice vs Carol, 2 rounds, Alice defects throughout",
    playerA: "alice",
    playerB: "carol",
    movesA: ["S", "S"],
    movesB: ["C", "C"],
  },
];

describe("payoff matrix", () => {
  // The four cells of the PRD's table, asserted individually so a transposed matrix fails
  // distinguishably from an aggregation error.
  it.todo("cooperate against cooperate scores 3 (R) — expect(payoff('C','C')).toBe(3)");
  it.todo("sabotage against cooperate scores 5 (T) — expect(payoff('S','C')).toBe(5)");
  it.todo("cooperate against sabotage scores 0 (S) — expect(payoff('C','S')).toBe(0)");
  it.todo("sabotage against sabotage scores 1 (P) — expect(payoff('S','S')).toBe(1)");

  it.todo("satisfies T > R > P > S — expect(5).toBeGreaterThan(3); 3 > 1; 1 > 0");
  it.todo("satisfies 2R > T + S (6 > 5), which is what rewards sustained cooperation");
});

describe("per-round payoffs in Match A", () => {
  // Pinned individually, not just as a total. A matrix transposition and a summation bug both
  // move the total; only the per-round sequence tells them apart.
  it.todo("Alice scores 0,3,5,1,0 across the five rounds");
  it.todo("Bob scores 5,3,0,1,5 across the five rounds");
});

describe("score — plain sum across every round played", () => {
  it.todo("Alice scores 19 — 9 from Match A (0+3+5+1+0) plus 10 from Match C (5+5)");
  it.todo("Bob scores 14 — 5+3+0+1+5, from Match A only");
  it.todo("Carol scores 9 — 9 from Match B (3+3+3) plus 0 from Match C (0+0)");
  it.todo("Dave scores 9 — 3+3+3, from Match B only");

  it.todo("a player with no matches scores 0 — the sum of nothing, not undefined");
});

describe("matches played", () => {
  it.todo("Alice played 2 matches");
  it.todo("Bob played 1 match");
  it.todo("Carol played 2 matches");
  it.todo("Dave played 1 match");

  it.todo(
    "the board's ranking inverts under normalization: Alice leads on total (19 > 14) " +
      "but Bob leads on points per round (14/5 = 2.8 > 19/7 = 2.71)",
  );

  it.todo("a match with zero rounds played does not count toward matches played");
});

describe("initial aggression — fraction of matches opened with Sabotaż", () => {
  it.todo("Alice is 0.5 — opened Match A with C, Match C with S, so 1 of 2");
  it.todo("Bob is 1.0 — opened his only match with S, so 1 of 1");
  it.todo("Carol is 0 — opened both her matches with C, so 0 of 2");
  it.todo("Dave is 0 — opened his only match with C, so 0 of 1");

  it.todo("is undefined for a player with no matches — NOT 0, which would read as 'never aggressive'");
  it.todo("a match with zero rounds played contributes to neither numerator nor denominator");
});

describe("forgiveness — cooperation after the opponent's defection", () => {
  // A provocation is: opponent played S at round i-1, AND round i exists in that match.
  it.todo(
    "Alice is 1.0 — Bob defected at A/R1 and A/R4; Alice answered C at both A/R2 and A/R5, so 2 of 2. " +
      "Bob's defection at A/R5 is NOT a provocation because no round 6 exists.",
  );
  it.todo("Bob is 0.0 — Alice defected at A/R3 and A/R4; Bob answered S at both A/R4 and A/R5, so 0 of 2");
  it.todo(
    "Carol is 1.0 — Alice defected at C/R1 and Carol answered C at C/R2, so 1 of 1. " +
      "Alice's defection at C/R2 is not a provocation, being the final round.",
  );
  it.todo("Dave is undefined — Carol never defected against him, so he was never provoked");

  it.todo("0.0 and undefined are distinguishable — Bob forgave nothing, Dave was never asked to");
  it.todo("a final-round Sabotaż is never a provocation, in any match");
  it.todo(
    "a provocation never spans a match boundary — the last round of one match cannot provoke the first of another",
  );
  it.todo("is undefined for a player with no matches");
});

describe("undefined rendering", () => {
  it.todo("an undefined statistic renders as an em dash, never as 0 and never as 1.0");
  it.todo("a player with an undefined statistic still appears on the scoreboard");
});

/**
 * The fixtures are exercised here so that this file is not entirely inert while its
 * expectations wait for S-04: if a fixture is edited into an inconsistent shape, this fails
 * immediately rather than silently invalidating every expected value above.
 */
describe("fixture integrity", () => {
  it.each(FIXTURES)("$label has index-aligned move sequences", (fixture) => {
    expect(fixture.movesA).toHaveLength(fixture.movesB.length);
    expect(fixture.movesA.length).toBeGreaterThan(0);
  });

  it("covers all four payoff cells across the fixture set", () => {
    const cells = new Set<string>();
    for (const { movesA, movesB } of FIXTURES) {
      movesA.forEach((a, i) => cells.add(`${a}${movesB[i]}`));
    }
    expect([...cells].sort()).toEqual(["CC", "CS", "SC", "SS"]);
  });

  it("keeps Dave unprovoked, which is the undefined-forgiveness case", () => {
    const daveMatches = FIXTURES.filter((f) => f.playerA === "dave" || f.playerB === "dave");
    for (const f of daveMatches) {
      const opponentMoves = f.playerA === "dave" ? f.movesB : f.movesA;
      // Only rounds before the last can provoke, so slice off the final move.
      expect(opponentMoves.slice(0, -1)).not.toContain("S");
    }
  });

  it("keeps Alice's and Bob's round counts different, which is what makes the ranking invert", () => {
    const roundsFor = (player: string) =>
      FIXTURES.filter((f) => f.playerA === player || f.playerB === player).reduce((n, f) => n + f.movesA.length, 0);
    expect(roundsFor("alice")).toBe(7);
    expect(roundsFor("bob")).toBe(5);
  });
});
