# 2026-08-30 — Frequency engine + the Monday-never-lower-body hard rule

## Why

`frequencyEngine.ts` previously threw `NotApprovedError`. Spec §16
gives a default weekly schedule (already in `config.ts` as
`DEFAULT_WEEKLY_SCHEDULE`) and one hard rule — "Monday must never be
generated as a lower-body day" — but that rule had never actually been
implemented; `constraintEngine.ts`'s own doc comments pointed at a
`isBodyFocusAllowedOnDay` function that didn't exist yet, and
`FORBIDDEN_BODY_FOCUS_BY_DAY` held placeholder labels (`['lower',
'legs']`) that don't match any real Blueprint field.

## What changed

- `src/engine/config.ts` — new `LOWER_BODY_PHYSIQUE_REGIONS =
  ['quads', 'hamstrings', 'calves', 'hips']`: Blueprint's own
  `physique_target.parent_region` values (verified against the
  snapshot), exhaustively grouped into "lower body" for this one rule.
  `core`, `forearms`, `neck` deliberately excluded (neither clearly
  upper nor lower). `FORBIDDEN_BODY_FOCUS_BY_DAY.monday` now points at
  this real list instead of the old placeholder strings.
- `src/engine/constraintEngine.ts` — new
  `isBodyFocusAllowedOnDay(physiqueTargetId, day)`: resolves the target
  to its Blueprint `parent_region` and checks it against
  `FORBIDDEN_BODY_FOCUS_BY_DAY[day]`. Permissive (`true`) for an
  unresolvable id — this function gates known lower-body regions, it
  doesn't validate ids.
- `src/engine/frequencyEngine.ts` (rewritten, real implementation) —
  `allocateFrequency()`: session count comes from Blueprint's own
  `globalPrinciples.frequency.typical_starting_range_per_week`, clamped
  to actual day availability and to the desired weekly volume (never
  more sessions than there's meaningful volume to spread, never more
  than Blueprint's own range, never more than available days).
  Sessions are spread evenly across the available days (an app-level
  spacing choice — Blueprint's text distinguishes "can be trained" from
  "useful to distribute volume" but doesn't prescribe exact spacing).
  For a `physique_target`, any day landing on Monday that fails
  `isBodyFocusAllowedOnDay` is swapped for the next available
  compliant day rather than silently kept or dropped.
- `tests/engine/unapprovedStubs.test.ts` — dropped `frequencyEngine`'s
  now-false "throws NotApprovedError" case.

## Tests

`tests/engine/constraintEngine.test.ts` (+8 tests): every real
Blueprint lower-body physique target (quads, hamstrings, gastrocnemius,
gluteus-maximus, ...) is forbidden on Monday; an upper-body target
(chest) is allowed; the rule is Monday-specific (allowed every other
day); an unresolvable id is permissive rather than erroring.

`tests/engine/frequencyEngine.test.ts` (10 tests): session count
respects Blueprint's range and available-day count; never assigns a
day outside the caller's available list; zero desired exposure or zero
available days → zero sessions; **required test 12**: a lower-body
target is never assigned Monday when an alternative day exists; the
Monday rule doesn't apply to upper-body or functional-goal targets;
sessions spread rather than cluster when more days are available than
needed; reasoning cites the actual Blueprint range used.

## Verification (actually run)

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  31 passed (31)
      Tests  243 passed (243)
```

(226 tests before this batch; 243 after adding 8 to
`constraintEngine.test.ts` and 10 in the new
`frequencyEngine.test.ts`, minus 1 removed from
`unapprovedStubs.test.ts` — no regressions.)

## Still open

`exerciseSelector` and `workoutBuilder` are the last two stubs.
`exerciseSelector` (§5) is next — it can now lean on
`constraintEngine.isBodyFocusAllowedOnDay` and the exposure/volume/
recovery/frequency engines already built for its ranking signals.
