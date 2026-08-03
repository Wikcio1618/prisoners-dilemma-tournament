import { describe, expect, it } from "vitest";

import { MAX_FRAME_BYTES, MOVES, parse } from "@/durable/match-message";

/**
 * The parser is the only input-validation boundary on the WebSocket, and S-03 has to touch it
 * to add socket verification. Pinning the accept/reject contract first is the point of this
 * file: after S-03, a frame that used to be rejected must still be rejected, and the fields
 * that survive parsing must be the same ones.
 *
 * Rejection is always `null`, never a throw — a malformed frame from one socket must not be
 * able to abort the round for the other player.
 */
describe("parse", () => {
  describe("accepts", () => {
    it.each(MOVES)("a well-formed commit frame for move %s", (move) => {
      expect(parse(JSON.stringify({ type: "commit", move }))).toEqual({ type: "commit", move });
    });

    it("ignores unknown extra fields rather than rejecting the frame", () => {
      expect(parse(JSON.stringify({ type: "commit", move: "cooperate", nonsense: 1 }))).toEqual({
        type: "commit",
        move: "cooperate",
      });
    });
  });

  describe("passes playerId through", () => {
    // The dev harness at /dev/match-room sends this field. Production identity comes from
    // PLAYER_ID_HEADER, set by src/worker.ts after getUser() — the room never trusts the
    // message for identity. The passthrough is pinned so S-03 cannot drop it unnoticed while
    // adding verification.
    it("keeps a string playerId", () => {
      expect(parse(JSON.stringify({ type: "commit", move: "sabotage", playerId: "user-1" }))).toEqual({
        type: "commit",
        move: "sabotage",
        playerId: "user-1",
      });
    });

    it("omits the key entirely when playerId is absent", () => {
      const result = parse(JSON.stringify({ type: "commit", move: "cooperate" }));
      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty("playerId");
    });

    it.each([[42], [null], [{ id: "x" }], [["user-1"]], [true]])(
      "drops a non-string playerId (%s) instead of forwarding it",
      (playerId) => {
        const result = parse(JSON.stringify({ type: "commit", move: "cooperate", playerId }));
        expect(result).toEqual({ type: "commit", move: "cooperate" });
        expect(result).not.toHaveProperty("playerId");
      },
    );
  });

  describe("rejects", () => {
    it.each([
      ["malformed JSON", "{not json"],
      ["an empty string", ""],
      ["a bare string", '"commit"'],
      ["a number", "42"],
      ["null", "null"],
      ["an array", '[{"type":"commit","move":"cooperate"}]'],
    ])("%s", (_label, raw) => {
      expect(parse(raw)).toBeNull();
    });

    it.each([
      ["an unknown type", { type: "surrender", move: "cooperate" }],
      ["a missing type", { move: "cooperate" }],
      ["a missing move", { type: "commit" }],
      ["a move outside MOVES", { type: "commit", move: "defect" }],
      ["a null move", { type: "commit", move: null }],
      ["a numeric move", { type: "commit", move: 1 }],
      ["a case-mismatched move", { type: "commit", move: "Cooperate" }],
      ["a case-mismatched type", { type: "Commit", move: "cooperate" }],
    ])("%s", (_label, payload) => {
      expect(parse(JSON.stringify(payload))).toBeNull();
    });

    it("a frame larger than MAX_FRAME_BYTES, before attempting to parse it", () => {
      // Valid JSON, valid shape — rejected purely on length, which is what makes this a
      // work bound on an unauthenticated caller rather than a validation rule.
      const padded = JSON.stringify({ type: "commit", move: "cooperate", pad: "x".repeat(MAX_FRAME_BYTES) });
      expect(padded.length).toBeGreaterThan(MAX_FRAME_BYTES);
      expect(parse(padded)).toBeNull();
    });

    it("accepts a frame exactly at the limit, so the bound is not off by one", () => {
      const base = JSON.stringify({ type: "commit", move: "cooperate", pad: "" });
      const padded = JSON.stringify({
        type: "commit",
        move: "cooperate",
        pad: "x".repeat(MAX_FRAME_BYTES - base.length),
      });
      expect(padded.length).toBe(MAX_FRAME_BYTES);
      expect(parse(padded)).toEqual({ type: "commit", move: "cooperate" });
    });
  });
});
