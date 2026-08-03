import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAX_PLAYERS_PER_TOURNAMENT } from "@/lib/tournament";
import { roundRobinSchedule, type ScheduledPair } from "@/lib/pairing-oracle";

/**
 * Proves the oracle is a correct round robin, before it is trusted to judge the SQL.
 *
 * These properties check the schedule against what a round robin *is*, not against another
 * implementation — which is what makes the oracle worth having. If these pass and the SQL
 * disagrees with the oracle, the SQL is wrong.
 */

/** Roster of `n` distinct ids, deliberately not in sorted order so the sort is exercised. */
function roster(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `p${String(n - i).padStart(3, "0")}`);
}

const pairKey = (p: ScheduledPair) => [p.a, p.b].sort().join("|");

describe("roundRobinSchedule", () => {
  describe("degenerate rosters", () => {
    it.each([[0], [1]])("produces no matches for %i player(s)", (n) => {
      expect(roundRobinSchedule(roster(n))).toEqual([]);
    });

    it("pairs two players in a single round", () => {
      expect(roundRobinSchedule(["b", "a"])).toEqual([{ round: 1, a: "a", b: "b" }]);
    });
  });

  describe("worked cases from the prior hand-trace", () => {
    // These are the only verification the SQL has ever had, recorded in
    // context/changes/generate-round-robin-pairing/reviews/impl-review.md. The oracle must
    // agree with them, or one of the two is wrong and we would not know which.
    it("n=4 produces R1: 1-2, 3-4 / R2: 1-3, 4-2 / R3: 1-4, 2-3", () => {
      const byRound = groupByRound(roundRobinSchedule(["1", "2", "3", "4"]));

      expect(byRound[1]).toEqual([
        ["1", "2"],
        ["3", "4"],
      ]);
      expect(byRound[2]).toEqual([
        ["1", "3"],
        ["2", "4"],
      ]);
      expect(byRound[3]).toEqual([
        ["1", "4"],
        ["2", "3"],
      ]);
    });

    it("n=3 gives each player one round off and no bye rows", () => {
      const byRound = groupByRound(roundRobinSchedule(["1", "2", "3"]));

      expect(byRound[1]).toEqual([["1", "2"]]);
      expect(byRound[2]).toEqual([["1", "3"]]);
      expect(byRound[3]).toEqual([["2", "3"]]);
    });
  });

  describe("properties over rosters of 2 to 50 players", () => {
    // 50 is the product's hard cap (MAX_PLAYERS_PER_TOURNAMENT), which is also where the
    // schedule is least exercised by manual testing — 1225 pairs across 49 rounds.
    const rosterSize = fc.integer({ min: 2, max: MAX_PLAYERS_PER_TOURNAMENT });

    it("produces exactly n(n-1)/2 pairs", () => {
      fc.assert(
        fc.property(rosterSize, (n) => {
          expect(roundRobinSchedule(roster(n))).toHaveLength((n * (n - 1)) / 2);
        }),
      );
    });

    it("pairs every player with every other exactly once", () => {
      fc.assert(
        fc.property(rosterSize, (n) => {
          const schedule = roundRobinSchedule(roster(n));
          const seen = new Set(schedule.map(pairKey));

          // No duplicates, and the count matches — together these mean every unordered pair
          // appears exactly once, since there are only n(n-1)/2 possible pairs.
          expect(seen.size).toBe(schedule.length);
          expect(seen.size).toBe((n * (n - 1)) / 2);
        }),
      );
    });

    it("never pairs a player with themselves", () => {
      fc.assert(
        fc.property(rosterSize, (n) => {
          for (const pair of roundRobinSchedule(roster(n))) {
            expect(pair.a).not.toBe(pair.b);
          }
        }),
      );
    });

    it("never schedules a player twice within one round", () => {
      // THE PROPERTY THAT MATTERS MOST. `round_number` participates in no database constraint
      // and no index — the lifetime-scoped matches_tournament_pair_uniq covers "this pair meets
      // once ever", not "this player plays once per round". So this specific corruption would
      // land in production silently, and a player would be told to find two people at once.
      fc.assert(
        fc.property(rosterSize, (n) => {
          const byRound = new Map<number, Set<string>>();

          for (const { round, a, b } of roundRobinSchedule(roster(n))) {
            const players = byRound.get(round) ?? new Set<string>();
            expect(players.has(a), `${a} appears twice in round ${round} (n=${n})`).toBe(false);
            expect(players.has(b), `${b} appears twice in round ${round} (n=${n})`).toBe(false);
            players.add(a).add(b);
            byRound.set(round, players);
          }
        }),
      );
    });

    it("spans rounds 1..n-1 for an even roster and 1..n for an odd one", () => {
      fc.assert(
        fc.property(rosterSize, (n) => {
          const rounds = new Set(roundRobinSchedule(roster(n)).map((p) => p.round));
          const expected = n % 2 === 0 ? n - 1 : n;

          expect([...rounds].sort((x, y) => x - y)).toEqual(Array.from({ length: expected }, (_, i) => i + 1));
        }),
      );
    });

    it("gives every player exactly n-1 matches", () => {
      fc.assert(
        fc.property(rosterSize, (n) => {
          const appearances = new Map<string, number>();
          for (const { a, b } of roundRobinSchedule(roster(n))) {
            appearances.set(a, (appearances.get(a) ?? 0) + 1);
            appearances.set(b, (appearances.get(b) ?? 0) + 1);
          }

          expect(appearances.size).toBe(n);
          for (const [player, count] of appearances) {
            expect(count, `${player} has ${count} matches, expected ${n - 1} (n=${n})`).toBe(n - 1);
          }
        }),
      );
    });

    it("is deterministic and independent of input order", () => {
      // The SQL sorts with `array_agg(user_id order by user_id)`, so the oracle must too, or
      // the two schedules would only agree when the caller happened to pass sorted input.
      fc.assert(
        fc.property(rosterSize, (n) => {
          const forward = roster(n);
          const shuffled = [...forward].reverse();

          expect(roundRobinSchedule(shuffled)).toEqual(roundRobinSchedule(forward));
        }),
      );
    });
  });

  describe("exhaustive sweep over every roster size in range", () => {
    // The properties above are sampled: fast-check draws ~100 values from a 49-value space, so
    // full coverage is likely but not guaranteed, and "exercises n=2 through n=50" would be a
    // claim about probability rather than a fact. This sweep makes it a fact — the input space
    // is small enough to enumerate, so there is no reason to sample it.
    const sizes = Array.from({ length: MAX_PLAYERS_PER_TOURNAMENT - 1 }, (_, i) => i + 2);

    it.each(sizes)("n=%i satisfies every round-robin invariant", (n) => {
      const ids = new Set(roster(n));
      const schedule = roundRobinSchedule(roster(n));
      const seenPairs = new Set<string>();
      const perRound = new Map<number, Set<string>>();
      const appearances = new Map<string, number>();

      expect(schedule).toHaveLength((n * (n - 1)) / 2);

      for (const { round, a, b } of schedule) {
        // No bye rows: least()/greatest() ignore NULLs, so two byes for the same player would
        // collide on matches_tournament_pair_uniq. The phantom's pairs must vanish entirely.
        expect(ids.has(a) && ids.has(b), `unknown player in a pair at n=${n}`).toBe(true);
        expect(a).not.toBe(b);

        const key = [a, b].sort().join("|");
        expect(seenPairs.has(key), `${key} scheduled twice at n=${n}`).toBe(false);
        seenPairs.add(key);

        const players = perRound.get(round) ?? new Set<string>();
        expect(players.has(a) || players.has(b), `a player appears twice in round ${round} at n=${n}`).toBe(false);
        players.add(a).add(b);
        perRound.set(round, players);

        appearances.set(a, (appearances.get(a) ?? 0) + 1);
        appearances.set(b, (appearances.get(b) ?? 0) + 1);
      }

      expect(perRound.size).toBe(n % 2 === 0 ? n - 1 : n);
      expect(appearances.size).toBe(n);
      for (const count of appearances.values()) {
        expect(count).toBe(n - 1);
      }
    });
  });
});

/** Groups a schedule into `round -> sorted pairs`, for readable assertions on small rosters. */
function groupByRound(schedule: ScheduledPair[]): Record<number, string[][]> {
  const byRound: Record<number, string[][]> = {};
  for (const { round, a, b } of schedule) {
    (byRound[round] ??= []).push([a, b].sort());
  }
  for (const pairs of Object.values(byRound)) {
    pairs.sort((x, y) => x[0].localeCompare(y[0]));
  }
  return byRound;
}
