import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MATCH_STATUSES, TOURNAMENT_STATUSES } from "@/lib/tournament";

const MIGRATIONS = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));

/**
 * The transition table, and the four dead ends it currently contains.
 *
 * Every `test.todo` below fails CORRECTLY today. They are not regressions and they are not
 * bugs to fix here — each names an unbuilt feature and the slice that owns building it. They
 * exist so the gap is a standing item in the test summary rather than a paragraph in a review
 * file nobody re-reads.
 *
 * The rule they enforce is recorded in `context/foundation/lessons.md`: no status value ships
 * without a demonstrated exit, and "unreachable by design" must name the mechanism that makes
 * it unreachable rather than being asserted.
 *
 * Evidence for all four: `context/changes/testing-derived-output-correctness/research.md`.
 */

/** What can write a value, and how a row leaves it. An empty `exits` is a dead end. */
interface Transition {
  readonly value: string;
  /** What puts a row into this state. `null` means nothing does — the value is unreachable. */
  readonly writer: string | null;
  /** States reachable from here. Empty means the row can never leave. */
  readonly exits: readonly string[];
}

/**
 * `tournaments.status`, as the database actually stands.
 *
 * The UPDATE policy on `tournaments` was dropped entirely in
 * `20260731174617_pairing_schema.sql`, so `start_tournament()` is the only writer of any
 * status, and there is no route out of `started` at all.
 */
const TOURNAMENT_TRANSITIONS: readonly Transition[] = [
  { value: "lobby", writer: "insert default", exits: ["started"] },
  { value: "started", writer: "start_tournament()", exits: [] },
  { value: "finished", writer: null, exits: [] },
];

/**
 * `matches.status`, as the database actually stands.
 *
 * `start_tournament()` writes every row as `pending` and nothing ever moves them. Three of the
 * four legal values have no writer.
 */
const MATCH_TRANSITIONS: readonly Transition[] = [
  { value: "pending", writer: "start_tournament()", exits: [] },
  { value: "in_progress", writer: null, exits: [] },
  { value: "finished", writer: null, exits: [] },
  { value: "abandoned", writer: null, exits: [] },
];

describe("transition table integrity", () => {
  // These are live tests, not todos: the table must stay in step with the vocabulary, or the
  // dead-end todos below would be describing states that no longer exist.
  it("covers every TOURNAMENT_STATUSES member exactly once", () => {
    expect(TOURNAMENT_TRANSITIONS.map((t) => t.value).sort()).toEqual([...TOURNAMENT_STATUSES].sort());
  });

  it("covers every MATCH_STATUSES member exactly once", () => {
    expect(MATCH_TRANSITIONS.map((t) => t.value).sort()).toEqual([...MATCH_STATUSES].sort());
  });

  it("only ever names states that exist in the vocabulary", () => {
    let checked = 0;

    for (const { value, exits } of TOURNAMENT_TRANSITIONS) {
      for (const exit of exits) {
        expect(TOURNAMENT_STATUSES as readonly string[], `${value} -> ${exit}`).toContain(exit);
        checked++;
      }
    }
    for (const { value, exits } of MATCH_TRANSITIONS) {
      for (const exit of exits) {
        expect(MATCH_STATUSES as readonly string[], `${value} -> ${exit}`).toContain(exit);
        checked++;
      }
    }

    // Every MATCH_TRANSITIONS entry currently has `exits: []`, so that second loop never runs
    // and this test would otherwise assert nothing about matches. Counting makes the coverage
    // visible: today it is 1 (lobby -> started), and when S-03 gives a match status an exit
    // this number rises rather than the test silently continuing to check nothing.
    expect(checked, "the transition table declares no exits at all — this test asserted nothing").toBeGreaterThan(0);
  });

  it("records the dead ends this file's todos are about", () => {
    // Pins the hand-maintained model itself, so an unexplained edit to the table above is
    // visible. This does NOT detect a dead end being fixed in SQL — that is the next test's
    // job, and the distinction matters: a table compared only to itself proves nothing about
    // the database.
    const tournamentDeadEnds = TOURNAMENT_TRANSITIONS.filter((t) => t.exits.length === 0).map((t) => t.value);
    const matchesWithoutWriter = MATCH_TRANSITIONS.filter((t) => t.writer === null).map((t) => t.value);

    expect(tournamentDeadEnds).toEqual(["started", "finished"]);
    expect(matchesWithoutWriter).toEqual(["in_progress", "finished", "abandoned"]);
  });

  it("stays in step with what the migrations actually write", () => {
    // The claim the previous test used to make falsely. Fixing a dead end means adding SQL —
    // an UPDATE policy, or a function writing `finished` — and that would leave the table
    // above describing a database that no longer exists, with its todos quietly obsolete.
    //
    // Scanning migration text is coarse (it cannot tell a live definition from a dropped one)
    // so this asserts only the direction that matters: if a status the model calls unwritten
    // acquires a writer, this fails and sends the reader to the matching todo.
    const sql = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(MIGRATIONS + name, "utf8"))
      .join("\n");

    for (const { value, writer } of [...TOURNAMENT_TRANSITIONS, ...MATCH_TRANSITIONS]) {
      if (writer !== null) continue;

      // `set status = 'x'` or `status = 'x'` inside an update — the only shapes that move a row
      // into a state in this schema. Not `status in (...)`, which is the CHECK constraint.
      const written = new RegExp(`set\\s+status\\s*=\\s*'${value}'`).test(sql);

      expect(
        written,
        `Nothing was supposed to write status '${value}', but a migration now does. ` +
          `The transition table in this file is stale, and its dead-end todo for '${value}' ` +
          `may already be resolved — update both.`,
      ).toBe(false);
    }
  });
});

