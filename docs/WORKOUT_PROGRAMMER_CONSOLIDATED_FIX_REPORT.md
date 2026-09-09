# Workout Programmer — Consolidated Fix: Implementation Report

Corresponds to `docs/WORKOUT_PROGRAMMER_CONSOLIDATED_FIX_SPEC.md`, implemented as one coherent
change on the same branch as the prior UI/equipment fixes (`workout-programmer-ui-and-equipment-filter-fix`,
restarted from `main` after that branch was previously merged). Per spec §22, the full flow was
audited before any edit was made (two independent deep-read passes over the entire generation
path), every violation found was fixed at its real source, and every existing test whose asserted
behavior codified the now-forbidden model was recalibrated to the new one — never weakened, and
verified to actually fail against the pre-fix code before being trusted.

## Audit (§17) — what was actually found

Two full-file audits of `workoutBuilder.ts`, `constraintEngine.ts`, `resourceAllocation.ts`,
`exerciseSelector.ts`, `developmentReferenceEngine.ts`, `volumeEngine.ts`, `frequencyEngine.ts`,
`exposureEngine.ts`, `recoveryEngine.ts`, `friendlyExplanation.ts`, and `weekProgramReconciliation.ts`
found exactly two load-bearing violations, both in `workoutBuilder.ts`:

