---
change_id: testing-derived-output-correctness
title: Runner bootstrap and derived-output correctness (test-plan Phase 1)
status: implementing
created: 2026-08-01
updated: 2026-08-03
archived_at: null
---

## Notes

Rollout Phase 1 of `context/foundation/test-plan.md`: "Runner bootstrap and derived-output correctness".

Risks covered: #1 (scores or behavioral statistics silently miscalculated; players debrief on wrong numbers), #5 (a tournament reaches a state it cannot leave).
Test types planned: unit, property-based.

Risk response intent:
- Risk #1: prove that a known move sequence produces exactly the score and behavioral classification the PRD's definitions demand. Must challenge the assumption that a statistic "looks reasonable" — reasonable and correct diverge silently here and no player will notice. The single most dangerous anti-pattern is the oracle problem: an expected value lifted from the statistics implementation makes the test tautological. The oracle must be derived independently from the PRD's Business Logic and FR-008.
- Risk #5: prove that every state the machine can enter has a route out, and that idempotent operations stay idempotent under retry. Must challenge "that state is unreachable by design" — three separate implementation reviews found reachable dead ends.

Hard constraint on sequencing: this phase must land BEFORE S-04 (tournament-results-and-stats) is implemented. Statistics written before their tests will supply the oracle to their own tests, which is precisely the failure Risk #1 exists to prevent.

Note the project currently has no test runner and no test files at all.
