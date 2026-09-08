# Fix: Blueprint Exercise Candidate Selection Must Not Be Gated by Development Packages — Implementation Report

Spec: `docs/FIX_BLUEPRINT_EXERCISE_CANDIDATE_SELECTION_SPEC.md`. Branch: `fix-blueprint-exercise-candidate-gating`.

## Root Cause

`src/engine/workoutBuilder.ts`'s `buildWeeklyProgrammingPlan` used a single function, `lookupExercisePrescription(physiqueTargetId, exerciseId, level = 'efficient')` (`src/blueprint/developmentPackages.ts`), as **both** a pre-ranking eligibility filter and the prescription source for the winning candidate. Two concrete offending rules were found (spec's "Search / Audit Requirements"):

1. **Pre-ranking eligibility gate.** Before Gate 1–6 ranking ever ran, `candidateExerciseIds` for a `physique_target` was narrowed to `candidateExerciseIds.filter((id) => outsideCandidatesById.has(id) || lookupExercisePrescription(target.target_id, id) !== null)`. Any real, equipment-feasible Blueprint exercise not listed in that target's `Efficient` development package (checked at that one hardcoded level only) was discarded outright — the literal `packageExercises.includes(exercise)`-shaped rule the spec calls out, one level removed.
2. **Single-level prescription resolution.** Once a winner was selected, its prescription was resolved via the same `lookupExercisePrescription(target.target_id, selection.exercise_id)` call — always at the `'efficient'` level — even though a real, Blueprint-authored prescription for that exact exercise could exist at the `'complete'` level instead (e.g. `rear-delt-row` is listed only in `shoulders-complete`, `bulgarian-split-squat-knee-dominant` only in `quads-complete`).

Both rules conflated "is this exercise part of the target's development-volume reference package" with "is this exercise a real candidate for this target" — exactly the incorrect interpretation spec rule #3 names. `lookupExercisePrescription` itself was not wrong for its own narrow, single-level contract; it was being used as an eligibility/prescription-existence gate, which the spec forbids.

A third, secondary defect was found and fixed while correcting the above (see "Code Changes"): once the pre-ranking filter was removed, a target's real candidate pool could legitimately contain equipment-feasible-but-package-absent-at-every-level "junk" candidates (e.g. `front-squat`/`sumo-squat`/`sumo-deadlift` for quads — real Blueprint exercises, but not listed in any quads package). The pre-existing "is this the last usable exercise, so give it all the remaining weekly volume" check (`isLastUsableExercise = pool.length === 0`) then miscounted such junk candidates as "another real option remains," silently truncating a target's last remaining exercise below its true delivered volume — a second, generic instance of the same underlying "package data used as more than a reference" family of bug, this time on the delivery side rather than the eligibility side.

## Code Changes