describe("D1 — tournaments.status has no exit from `started`", () => {
  // Owner: S-04. research.md, "Risk #5's dead ends", D1.
  it.todo(
    "D1 (S-04): every reachable tournaments.status has at least one exit transition — " +
      "currently false: `started` has none and `finished` has no writer, so a started " +
      "tournament can never conclude, be deleted, or be left. The UPDATE policy was dropped " +
      "in 20260731174617_pairing_schema.sql and never replaced. [research.md D1]",
  );

  it.todo(
    "D1 (S-04): concluding a tournament goes through a SECURITY DEFINER function, since no " +
      "policy-layer route to `finished` exists or should exist [research.md D1]",
  );
});

describe("D2 — three of four match statuses have no writer", () => {
  // Owner: S-03. research.md, D2.
  it.todo(
    "D2 (S-03): every value in MATCH_STATUSES has a writer — currently false: only `pending` " +
      "does. start_tournament() writes every match as pending and nothing moves them, so a " +
      "match can never be in progress or finished. [research.md D2]",
  );

  it.todo(
    "D2 (S-03/deferred): `abandoned` stays unwritten until forfeit/timeout handling exists — " +
      "FR-004 defers it out of MVP, so this one is deliberately open, not overlooked [research.md D2]",
  );
});

describe("D3 — a match room authenticates without authorizing", () => {
  // Owner: S-03. research.md, D3.
  it.todo(
    "D3 (S-03): a match room may only be seated by a player named on that match — currently " +
      "false: src/worker.ts resolves the caller's identity with getUser() but never checks " +
      "that the id appears on the match whose id keys the room, so any signed-in user can " +
      "take a seat in any room whose UUID they know. [research.md D3]",
  );
});

describe("D4 — a room holds one round, a match is configured for up to 20", () => {
  // Owner: S-03. research.md, D4.
  it.todo(
    "D4 (S-03): a match plays rounds_per_match rounds — currently false: rounds_per_match " +
      "accepts 1-20 but a room structurally holds exactly one round, and its committed moves " +
      "are what make it terminal, so there is no second round to play. [research.md D4]",
  );

  it.todo(
    "D4 (S-03): the pacing model is a prerequisite — rounds-as-barriers or live matching, " +
      "per generate-round-robin-pairing F1. Any test of opponent mutuality must start from an " +
      "UNEVEN completion count; equal counts are the one state where mutuality holds trivially. " +
      "[research.md D4; generate-round-robin-pairing reviews/impl-review.md F1]",
  );
});
