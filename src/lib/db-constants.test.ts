import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  JOIN_CODE_PATTERN,
  JOIN_TOURNAMENT_ERRORS,
  MATCH_STATUSES,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PLAYERS_PER_TOURNAMENT,
  START_TOURNAMENT_ERRORS,
  TOURNAMENT_STATUSES,
} from "@/lib/tournament";

/**
 * Drift tests: every constant duplicated between SQL and TypeScript, asserted against the
 * migration text itself.
 *
 * This repo has shipped the same defect class twice — a comment pointing at a superseded
 * migration (tournament-data-model F3) and a bound restated as a literal in three places
 * (generate-round-robin-pairing F6). Both were caught by human review, which is not a
 * mechanism. These tests are the mechanism: they need no database, run in milliseconds, and
 * fail with a message naming both sides and the file, so the failure explains itself.
 *
 * The migration files are read as text fixtures rather than parsed as SQL. That is the point —
 * a real parser would be a second implementation to maintain, while a regex over a literal is
 * exactly as strong as the claim being made ("these two numbers agree").
 *
 * When a migration supersedes one of these, update the path here deliberately. A test that
 * silently reads a stale file is the very failure it exists to prevent.
 */

const MIGRATIONS = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));

function migration(name: string): string {
  try {
    return readFileSync(MIGRATIONS + name, "utf8");
  } catch {
    throw new Error(
      `Migration ${name} could not be read. If it was renamed or superseded, update the path in ` +
        `src/lib/db-constants.test.ts deliberately — this test is only as good as the file it reads.`,
    );
  }
}

/** Extracts one capture group, failing with the file name rather than "null is not an object". */
function extract(file: string, pattern: RegExp, what: string): string {
  const source = migration(file);
  const match = pattern.exec(source);
  if (!match?.[1]) {
    throw new Error(`Could not find ${what} in ${file} using ${pattern.source}. The migration's shape changed.`);
  }
  return match[1];
}

describe("player cap", () => {
  const FILE = "20260729192744_join_tournament_membership_shortcircuit.sql";

  it(`matches MAX_PLAYERS_PER_TOURNAMENT (${MAX_PLAYERS_PER_TOURNAMENT})`, () => {
    const sqlValue = Number(extract(FILE, /v_player_count\s*>=\s*(\d+)/, "the player-cap comparison"));

    expect(
      sqlValue,
      `join_tournament() caps at ${sqlValue} but MAX_PLAYERS_PER_TOURNAMENT is ` +
        `${MAX_PLAYERS_PER_TOURNAMENT}. Both must change together — see ${FILE}.`,
    ).toBe(MAX_PLAYERS_PER_TOURNAMENT);
  });
});

describe("display-name bound", () => {
  const CHECK_FILE = "20260731181103_player_profiles.sql";
  const CLAMP_FILE = "20260801170309_profile_trigger_hardening.sql";

  it(`the CHECK constraint matches MAX_DISPLAY_NAME_LENGTH (${MAX_DISPLAY_NAME_LENGTH})`, () => {
    const sqlValue = Number(
      extract(CHECK_FILE, /char_length\(display_name\)\s*between\s*1\s*and\s*(\d+)/, "the display-name CHECK"),
    );

    expect(
      sqlValue,
      `profiles_display_name_length allows ${sqlValue} but MAX_DISPLAY_NAME_LENGTH is ` +
        `${MAX_DISPLAY_NAME_LENGTH}. See ${CHECK_FILE}.`,
    ).toBe(MAX_DISPLAY_NAME_LENGTH);
  });

  it(`the trigger clamp matches MAX_DISPLAY_NAME_LENGTH (${MAX_DISPLAY_NAME_LENGTH})`, () => {
    // Three-way duplication: the CHECK, this clamp, and the TypeScript constant. If the clamp
    // ever exceeds the CHECK, handle_new_user() starts failing signups again — the exact bug
    // the hardening migration was written to fix.
    const sqlValue = Number(
      extract(
        CLAMP_FILE,
        /left\(trim\(new\.raw_user_meta_data\s*->>\s*'display_name'\),\s*(\d+)\)/,
        "the trigger clamp",
      ),
    );

    expect(
      sqlValue,
      `handle_new_user() clamps to ${sqlValue} but MAX_DISPLAY_NAME_LENGTH is ` +
        `${MAX_DISPLAY_NAME_LENGTH}. See ${CLAMP_FILE}.`,
    ).toBe(MAX_DISPLAY_NAME_LENGTH);
  });
});

