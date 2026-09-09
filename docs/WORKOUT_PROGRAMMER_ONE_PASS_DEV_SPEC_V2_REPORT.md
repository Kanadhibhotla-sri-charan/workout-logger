# Workout Programmer — One-Pass Dev Spec v2: Implementation Report

Corresponds to `docs/WORKOUT_PROGRAMMER_ONE_PASS_DEV_SPEC_V2.md`, implemented on the same
branch as all prior Workout Programmer work (`workout-programmer-ui-and-equipment-filter-fix`).
Per the spec's own instruction, comments like "Consolidated Fix" or "Surgical Fix Pass" already
in the source were treated as claims to verify, not proof of correctness — the executable code
and tests were the authority. A full audit ran before any edit; every audit finding below was
traced by direct code reading (and, for the calendar-week allocator, by an exhaustive
whole-repo grep for callers), not by trusting existing comments.

## Audit findings (§28/§29)

The full path (Blueprint snapshot → adapter → exercise universe → development package/reference
→ target-level volume → goal allocation → actual exposure history → recovery → exposure-cycle
state → candidate universe → exercise selection → exercise-level prescription → session
construction → time/equipment processing → skip/exclusion state → friendly explanation → API →
UI/persistence) was traced end to end. Findings:

1. **Real, load-bearing defect — `workoutBuilder.ts`'s last-eligible-day construction loop
   absorbed the target's ENTIRE remaining weekly reference**, via as many additional exercises
   as needed, whenever that day happened to be a target's only/last real exposure opportunity
   this week. Every individual exercise already respected its own authored per-session cap
   (Consolidated Fix's earlier invariant), but the SESSION's cumulative total across several
   such capped exercises had no bound — letting one real session absorb two or more real
   exposures' worth of volume whenever a target had few compatible days. This is exactly the
   "cram multiple exposures into one session" anti-pattern spec §7.3's worked example forbids,
   and the true root cause behind §1.1's complaint about `remainingWeeklySets`/
   `eligibleDaysThisWeek` making the calendar week an authoritative exposure container.

2. **`developmentReferenceEngine.ts`'s `weekly_direct_set_reference` had no corresponding
   per-exposure figure** — only the weekly aggregate (`sum(package sets) × frequency`) existed,
   with no field representing "how much direct work belongs in ONE real session." This is what
   made finding #1 possible: there was no natural per-exposure ceiling anywhere in the pipeline
   to bound the last-day loop against.

3. **`frequencyEngine.ts`'s `allocateFrequency` is genuinely dead code** — a real, calendar-
   week-oriented session-spreading allocator (`sessions_per_week`/`assigned_days`, "spread N
   sessions evenly across available days") with **zero production callers anywhere in the
   repository** (confirmed by grepping every `import` of the module; only its own test file and
   a stray doc-comment in `workoutBuilder.ts` referenced it). It was not, in fact, the mechanism
   making the calendar week authoritative — `workoutBuilder.ts`'s own inline eligible-day logic
   is. Per spec §0's explicit warning against leaving contradictory leftover architecture in
   place, and because keeping a real, unused calendar-week allocator around is itself
   misleading, it — along with its dedicated test file and the stray comment reference — was
   removed rather than merely flagged.

Everything else audited was already correct, confirmed by direct reading:

- **Package membership is not a candidate eligibility gate** (§1.5/§1.6): `exercisesTrainingTarget`
  reads the full Blueprint exercise library via `roleFor`, never a package list.
  `lookupExercisePrescriptionAnyLevel` already searches every package level before a candidate
  is ever treated as a genuine data gap.
- **`exerciseSelector.ts`/`constraintEngine.ts`** (§1.6/§1.7): the selector receives the
  unfiltered programming candidate universe; `fitToTimeBudget`/`filterEquipmentFeasible` are
  real, tested utilities used only by the substitution endpoint, never called from generation.
- **`volumeEngine.ts`** (§1.4): `decideVolume` already separates development reference,
  target-volume objective, and exercise-level prescription — it never returns a number that
  itself becomes an individual exercise's sets; that only ever happened via defect #1.
- **No missed-exposure debt** (§7.4): `decideVolume`'s zero-primary-sets branch always
  recomputes from the CURRENT week's real completed sets, never accumulating a prior week's
  shortfall — confirmed by direct reading, and now covered by an explicit multi-week regression
  test (below).
- **Actual training drives future programming** (§10): traced through
  `workoutSessionsRepo` → `trainingState.ts` → `exposureEngine.ts` — unchanged, still correct.

## Fixes

### Fix 1 — Per-exposure reference (`developmentReferenceEngine.ts`)

Added `direct_sets_per_exposure` (`sum(package exercise sets)`, without the frequency
multiplier) and `sessions_per_week_reference` (`pkg.frequency.sessions_per_week`) to
`DevelopmentReference`, alongside the existing (unchanged) `weekly_direct_set_reference`
aggregate. This is the genuinely distinct per-exposure figure spec §1.3/§6/§25 requires —
never multiplied by frequency, never confused with the weekly aggregate.

### Fix 2 — Bound the last-eligible-day construction loop (`workoutBuilder.ts`)

The target's last real eligible day this week is still the ONLY day that may place multiple
exercises (0/1/multiple exercise construction, retained from the prior "Fix C"/Consolidated
Fix passes) — every OTHER eligible day still gets exactly one exercise, exactly as before this
spec (a deliberate, minimal, surgical change: only the last day's own multi-exercise absorption
needed a new ceiling). What changed: that last day's cumulative delivery is now also bounded by
`sessionCap` (`direct_sets_per_exposure`, when a package reference exists) in addition to each
individual exercise's own authored cap. A real exposure day can no longer absorb more than its
own natural per-exposure amount merely because the weekly reference is larger or because it
happens to be the target's only chance this week. Volume beyond that is left honestly unmet
(`unmetDirectSets`) for a future real exposure — never crammed, never debt.

### Fix 3 — Skip taxonomy renamed to match spec §18

`SkippedTarget.reason_code` renamed: `no_eligible_day` → `not_current_exposure`,
`adequately_exposed` → `adequately_covered`, and `no_candidates`/`no_resolvable_prescription`
collapsed into a single `blueprint_data_integrity` code (both were already the same genuine
data-gap category; the spec's model uses one name for it). `recovery` and
`no_volume_recommended` are unchanged (the latter is a real, distinct fact the spec's six named
examples don't cover, which §18 explicitly permits: "only use categories that correspond to
real engine facts"). `friendlyExplanation.ts`'s exhaustive switch was updated to match, with
wording aligned to spec §22's exact required phrasing (`not_current_exposure`: "is not part of
this week's exposure cycle... will be considered at the next appropriate target-training
session"; `blueprint_data_integrity`: "is incomplete, so the programmer cannot safely use it
until that data is fixed").

### Fix 4 — Valid-but-not-selected-today explanations for rejected candidates (§18/§22/§31.13)

Added `buildFriendlyRejectedCandidateReasoning` to `friendlyExplanation.ts`, built entirely
from structured facts every placed exercise's `decision.selection` already carries
(`rejected_candidates` + `decisive_gate` from `exerciseSelector.selectExercise`). It produces
spec §22's required "better variation selected" wording for any non-redundancy gate, and a
distinct "redundant today" wording when `decisive_gate` is `gate3_programming_need` (the
rejected candidate was already claimed for a different target this session) — both real,
distinct facts the selector already computes, never invented. Deliberately never folded into
`SkippedTarget`: a rejected candidate's own target was still successfully programmed, so
treating it as a skipped target would itself violate §23's "not selected" vs "invalid"
distinction.

### Fix 5 — Explicit no-contradictory-state check (§20)

Added `assertNoContradictoryProgramState`, called on every `WeeklyPlanSession` before
`buildWeeklyProgrammingPlan` returns — a real, executable check (not just a passing test) that
throws loudly if any target ever appears in both `plannedWork` and `skipped` for the same
session, matching this codebase's existing "fail loudly on a logic surprise" convention
(`NoFeasibleExerciseError`, `parseRange`). By construction this should never fire (every skip
site `continue`s before construction runs), and it did not fire during the live smoke test
below.

## Anti-workaround checklist (§30)

- Not a renamed reason with the same cause: `blueprint_data_integrity` still means exactly
  "no resolvable prescription found anywhere," never "not selected today."
- No UI-only fix: the skip/contradiction state itself is corrected in the engine, not hidden.
- No exercise-specific special case: the new `sessionCap` bound is a generic per-target
  Blueprint-derived figure, applied identically to every physique target with a package
  reference (verified across triceps/quads/glutes/hamstrings/calves in the live inspection
  below) — never a `hip-abduction`-specific constant.
- `developmentReferenceEngine.ts`'s numbers changed by ADDING a genuinely new, distinct field,
  not by tweaking the existing aggregate to paper over the real construction-loop defect.
- The weekly arithmetic (`desiredWeekly`/`remainingWeeklySets`) is untouched — the fix is
  entirely in what a single session may draw from it, not in how the weekly figure itself is
  computed.
- `fitToTimeBudget`/equipment filtering were not renamed, relocated, or reintroduced under a
  different name — confirmed still zero callers from generation.
- Skip scope dedup was not "fixed" by hiding duplicate cards; `scope: 'week'` was already
  correct from the Consolidated Fix and is unchanged here.
- No meaningful test was weakened to reach green — every pre-existing test that broke was
  broken because it encoded the literal cramming anti-pattern this spec forbids (see below); all
  such tests were rewritten to assert the corrected model, and re-verified via `git stash` to
  fail against the pre-fix code first.

## Tests

**Recalibrated** — two pre-existing tests in `tests/engine/coreEngineSurgicalFixPassTests.test.ts`
encoded the now-corrected behavior directly:
- "Test 6" asserted the literal string `'adequately exposed'` — updated to the renamed
  `'adequately covered'` / `reason_code: 'adequately_covered'`.
- "Test 8b" asserted that a target's real weekly need (9) was fully delivered (9/9, `unmetDirectSets:
  0`) in one session using more real exercises than its package's own 3-member roster, by reaching
  into approved outside-Blueprint candidates for the extra 2 sets — the literal cramming anti-pattern.
  Rewritten to assert the corrected model: this single real exposure delivers exactly its own natural
  per-exposure amount (7, using multiple real Blueprint exercises — proving no artificial
  single-exercise ceiling either), the outside candidates are correctly never reached, and the
  genuine remaining 2 sets are left honestly unmet. Verified to fail against the pre-fix code
  (`expected 9 to be 7`) before being trusted.
- `tests/engine/consolidatedFixRequiredTests.test.ts`'s Test 7 updated to the renamed
  `blueprint_data_integrity` code.
- `tests/engine/volumeEngineBlueprintFallbackGuard.test.ts`'s three `DevelopmentReference`
  fixture literals updated with the two new required fields (additive type change only, no
  behavioral change to that test).
- `tests/friendlyExplanation.test.ts`'s skip-reasoning suite updated to the renamed taxonomy and
  spec §22 wording.

**New** — `tests/engine/onePassDevSpecV2RequiredTests.test.ts` adds the spec §31 cases not
already covered by existing suites (documented in the file's own header, mirroring every prior
phase's "don't duplicate, reference existing coverage" discipline):
- §31.7 full equipment-invariance equivalence (byte-identical exercises/sets/reps/RIR/skips with
  empty vs. full equipment — stronger than the pre-existing "still selects something" check).
- §31.14 an engine-level (not just presentation-layer) `not_current_exposure` scenario: a
  leg-region target with only Monday available (legs are deterministically never assigned
  Monday) genuinely has zero compatible days this week.
- A dedicated multi-day exposure-cramming regression: triceps with 3 real eligible days and a
  weekly need three times its own per-exposure reference — asserts no single day ever exceeds
  `direct_sets_per_exposure`, and the genuine remainder is left unmet. Verified via `git stash`
  (workoutBuilder.ts only, to isolate the real generation-logic defect from the new field) to
  fail against the pre-fix code (`expected 12 to be less than or equal to 7`) before being
  trusted.

Also added `tests/friendlyExplanation.test.ts` coverage for `buildFriendlyRejectedCandidateReasoning`
(§31.13): both the "better variation" and "redundant today" framings, using real exercise names,
never "no valid prescription"/"not prescribable" wording.

**Full test results** (run for real on 2026-09-09):

```
Typecheck: PASS
Tests: 759 passed / 0 failed / 0 skipped (80 test files)
Build: PASS
Verify: PASS
```

## Live inspection of a real generated week (§39)

A real server instance ran against a disposable scratch SQLite database (never the production
DB), with a deliberately adversarial profile: PPL+Upper 4-day split, `available_equipment:
["dumbbell"]` only, and an active `chest-front-width` goal. A real week was generated through
the actual `GET /api/programming/week` route.

- **No time-based omissions**: every day's `estimatedMinutes` (58.9–200.2) exceeded its
  60-minute `availableMinutes`; nothing was dropped for it.
- **No equipment-based omissions**: 44 of the week's 65 real placed exercises require equipment
  (`cable`, `barbell`, `machine`, `rack`, ...) the profile does not list — confirmed directly
  against each exercise's own real Blueprint `equipment` field.
- **No exercise exceeded its authored Blueprint sets**: a script checked all 65 real placements
  against `lookupExercisePrescriptionAnyLevel` — 0 violations.
- **No single session exceeded its target's own natural per-exposure amount**: checked every
  real per-day, per-target delivered-sets total against `direct_sets_per_exposure` across 39
  distinct (day, target) combinations spanning quads, glutes, hamstrings, calves, chest, back,
  shoulders, arms, and forearms — 0 exceedances; several legitimately reached the cap exactly
  (quads 8/8, gastrocnemius 6/6, soleus 6/6, hamstrings 5/5, biceps 5/5 on two separate days),
  proving the new invariant is genuinely binding in real output, not merely passing by
  coincidence.
- **No target appeared both programmed and skipped**: verified across all 4 real gym days.
- **No valid Blueprint variation was described as unprescribable**: the three real skips this
  week (`front-delt`, `adductors`, `neck-thickness`) each read *"The Blueprint data for ... is
  incomplete, so the programmer cannot safely use it until that data is fixed — this is a data
  gap to fix, not a normal training decision"* on every session, identically.
- **Goal-linked and normal-development explanations were concrete and correct**: e.g. *"Added
  for your chest front width goal. Cable Fly primarily trains the Mid Chest, helping build the
  development you're targeting. You haven't trained this target yet this week..."*

The scratch database and server process were torn down afterward; no production data was
touched at any point.

## Success criteria (§40) — status

Every item in §40's checklist holds, verified either by the audit above, the test suite, or the
live inspection: Blueprint validity/package-membership/data-integrity distinction intact;
exercise prescriptions authoritative and capped; frequency interpreted through actual exposures
with the calendar week as a reporting boundary only (confirmed by the multi-day cramming
regression and the live per-day/per-target cap check); no missed-set debt; goals retain
priority; recovery/coverage/redundancy remain valid programming criteria; no arbitrary numeric
scoring introduced; equipment/time have zero effect on generation (confirmed live); every
exclusion has a concrete, honest reason; skip scope is correct and non-duplicated;
programmed/skipped states cannot contradict (now an executable check, not just a test).

## Production Safety

- No database reset, recreation, or migration — this pass required no schema change.
- No historical workout data was altered — the live inspection used a disposable scratch
  SQLite file created and destroyed in the session's own scratchpad directory, never the real
  database.
- No goal, Blueprint package content, or aesthetic/functional target definition was modified —
  only generation-orchestration (`workoutBuilder.ts`), the development-reference abstraction
  (`developmentReferenceEngine.ts`), and presentation-layer code
  (`friendlyExplanation.ts`) changed; all operate on Blueprint's existing data read-only.
  `frequencyEngine.ts` (confirmed dead) and its dedicated test file were removed.
- No systemd/nginx configuration was touched.
- No AI/LLM dependency was introduced.
- **Nothing was deployed; this branch was not merged to `main`.**
