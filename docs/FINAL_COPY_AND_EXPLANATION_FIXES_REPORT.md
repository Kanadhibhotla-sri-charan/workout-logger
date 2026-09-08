# Final Fixes — Copy Performed Variations + Explanation Accuracy: Implementation Report

Corresponds to `docs/FINAL_COPY_AND_EXPLANATION_FIXES_SPEC.md`. This is a correction pass on the
already-implemented, not-yet-merged Workout Programmer UI Fix (equipment filtering removal,
session notes, Copy button, friendly explanations) — no feature was rewritten from scratch, only
the specific issues below.

## Copy Fix

**Exact cause of the persisted-substitution problem.** `logger.html`'s `exerciseDisplayName(perf,
generatedMatch)` used to be:

```js
return generatedMatch ? generatedMatch.exercise_name : perf.exercise_id;
```

`generatedMatch` is found via `generated.exercises.find(g => g.exercise_id === perf.exercise_id)`.
When a user substitutes an exercise during a session, the performed row is persisted under the
substitute's own `exercise_id` (e.g. `cable-hammer-curl-rope`), but the generated program still
only lists the originally prescribed exercise (e.g. `hammer-curl`) — the spec is explicit that the
program must keep representing the prescription, not the substitute. So `generatedMatch` is
`null`, and the old code fell back to the **raw internal id string** (`cable-hammer-curl-rope`)
instead of a human-readable name. This is a real persisted-state problem, not just a fresh-load
timing issue: the app's `ExercisePerformance` row (`src/contracts/types.ts`) has no name/variation
field at all — only `exercise_id` — so there was never an authoritative persisted name to prefer
over `generatedMatch`.

**How performed exercise identity is now resolved.** `logger.html` now fetches both of the app's
already-existing, persisted exercise catalogs once per page load — `GET /api/blueprint/exercises`
and `GET /api/outside-blueprint-exercises` — into a module-level `id -> name` map
(`exerciseNamesById`, built by `loadExerciseNames()`, called from `load()` for gym sessions).
`exerciseDisplayName` now resolves:

```js
function exerciseDisplayName(perf, generatedMatch) {
  return exerciseNamesById.get(perf.exercise_id) ?? generatedMatch?.exercise_name ?? perf.exercise_id;
}
```

i.e. persisted catalog first, generated program only as a fallback, raw id only as a last resort.
Both catalogs are real, already-existing, ID-keyed endpoints — no schema change, no new API, no
dependency on the transient in-memory `substitutions` Map. This resolves correctly after reload,
reopening the workout, navigating away and back, or an app restart, because it depends only on
data that is actually persisted server-side.

**Example of copied output** (real substitution scenario, verified live against a running server —
see Tests below):

```
Workout — Tuesday, Sep 8

Cable Hammer Curl (Rope) — 1 set: 15×12

Session note: Used rope attachment for hammer curls.
```

The generated program for that day still lists only the originally prescribed `Hammer Curl` — it
was never mutated to include the substitute.

## Tests

**Persisted substitution regression test** (`tests/frontend/copyWorkoutText.test.ts`, describe
block "Final Copy/Explanation Fixes §1/§2: real persisted-substitution regression"): two tests
model the exact real situation the spec requires — `generated.exercises` contains ONLY the
originally-prescribed exercise (`cable-pushdown`), the performed session is logged under the
substitute's own id (`cable-pushdown-rope`), and no substitution map is passed at all. The
human-readable name is asserted to come from a `namesById` fixture (simulating the real persisted
catalog fetch), not from `generated`. One variant additionally passes `generated: null` entirely,
covering the "reopened after reload/app restart" case explicitly. Verified as a real, non-vacuous
regression test: reverting `logger.html`'s fix via `git stash` and re-running caused both tests to
fail (showing the raw id `cable-pushdown-rope` in the output instead of `Cable Pushdown (Rope)`);
restoring the fix made them pass again.

**Session-note copy test**: pre-existing test "includes the session note exactly once when
present, and omits the section entirely when absent" in the same file, unchanged and still
passing — confirms inclusion when a note exists and omission (no `Session note:` line) when it
doesn't.

**Explanation tests** (`tests/friendlyExplanation.test.ts`): all pre-existing goal/normal-
development/secondary-support/jargon-absence tests are unchanged and still pass. Added
`describe('resolveGoalNameRef — ...')` with 4 new tests covering: a functional goal resolves to
Blueprint's real title ("Rotator Cuff", not a humanized slug); an aesthetic outcome falls back to
its raw `blueprint_ref` slug (humanized downstream), since aesthetic outcomes have no equivalent
title field; an unrecognized functional-goal id falls back to its raw ref; and an end-to-end check
that `buildFriendlyPlannedReasoning` produces "Added for your Rotator Cuff goal." (proper title
case) rather than "your rotator cuff goal." for a functional-goal-linked exercise. Verified as real
regression tests the same way: reverting `programming.ts`/`friendlyExplanation.ts` via `git stash`
caused all 4 new tests to fail (`resolveGoalNameRef is not a function` before the export existed);
restoring the fix made them pass, with the 15 pre-existing tests in the file unaffected throughout.

**Full test results** (`npm run verify` = `npm run build && npm run typecheck && npm test`, run
for real on 2026-09-08):

```
Typecheck: PASS
Tests: 756 passed / 0 failed / 0 skipped (79 test files)
Build: PASS
Verify: PASS
```

This includes `tests/engine/blueprintCandidateGating.test.ts` (5/5 — rear-delt package-gating
regression and generic package-membership regression both still passing unmodified) and
`tests/engine/workoutBuilder.test.ts` (29/29, the goal-linked stability recalibration suite),
confirming spec §10's "existing regression coverage" checklist item.

**Focused live test of the persisted substitution copy case**: started a real server instance
against a throwaway scratch SQLite database (never the production DB), then, over real HTTP:
created a gym workout session, logged a performed exercise under `cable-hammer-curl-rope` (a real
Blueprint id distinct from any originally-prescribed exercise) with a session note, marked the
session completed, and fetched it back. Confirmed directly from the real persisted row: the
`ExercisePerformance` genuinely carries only `exercise_id: "cable-hammer-curl-rope"` — no name
field of any kind — proving the fix's assumption about the persisted shape is accurate. Also
confirmed `GET /api/blueprint/exercises` genuinely resolves that id to `"Cable Hammer Curl
(Rope)"`. Combined with the unit tests above (which execute the actual shipped
`buildCopyText`/`exerciseDisplayName` source, extracted from `logger.html` itself, not a
reimplementation), this confirms the fix end-to-end against real data. The scratch database and
server process were both torn down afterward; no production data was touched.

