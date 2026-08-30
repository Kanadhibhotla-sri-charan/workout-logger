# 2026-08-30 — Remediation §3: remove arbitrary exercise-selection scoring

## Why

A new "Strict Remediation Specification" document flagged that
`exerciseSelector.ts`'s ranking used arbitrary numeric weights
(primary +2, secondary +1, recent -1, current +0.5) that were never
agreed methodology, and explicitly forbids both keeping them and
replacing them with a different invented scoring system. It mandates
a strict ordered gate hierarchy instead — each gate narrows the
candidate set by category membership, never by a summed value.

## What changed

`src/engine/exerciseSelector.ts` (rewritten) — `selectExercise()` now
applies six gates in order, each implemented via one shared primitive
(`narrow`: filter to a predicate, but revert to the unfiltered set if
the filter would eliminate every candidate — so a gate can only ever
narrow, never eliminate, the field):

- **Gate 1** (feasibility) — not re-implemented; already happens
  upstream (`constraintEngine.filterEquipmentFeasible`,
  `.fitToTimeBudget`, `.isBodyFocusAllowedOnDay`), unchanged from
  before.
- **Gate 2** (goal relevance) — drop any candidate whose Blueprint
  muscle-role for this target is `'none'`; throws
  `NoFeasibleExerciseError` if that leaves nothing (a caller error,
  not a silent invention).
- **Gate 3** (programming need) — prefer primary-role over
  secondary-role candidates; then prefer a candidate not already
  claimed for a different target earlier in the same session
  (`exercises_already_planned_today`, a new optional input — avoids
  redundant coverage of the same movement pattern twice in one
  workout).
- **Gate 4** (historical context) — exclude a candidate recently used
  for this target, *except* the current/ongoing pick — mechanically
  cycling through recently-tried-and-abandoned options is what this
  screens for; continuing the established exercise is not
  "inappropriate repetition," it's what Gate 5 rewards next.
- **Gate 5** (progression continuity) — when the programming need is
  still tied, prefer the current exercise (the only candidate with
  usable prior performance history to progress from).
- **Gate 6** (stable tie-break) — alphabetical by exercise id
  (verified: Blueprint has no stored per-exercise ordering field to
  use instead).

The result now also carries `decisive_gate` (which gate actually
produced the final answer) and `rejected_candidates` (every candidate
that didn't win) — both machine-readable, feeding the remediation
spec's explainability requirement (§16) without parsing prose.

## Tests

All 8 pre-existing tests passed unchanged against the rewrite (the
gate hierarchy produces the same answers the old scoring did for those
cases — expected, since both were built from the same underlying
factors, just combined differently). 9 new tests in
`tests/engine/exerciseSelector.test.ts`: no numeric `score` field on
the result; Gate 2 throws for a genuinely irrelevant candidate list;
Gate 3 avoids an exercise already planned for another target today;
Gate 4 avoids a recent-but-not-current candidate in favor of a fresh
one; Gate 4 never penalizes the current exercise even when it's also
the most recent one; Gate 5 prefers the current exercise for
continuity when otherwise tied; Gate 6 is a stable alphabetical
tie-break; `rejected_candidates` lists every non-winner; `reasoning`
names the decisive gate explicitly.

## Verification (actually run)

```
$ npm run verify
tsc --noEmit: clean
vitest run: Test Files 35 passed (35), Tests 306 passed (306)
```

(297 tests before this batch; 306 after adding 9 to
`exerciseSelector.test.ts` — no regressions.)

## Still open (remediation spec, tracked separately)

This is one of ten "critical fix" items in the remediation spec. Real
exercise history, last-trained dates, and progression are still not
wired into `workoutBuilder`'s production path (they default to
empty/null there today); the normal-development/maintenance layer,
outside-Blueprint fallback wiring, badminton's actual programming
effect, and resourceAllocation wiring are also not yet done. Each is
tracked as its own task and will get its own commit.