describe("join-code format", () => {
  const FILE = "20260730203114_join_code_six_digits.sql";

  it("matches JOIN_CODE_PATTERN", () => {
    const sqlPattern = extract(FILE, /check\s*\(join_code\s*~\s*'([^']+)'\)/, "the join-code CHECK");

    expect(
      sqlPattern,
      `tournaments_join_code_format enforces /${sqlPattern}/ but JOIN_CODE_PATTERN is ` +
        `${JOIN_CODE_PATTERN.source}. See ${FILE}.`,
    ).toBe(JOIN_CODE_PATTERN.source);
  });
});

describe("status vocabularies", () => {
  const MATCH_FILE = "20260731174617_pairing_schema.sql";
  const TOURNAMENT_FILE = "20260729164628_tournament_tables.sql";

  it("matches_status_check lists exactly MATCH_STATUSES", () => {
    const list = extract(MATCH_FILE, /check\s*\(status\s+in\s*\(([^)]+)\)\)/, "the match status CHECK");
    const sqlValues = list.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));

    expect(
      sqlValues,
      `matches_status_check allows [${sqlValues.join(", ")}] but MATCH_STATUSES is ` +
        `[${MATCH_STATUSES.join(", ")}]. See ${MATCH_FILE}.`,
    ).toEqual([...MATCH_STATUSES]);
  });

  it("the tournament_status enum lists exactly TOURNAMENT_STATUSES", () => {
    const list = extract(
      TOURNAMENT_FILE,
      /create type public\.tournament_status as enum \(([^)]+)\)/,
      "the tournament_status enum",
    );
    const sqlValues = list.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));

    expect(
      sqlValues,
      `tournament_status is [${sqlValues.join(", ")}] but TOURNAMENT_STATUSES is ` +
        `[${TOURNAMENT_STATUSES.join(", ")}]. See ${TOURNAMENT_FILE}.`,
    ).toEqual([...TOURNAMENT_STATUSES]);
  });
});

describe("error tokens", () => {
  /** Every `detail = 'token'` raised anywhere in a migration file. */
  function detailTokens(file: string): Set<string> {
    return new Set(Array.from(migration(file).matchAll(/detail\s*=\s*'([a-z_]+)'/g), (m) => m[1]));
  }

  it("join_tournament raises exactly the JOIN_TOURNAMENT_ERRORS tokens", () => {
    const FILE = "20260729192744_join_tournament_membership_shortcircuit.sql";
    const sqlTokens = detailTokens(FILE);
    const tsTokens = new Set<string>(Object.values(JOIN_TOURNAMENT_ERRORS));

    expect(
      [...sqlTokens].sort(),
      `join_tournament() raises [${[...sqlTokens].sort().join(", ")}] but JOIN_TOURNAMENT_ERRORS is ` +
        `[${[...tsTokens].sort().join(", ")}]. A token the client cannot recognise falls through to ` +
        `the generic message. See ${FILE}.`,
    ).toEqual([...tsTokens].sort());
  });

  it("start_tournament raises exactly the START_TOURNAMENT_ERRORS tokens", () => {
    // The live definition is the most recent migration replacing the function — the set-based
    // rewrite, not the original pairing schema.
    const FILE = "20260801170219_pairing_set_based.sql";
    const sqlTokens = detailTokens(FILE);
    const tsTokens = new Set<string>(Object.values(START_TOURNAMENT_ERRORS));

    expect(
      [...sqlTokens].sort(),
      `start_tournament() raises [${[...sqlTokens].sort().join(", ")}] but START_TOURNAMENT_ERRORS is ` +
        `[${[...tsTokens].sort().join(", ")}]. See ${FILE}.`,
    ).toEqual([...tsTokens].sort());
  });
});