## Explanation Fix

**Weekly exposure semantics — confirmed.** Traced `decision.weekly_exposure.primary_sets` through
`workoutBuilder.ts` → `trainingState.ts`'s `buildTrainingState` (built from
`workoutSessionsRepo.getExercisePerformances`, i.e. real logged sessions) → `exposureEngine.ts`'s
`calculateExerciseExposure`, which explicitly excludes any set not marked `completed: true` (rule
D), with existing regression coverage in `tests/engine/exposureEngine.test.ts`. This is genuine
**actual/completed** training exposure, never planned-only volume — a merely-planned,
not-yet-logged session contributes zero. Per the spec's own instruction, no wording change was
needed; "You had X sets... so far this week" remains accurate. Documented via a code comment in
`friendlyExplanation.ts` rather than silently assumed.

**Human-readable goal naming — confirmed and improved.** Inspected both Blueprint goal-type
catalogs directly against real data in `src/blueprint/snapshot/programming.json`:
`BlueprintAestheticOutcome.display_name` is uniformly a first-person problem statement (e.g. "Arms
look thin from the side"), never a title — unsuitable for "Added for your {X} goal" phrasing, so
the existing `humanizeSlug(blueprint_ref)` fallback remains correct for aesthetic goals, exactly as
the spec allows ("if only a target slug exists, the current humanization fallback is acceptable").
`BlueprintFunctionalGoal.name`, however, genuinely is a clean title (e.g. "Rotator Cuff",
"Scapular Stability") — a real human-readable representation the previous implementation wasn't
using. `programming.ts` now resolves each Goal's best available name via a new
`resolveGoalNameRef()` helper: functional goals use Blueprint's real `name` field; aesthetic goals
still pass through their raw `blueprint_ref` slug for `humanizeSlug` to handle, unchanged.

**Before/after examples:**

1. Functional goal (e.g. a "rotator-cuff" Goal), specialization-classified work — **before**:
   "Added for your rotator cuff goal." (humanized slug, all lowercase) — **after**: "Added for your
   Rotator Cuff goal." (Blueprint's real title, correct case).
2. Aesthetic goal (e.g. "arm-side-thickness") — **unchanged** in both cases: "Added for your arm
   side thickness goal." — no better title exists in Blueprint's data for aesthetic outcomes, so
   the humanization fallback correctly stands per spec §7.
3. Weekly exposure wording — **unchanged** in both cases: "You had 4 sets for this target so far
   this week, so this session adds another 2 sets." — confirmed accurate (actual/completed
   exposure), not "planned," so no wording change was applicable here.

## Equipment

- **Program-generation equipment filtering remains removed.** No changes were made in this pass to
  `workoutBuilder.ts`, `exerciseSelector.ts`, or the candidate-gathering path; the prior session's
  removal of equipment filtering from initial generation (Blueprint Candidate Fix /
  `tests/engine/blueprintCandidateGating.test.ts`) is untouched and its regression tests still pass
  (5/5).
- **Substitution equipment filtering remains available.** `constraintEngine.ts`'s
  `filterEquipmentFeasible` (used for substitutions/display, per the architecture spec §8
  describes) was not modified; `tests/engine/constraintEngine.test.ts` (23/23) and the
  `equipmentConstrained` fixture test (3/3) still pass unmodified.

## Safety

- No database reset, recreation, or destructive migration — no schema migration of any kind was
  needed for this pass (both catalog endpoints the Copy fix uses already existed).
- No historical workout data was altered — the only new server-side logic reads existing catalogs;
  the live smoke test used a disposable scratch SQLite file created and destroyed in `/tmp`, never
  the real database.
- No goal was modified — `resolveGoalNameRef` only reads `Goal.blueprint_ref`/`goal_type` and
  Blueprint's own static catalog; it writes nothing.
- No Blueprint package contents were modified — Blueprint's snapshot data was only read for
  inspection (`programming.json` dumps) and via the existing `BlueprintAdapter`.
- No AI/LLM dependency was introduced.
- No systemd/nginx configuration was touched.
- This work was implemented and verified locally only; nothing was deployed.
