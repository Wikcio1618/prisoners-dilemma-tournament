import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  generateJoinCode,
  isJoinTournamentError,
  isStartTournamentError,
  JOIN_CODE_LENGTH,
  JOIN_CODE_PATTERN,
  JOIN_TOURNAMENT_ERRORS,
  START_TOURNAMENT_ERRORS,
} from "@/lib/tournament";

describe("generateJoinCode", () => {
  // Property-based rather than example-based: the function is random, so any single sample
  // proves nothing about the next one. What matters is that every possible output satisfies
  // the database constraint, and only a run over many samples can argue that.
  it("always produces a code the database will accept", () => {
    fc.assert(
      fc.property(fc.integer(), () => {
        const code = generateJoinCode();
        expect(code).toHaveLength(JOIN_CODE_LENGTH);
        expect(code).toMatch(JOIN_CODE_PATTERN);
      }),
      { numRuns: 500 },
    );
  });

  it("preserves leading zeros", () => {
    // The obvious implementation bug for a numeric join code: derive it from a number and
    // `004821` silently becomes `4821`, which the anchored CHECK then rejects at insert time.
    // Generating enough samples makes at least one leading zero overwhelmingly likely
    // (1 - 0.9^2000 for the first digit alone), so a regression here fails loudly rather than
    // flakily.
    const codes = Array.from({ length: 2000 }, () => generateJoinCode());
    const withLeadingZero = codes.filter((code) => code.startsWith("0"));

    expect(withLeadingZero.length).toBeGreaterThan(0);
    for (const code of withLeadingZero) {
      expect(code).toHaveLength(JOIN_CODE_LENGTH);
    }
  });

  it("varies in every digit position", () => {
    // A sanity check on the generator, not a statistical test: a position that never changes
    // across 2000 samples is a stuck index, not bad luck.
    const codes = Array.from({ length: 2000 }, () => generateJoinCode());

    for (let position = 0; position < JOIN_CODE_LENGTH; position++) {
      const distinct = new Set(codes.map((code) => code[position]));
      expect(distinct.size).toBeGreaterThan(1);
    }
  });
});

describe("isJoinTournamentError", () => {
  it.each(Object.values(JOIN_TOURNAMENT_ERRORS))("accepts its own token %s", (token) => {
    expect(isJoinTournamentError(token)).toBe(true);
  });

  it.each(
    Object.values(START_TOURNAMENT_ERRORS).filter((t) => !Object.values(JOIN_TOURNAMENT_ERRORS).includes(t as never)),
  )("rejects the start-only token %s", (token) => {
    // The two vocabularies overlap deliberately (not_authenticated, tournament_not_found).
    // Only the tokens unique to start should be refused here.
    expect(isJoinTournamentError(token)).toBe(false);
  });

  it.each([["unknown_token"], [""], [null], [undefined], [42], [{}], [["not_authenticated"]]])(
    "rejects the non-token %s",
    (value) => {
      expect(isJoinTournamentError(value)).toBe(false);
    },
  );
});

describe("isStartTournamentError", () => {
  it.each(Object.values(START_TOURNAMENT_ERRORS))("accepts its own token %s", (token) => {
    expect(isStartTournamentError(token)).toBe(true);
  });

  it.each(
    Object.values(JOIN_TOURNAMENT_ERRORS).filter((t) => !Object.values(START_TOURNAMENT_ERRORS).includes(t as never)),
  )("rejects the join-only token %s", (token) => {
    expect(isStartTournamentError(token)).toBe(false);
  });

  it.each([["unknown_token"], [""], [null], [undefined], [42], [{}]])("rejects the non-token %s", (value) => {
    expect(isStartTournamentError(value)).toBe(false);
  });
});