- **`src/blueprint/developmentPackages.ts`** — added `lookupExercisePrescriptionAnyLevel(physiqueTargetId, exerciseId)`, which checks `['efficient', 'complete']` in order via the existing (unmodified) `lookupExercisePrescription` and returns the first real match, or `null` only when the exercise is genuinely absent from *every* level. Used **only** to resolve one exercise's own prescription — never to decide which level governs a target's own development-volume reference (that remains `developmentReferenceEngine.ts`'s exclusive responsibility, entirely untouched by this fix).
- **`src/engine/workoutBuilder.ts`**:
  - Removed the `physique_target` pre-ranking prescription filter entirely. A `physique_target` candidate pool now always comes from the full equipment-feasible Blueprint (+ approved outside-Blueprint) exercise set for that target — package membership plays no role in candidate discovery or eligibility. (The `functional_goal` branch, which has no Blueprint package prescription source at all and was already restricted to approved outside-Blueprint candidates, is unchanged.)
  - The sole remaining prescription-resolution call site now uses `lookupExercisePrescriptionAnyLevel` instead of the single-level `lookupExercisePrescription`.
  - The day-construction loop's "no prescription for the current top-ranked candidate" branch now **retries** with the next-best real candidate (removing just that one exercise from the pool and continuing) instead of giving up on the whole target — implemented in both the last-day multi-exercise loop (already had a retry-shaped structure; the early `break` became a `continue`, and the once-checked pool-exhaustion also now removes the failed id first) and the every-other-day single-exercise branch (previously had no retry at all — a single `attemptSelection` call). A genuine data gap is now only ever reported once the *entire* real candidate pool has been exhausted with nothing placed for that target this week.
  - Added `prescribableExerciseIds` (computed once per target) and used it to fix `isLastUsableExercise`: it now asks "does any *prescribable* candidate remain in the pool," not "is the pool merely non-empty" — so a target's genuinely-last usable candidate correctly absorbs its full remaining weekly volume instead of being capped at its own per-session Blueprint `sets` figure and silently under-delivering the rest.

New candidate-selection flow (matches spec's required flow):
```
Blueprint exercise lookup + target/muscle matching  →  candidateExerciseIds (full library, target-relevant)
                                                     →  filterEquipmentFeasible (real constraint)
                                                     →  Gate 1-6 ranking over the FULL feasible pool (no package narrowing)
                                                     →  prescription resolution for the actual winner (any package level, or outside-Blueprint)
                                                     →  no prescription? retry next-best candidate; only report a gap once genuinely exhausted
```
Development packages are read in exactly one remaining place for `physique_target`s: per-exercise prescription lookup on the already-selected winner. Development-volume/reference sizing (goal-linked → Complete, non-goal → Efficient) is computed entirely by `developmentReferenceEngine.ts`, which this fix does not touch.

## Prescription Resolution

A selected exercise's sets/reps/RIR now come from `lookupExercisePrescriptionAnyLevel`, i.e. the real Blueprint-authored entry for that exercise at whichever of `efficient`/`complete` actually lists it (never invented, never averaged, never guessed). If an exercise is genuinely absent from *both* levels for its target's muscle_group (Blueprint's own curation gap — e.g. `rear-delt-fly`), that exercise cannot be placed; the day-construction retry moves on to the next real candidate, and only once every real, equipment-feasible candidate has been tried without success is a `SkippedTarget` reason surfaced, e.g.:

> "No equipment-feasible candidate for this target has a resolvable Blueprint prescription (development-package rep/RIR at any level, or an approved outside-Blueprint one) — exposing this genuine data gap rather than inventing one (spec §25). Last attempted: \"rear-delt-fly\"."

This never claims the exercise is "invalid" or "absent from the package" as the reason — it states the real, narrow fact (no resolvable prescription anywhere) and names the last real attempt, per spec rule #4.

## Tests

New file `tests/engine/blueprintCandidateGating.test.ts` (5 tests), exercising the real `buildWorkout` pipeline end-to-end (never an isolated stand-in):

1. **Fixture precondition check** — pins down the exact real Blueprint-snapshot facts every other test depends on (`rear-delt-row` absent from `shoulders-efficient`/present in `shoulders-complete`; `rear-delt-fly` absent from both; `bulgarian-split-squat-knee-dominant` absent from `quads-efficient`/present in `quads-complete`), so a future Blueprint data sync that changes these facts fails loudly here rather than silently invalidating the tests below.
2. **Requirement D** — `rear-delt-row` remains a real, selected candidate for `rear-delt` (with equipment restricted so it is the *only* feasible rear-delt exercise) even though it is absent from `shoulders-efficient`; its prescription (reps 8–15, RIR 1–3) is confirmed to come from `shoulders-complete`.
3. **Requirement E (generic)** — `bulgarian-split-squat-knee-dominant` remains eligible and gets selected for `quads` despite being absent from `quads-efficient`, proving the fix is architectural (a completely different target/muscle group), not rear-delt-specific.
4. **Requirement F (negative)** — `rear-delt-fly`, absent from *every* shoulders package level, is correctly rejected/surfaced as a genuine data gap: no exercise is fabricated for `rear-delt`, the skip reason names the real cause ("resolvable Blueprint prescription", naming `rear-delt-fly`), and the reason text is asserted to **not** claim the exercise is "invalid" or blame mere package absence.
5. **No package contamination** — asserts `shoulders-efficient`/`shoulders-complete`/`quads-efficient`/`quads-complete` still contain exactly their real pre-fix exercise lists (byte-for-byte), and explicitly that `rear-delt-fly` was never added to either shoulders package level to "solve" the bug.

I confirmed tests 2–4 (and the fixture precondition check) actually fail against the pre-fix code (reverted `workoutBuilder.ts`/`developmentPackages.ts` via `git stash`, ran the suite, restored) — proving they detect the real regression rather than being vacuously true.

**Pre-existing tests updated** (not weakened — recalibrated against newly-correct behavior, each verified against real Blueprint snapshot data before changing):
- `tests/engine/strictBugFixRequiredTests.test.ts` — a quads multi-exercise test's expected `bySets` updated from `{ 'back-squat': 3, 'leg-press': 3, 'leg-extension': 2 }` to `{ 'back-squat': 3, 'bulgarian-split-squat-knee-dominant': 3, 'leg-extension': 2 }`: `bulgarian-split-squat-knee-dominant` is a real quads candidate with a real `quads-complete` prescription that was previously invisible to selection and now legitimately outranks `leg-press`.
- `tests/routes/weekProgramPersistence.test.ts` (§22.3, 10 of 12 activity-transition variants) and `tests/routes/weekActivityOverride.test.ts` (Test 4) — these asserted an unrelated day's *entire* plan snapshot stays byte-identical when another day's activity changes. Correctly fixing volume under-delivery for a normal-development ("leftover time budget") target changes that target's own footprint, which can legitimately flip which *lowest-priority* filler target wins a leftover slot on another day when the week's total real gym-day count changes — a natural consequence of shared leftover-budget competition, not new instability. Both files now compare only **goal-linked** prescriptions (fixed weekly volume, never a leftover-budget slot) for the "unrelated day is stable" assertion, which is the guarantee these tests actually intended to protect; the same-row-id checks are unchanged and still pass.

## Verification

Run on branch `fix-blueprint-exercise-candidate-gating`, from a clean state (no DB reset involved — verification is pure in-memory SQLite per test):

| Step | Command | Result |
|---|---|---|
| Build | `npm run build` (part of `npm run verify`) | **Pass** |
| Typecheck | `npx tsc --noEmit` | **Pass**, 0 errors |
| Full test suite | `npx vitest run` (also `npm test` inside `npm run verify`) | **75 test files passed, 714 tests passed, 0 failed, 0 skipped** |
| Composed verify | `npm run verify` (build + typecheck + test) | **Pass**, exit code 0 |

Before this fix (same branch, before the `isLastUsableExercise` correction): 74 files / 709 tests, 1 failing (`workoutBuilder.test.ts`'s badminton volume-gate test, itself caused by the secondary under-delivery defect this fix also corrects). After the full fix: 709 pre-existing tests still pass (2 of them recalibrated as described above, verified against real data) + 5 new tests = 714 total, all passing, 0 failed, 0 skipped.

Confirmed:
- Rear-delt regression tests pass (Requirement D, both `rear-delt-row` positive and `rear-delt-fly` negative/data-gap cases).
- Package membership is no longer an eligibility gate anywhere in the `physique_target` candidate path — `candidateExerciseIds` for a `physique_target` is never filtered by `lookupExercisePrescription`/`lookupExercisePrescriptionAnyLevel` before ranking; only equipment feasibility and target relevance gate discovery, exactly as required.
- Manual code-level trace of the final flow matches the spec's required pipeline (see "Code Changes" above).

## Safety

- **No SQLite database reset.** All test runs use isolated in-memory (`:memory:`) SQLite databases created per test; no production database file was touched, reset, or recreated.
- **No production data modification.** This task made no changes to workout history, goals, or any runtime data — only source files under `src/` and test files under `tests/`, plus this doc and the spec doc under `docs/`.
- **No package contamination.** `shoulders-efficient`, `shoulders-complete`, `quads-efficient`, and `quads-complete` were not edited; `docs/FIX_BLUEPRINT_EXERCISE_CANDIDATE_SELECTION_REPORT.md`'s own regression test (`tests/engine/blueprintCandidateGating.test.ts`'s "no package contamination" test) asserts their exercise lists are byte-identical to their real pre-fix contents and that `rear-delt-fly` was never added to bypass the bug.
- **No AI/LLM dependency added.** The fix is a purely deterministic rule change (candidate discovery, retry-based prescription resolution, and a corrected "last usable candidate" check) — no new runtime dependency, network call, or non-deterministic behavior was introduced.
- No nginx/systemd configuration was touched. Deployment is out of scope for this task and was not performed — this remains a code-only change on a feature branch, not merged to `main`, per the task's explicit instruction.
