import { describe, expect, it } from "vitest";

import { createTournamentSchema, joinTournamentSchema, signUpProfileSchema } from "@/lib/schemas";
import { MAX_DISPLAY_NAME_LENGTH, MAX_ROUNDS_PER_MATCH, MIN_ROUNDS_PER_MATCH } from "@/lib/tournament";

/**
 * These are the highest-value pure unit tests in the repository.
 *
 * `createTournamentSchema` is the ONLY enforcement of the 1-20 `rounds_per_match` bound
 * anywhere in the system — the database deliberately carries no CHECK for that column
 * (`supabase/migrations/20260729164628_tournament_tables.sql`). If this schema stops rejecting
 * out-of-range input, nothing else will, and a tournament configured for two billion rounds
 * inserts cleanly.
 *
 * Every case below is a boundary or a type-coercion edge, because those are where a schema
 * silently widens.
 */
describe("createTournamentSchema", () => {
  const parse = (rounds_per_match: unknown) => createTournamentSchema.safeParse({ rounds_per_match });

  it.each([
    [MIN_ROUNDS_PER_MATCH, "the minimum"],
    [MAX_ROUNDS_PER_MATCH, "the maximum"],
    [10, "a mid-range value"],
  ])("accepts %s (%s)", (value) => {
    expect(parse(value).success).toBe(true);
  });

  it("accepts the string form the HTML form actually submits", () => {
    // Form values arrive as strings; the schema coerces. This is the real production input
    // shape, so testing only numbers would miss the path that is actually taken.
    const result = parse("10");
    expect(result.success).toBe(true);
    expect(result.success && result.data.rounds_per_match).toBe(10);
  });

  it.each([
    [MIN_ROUNDS_PER_MATCH - 1, "one below the minimum"],
    [MAX_ROUNDS_PER_MATCH + 1, "one above the maximum"],
    [-1, "a negative value"],
    [2_000_000_000, "an absurd value the database would otherwise accept"],
  ])("rejects %s (%s)", (value) => {
    expect(parse(value).success).toBe(false);
  });

  it.each([
    [10.5, "a fractional value that must not be truncated to 10"],
    ["10.5", "the fractional value as a string"],
  ])("rejects %s (%s)", (value) => {
    expect(parse(value).success).toBe(false);
  });

  it.each([
    ["", "an empty string"],
    ["abc", "non-numeric text"],
    [null, "null"],
    [undefined, "undefined"],
    [{}, "an object"],
    [[], "an array"],
    [NaN, "NaN"],
    [Infinity, "Infinity"],
  ])("rejects %s (%s)", (value) => {
    expect(parse(value).success).toBe(false);
  });
});

describe("joinTournamentSchema", () => {
  const parse = (join_code: unknown) => joinTournamentSchema.safeParse({ join_code });

  it("accepts a six-digit code", () => {
    expect(parse("123456").success).toBe(true);
  });

  it("accepts a code with leading zeros", () => {
    // Codes are strings precisely so `004821` survives. If this ever fails, the generator and
    // the validator have diverged and roughly a tenth of all codes become unusable.
    const result = parse("004821");
    expect(result.success).toBe(true);
    expect(result.success && result.data.join_code).toBe("004821");
  });

  it.each([
    ["  123456  ", "surrounding spaces"],
    ["\t123456\n", "a tab and a newline"],
  ])("trims %s (%s) before validating", (value) => {
    // Codes get copied out of chat messages with stray whitespace, and the database pattern is
    // anchored — an untrimmed value would fail as "tournament not found", which reads to the
    // player as a wrong code rather than a formatting problem.
    const result = parse(value);
    expect(result.success).toBe(true);
    expect(result.success && result.data.join_code).toBe("123456");
  });

  it.each([
    ["12345", "five digits"],
    ["1234567", "seven digits"],
    ["", "an empty string"],
    ["12345a", "a trailing letter"],
    ["abcdef", "letters only"],
    ["12 456", "an interior space"],
    ["12-456", "a hyphen"],
    ["123456\n789012", "an embedded newline between two valid codes"],
    ["１２３４５６", "full-width digits"],
  ])("rejects %s (%s)", (value) => {
    expect(parse(value).success).toBe(false);
  });

  it.each([[123456], [null], [undefined], [{}]])("rejects the non-string %s", (value) => {
    expect(parse(value).success).toBe(false);
  });
});

describe("signUpProfileSchema", () => {
  const parse = (display_name: unknown) => signUpProfileSchema.safeParse({ display_name });

  it.each([
    ["a", "one character"],
    ["Ala Nowak", "an ordinary name"],
    ["Żółć Ćma", "Polish diacritics"],
  ])("accepts %s (%s)", (value) => {
    expect(parse(value).success).toBe(true);
  });

  it("accepts exactly the maximum length", () => {
    expect(parse("x".repeat(MAX_DISPLAY_NAME_LENGTH)).success).toBe(true);
  });

  it("rejects one character over the maximum", () => {
    // The database CHECK and the trigger clamp both sit at this bound. A schema that let a
    // longer value through would push the failure into the auth.users insert, where it
    // surfaces as an opaque "Database error saving new user".
    expect(parse("x".repeat(MAX_DISPLAY_NAME_LENGTH + 1)).success).toBe(false);
  });

  it.each([
    ["", "an empty string"],
    ["   ", "whitespace only"],
    ["\t\n", "tabs and newlines only"],
  ])("rejects %s (%s)", (value) => {
    expect(parse(value).success).toBe(false);
  });

  it("trims before measuring, so padding cannot smuggle length", () => {
    const padded = `  ${"x".repeat(MAX_DISPLAY_NAME_LENGTH)}  `;
    const result = parse(padded);
    expect(result.success).toBe(true);
    expect(result.success && result.data.display_name).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
  });

  it.each([[42], [null], [undefined], [{}]])("rejects the non-string %s", (value) => {
    expect(parse(value).success).toBe(false);
  });
});