1. **The authored per-exercise set cap was bypassed for the "last usable exercise"**
   (`workoutBuilder.ts`, the `isLastUsableExercise` branch): when a target's last eligible session
   this week had no other real candidate left to try, the code deliberately set
   `requested = remainingWeeklySets` **uncapped** by that exercise's own authored `sets` figure —
   exactly the "Hip Abduction = 8 sets because 8 remain" anti-pattern spec §3 forbids. This is also
   the mechanism that let a single session absorb far more than one real "exposure" worth of
   volume (spec §5's cram concern) whenever a target had few eligible days.
2. **Session time competed for and filtered candidates** (`workoutBuilder.ts`'s per-session
   `allocateResource` + `constraintEngine.fitToTimeBudget` block): every session ran a real
   goal-vs-goal time-budget split and then dropped whichever candidates didn't fit, producing
   literal `"Dropped by time-fitting..."` skip records — the exact mechanism spec §7 forbids.

Everything else audited was already correct: equipment was already fully removed from generation
in a prior pass (confirmed, no vestige found — only the substitution endpoint still uses
`filterEquipmentFeasible`, correctly); package membership was already not a candidate eligibility
gate (confirmed via the existing rear-delt regression coverage); `developmentReferenceEngine.ts`
already modeled its weekly figure as a target-level *reference*, correctly separate from
exercise-level prescription (the only place that separation leaked was violation #1 above); and
actual completed training was already the sole driver of exposure/volume decisions (traced through
`workoutSessionsRepo` → `trainingState.ts` → `exposureEngine.ts`, no generated prescription is ever
read back as if it were completed training).

## Fix 1 — Generic authored-set-cap invariant (§2/§3/§15.B)

`workoutBuilder.ts`'s day-construction loop no longer has a code path that bypasses a placed
exercise's own authored `sets` ceiling. The `isLastUsableExercise` special case and the now-unused
`prescribableExerciseIds` set were removed entirely; the identical `Math.min(remainingWeeklySets,
attempt.prescription.sets)` cap that already applied to every other day now applies uniformly,
including a target's last real session this week. Volume a session's real candidates cannot absorb
without violating their own caps is left honestly unmet (`unmetDirectSets`, already-existing
accounting infrastructure) rather than crammed into one exercise. This single fix also resolves
spec §5's cramming concern as a direct consequence: a target with only one real eligible session
this week can no longer have two exposures' worth of volume forced into it via an uncapped final
exercise.

## Fix 2 — Time and equipment have zero effect on generation (§7/§8)

The entire per-session `allocateResource` (goal-level time-budget split) + `fitToTimeBudget`
(candidate-dropping) mechanism was removed from `buildWeeklyProgrammingPlan`. Every real candidate
the earlier construction pass already decided to place for a given date is now placed
unconditionally; `estimatedMinutes`/`availableMinutes` remain on the API response purely as
informational display data, exactly as spec §7 requires. `resource_allocation` is now always `[]`
(kept only for API/type back-compat — nothing reads it). Equipment was already correctly removed
from generation in a prior pass; this fix did not touch that and re-confirmed it holds with a
dedicated zero-equipment regression test (below).

## Fix 3 — No misleading "not prescribable" fallback; structured, truthful explanations (§9/§10/§11)

`SkippedTarget` now carries an explicit `reason_code` (`'recovery' | 'no_eligible_day' |
'adequately_exposed' | 'no_volume_recommended' | 'no_candidates' | 'no_resolvable_prescription'`),
set at the exact site in `workoutBuilder.ts` that decides each skip — never inferred later by
string-matching. `friendlyExplanation.ts`'s `buildFriendlySkipReasoning` now switches exhaustively
on this code (a missing case is a compile error, not a silent fallback):

- `recovery` now cites the real last-trained date when the engine actually knows it
  (`"Quads was trained directly on 2026-09-07..."`), never a fabricated one.
- `adequately_exposed` now names the real covering exercise(s) resolved from
  `decision.recent_exercise_ids` via `BlueprintAdapter` (`"...already covered today by Back Squat
  and Leg Extension..."`), falling back to the prior generic wording only when no real id resolves.
- `no_candidates`/`no_resolvable_prescription` are now a **distinct, explicitly-labeled data-gap
  category** ("...is missing the Blueprint data needed to safely prescribe it right now — this is
  a data gap to fix, not a normal training decision"), never described as "not prescribable" or
  otherwise implying the target/exercise itself is invalid.

## Fix 4 — Global skip deduplication / explicit scope (§12)

`SkippedTarget` also now carries `scope: 'week' | 'session'`. Every current skip category is
computed once per target for the whole week and is explicitly marked `scope: 'week'` — a caller can
now tell "this is a whole-week fact recurring on every session" apart from "this was discovered
specifically today," rather than the two being indistinguishable. (No `'session'`-scoped skip
exists today since time/equipment — the only mechanisms that ever produced a genuinely day-specific
skip — no longer filter anything; the type still models the distinction for when one legitimately
exists.)

## Tests

**Recalibrated** (10 pre-existing tests across 6 files) — each asserted the literal
now-forbidden behavior (a scarce time budget dropping/capping a candidate) and was rewritten to
assert the opposite, real invariant using the identical fixtures; every recalibrated test was
verified to fail against the pre-fix code before being trusted:
`tests/engine/coreEngineSurgicalFixPassTests.test.ts`, `tests/engine/finalPassRequiredTests.test.ts`,
`tests/engine/strictBugFixRequiredTests.test.ts`, `tests/engine/workoutBuilder.test.ts`,
`tests/fixtures/realisticWeek.test.ts`, `tests/fixtures/strictBugFixFullWeek.test.ts`,
`tests/routes/actualTrainingAdaptation.test.ts`. `tests/friendlyExplanation.test.ts`'s
`buildFriendlySkipReasoning` suite was rewritten to switch on `reason_code` and gained coverage for
the real-date/real-covering-exercise/data-gap-framing requirements.

**New** — `tests/engine/consolidatedFixRequiredTests.test.ts` implements spec §16's 12 required
tests (Tests 6, 8, 9 point to existing dedicated coverage rather than duplicating it — see the
file's own header comment):

- Test 1 (Hip Abduction cap), Test 2 (generic authored-cap invariant across several targets),
  Test 3 (frequency across two independent weekly computations — no doubling, no debt), Test 4
  (a 1-minute nominal budget changes nothing), Test 5 (zero available equipment changes nothing),
  Test 7 (a functional_goal with no prescription source lands on the genuine-data-gap code, never
  an ordinary skip), Test 10 (an unselected-but-valid candidate is simply absent from
  `skipped_targets`, never flagged), Test 11 (a week-level skip carries `scope: 'week'` identically
  on every session), Test 12 (no session ever lists the same target as both planned and skipped).
- Test 6 → `tests/engine/blueprintCandidateGating.test.ts`'s existing rear-delt regression (a real
  Blueprint variation absent from Efficient remains a valid candidate).
- Test 8, Test 9 → `tests/friendlyExplanation.test.ts`'s `buildFriendlySkipReasoning` suite (real
  date, real covering exercise names).

All 4 new/rewritten tests in the new file that exercise the two core fixes directly were verified
to fail against the pre-fix `workoutBuilder.ts` (confirmed via `git stash`) before being trusted.

**Full test results** (run for real on 2026-09-09):

```
Typecheck: PASS
Tests: 767 passed / 0 failed / 0 skipped (80 test files)
Build: PASS
Verify: PASS
```

## Live inspection of a real generated future session (§21 item 10)

A real server instance was started against a disposable scratch SQLite database (never the
production DB). A deliberately adversarial profile was set — a 15-minute nominal session budget and
`available_equipment: ["dumbbell"]` only — plus an active `chest-front-width` goal, and a real week
was generated through the actual `GET /api/programming/week` route (no shortcuts). Inspecting the
real response:

- **No time-based omissions**: every session's `estimatedMinutes` (58.9–202.4) genuinely exceeded
  its 15-minute nominal `availableMinutes`, and no exercise was ever dropped for it.
- **No equipment-based omissions**: every generated exercise (`cable-fly`, `incline-barbell-press`,
  `back-squat`, `hip-thrust`, `lat-pulldown-wide-pronated`, ...) requires equipment (`cable`,
  `barbell`, `rack`, `bench`, `hip-thrust machine`) the profile explicitly does **not** list —
  confirmed directly against each exercise's own real Blueprint `equipment` field — proving
  equipment genuinely had zero effect on selection, not merely a coincidence.
- **No exercise exceeded its authored Blueprint sets**: a script checked all 66 real Blueprint
  exercise placements across the whole generated week against `lookupExercisePrescriptionAnyLevel`
  — 0 violations.
- **No valid Blueprint variation was described as unprescribable**: the three real skips this week
  (`front-delt`, `adductors`, `neck-thickness`) each read *"...is missing the Blueprint data needed
  to safely prescribe it right now — this is a data gap to fix, not a normal training decision"* —
  a distinct, honest category, never "not prescribable."
- **Exposure-cycle behavior was sensible**: goal-linked chest work appeared on both the real
  push (Monday) and upper (Friday) sessions with correctly goal-linked friendly explanations
  (`"Added for your chest front width goal. Cable Fly primarily trains the Mid Chest..."`); every
  other real muscle group received real, distributed direct work across the week's 4 real gym days.
- **Exclusion explanations were concrete**: every skip carried `scope: "week"` and the identical
  reasoning on every one of the week's 4 sessions, never presented as 4 independent daily
  discoveries.

The scratch database and server process were torn down afterward; no production data was touched
at any point.

## Scope discipline (§18)

Preserved untouched: Blueprint snapshot architecture, goals, actual workout logging, canonical
week-program reconciliation/persistence, the substitution workflow and its own equipment filtering,
session notes, Copy functionality, the friendly-explanation framework for placed (non-skipped)
work, and every direct/indirect exposure rule not explicitly named above. No AI/LLM dependency was
introduced. No exercise-specific hardcoded cap was added (the fix is fully generic — verified by
Test 2 across three unrelated targets). No second generation system was created. Package membership
remains, as before, never a candidate eligibility gate.

## Production Safety

- No database reset, recreation, or migration of any kind — this pass required no schema change.
- No historical workout data was altered — the live inspection above used a disposable scratch
  SQLite file created and destroyed in `/tmp`, never the real database.
- No goal, Blueprint package content, or aesthetic/functional target definition was modified —
  only presentation-layer (`friendlyExplanation.ts`) and generation-orchestration
  (`workoutBuilder.ts`) code changed; both operate on Blueprint's existing data read-only.
- No systemd/nginx configuration was touched.
- No AI/LLM dependency was introduced.
- Nothing was deployed; this branch was not merged to `main`.
