# 2026-09-19 — Assessment-Gate Workaround, and the Open Goal-Volume-Calibration Question

Commit (this entry's own). Follows directly from log entries 61-62, and
the same day's broader Option B model-eval session (see
`docs/AI_PROGRAMMER_RULES_AUDIT_AND_COACHING_DEPTH_WIRING_REPORT.md` for
the earlier part of this day's work — this entry covers a distinct,
later finding from the same session).

## Why

While investigating why a goal-oriented target (triceps-long-head, under
the real active goal "Triceps have no depth from behind") kept landing far
short of its own real Blueprint weekly reference (24 sets/week for the
`triceps-complete` package) even across the model-eval work, tracing
`volumeEngine.ts`'s real progression logic found the actual root cause:
volume only ever increases past its conservative starting point when a
real aesthetic assessment has been logged AND comes back `'stagnant'`
specifically (not improving, not declining) AND a caller confirms the
full §11 introspection checklist was walked. **No UI anywhere in this app
lets a real assessment ever be recorded** — `coaching-insights.html`
mentions the word "assessment" only in a disclaimer sentence; nothing
calls the real backend endpoint (`POST /api/goals/:id/assessments`,
`src/server/routes/goals.ts`). So `aesthetic_progress_trend` is
`'insufficient_data'` essentially forever for every goal, and volume sits
at its starting point indefinitely with no path to its own real reference
— not a deliberate safety choice holding, just a permanently stuck gate.

Explicit user decision: patch around this now for a confirmed `'advanced'`
trainee specifically (never novice/intermediate, where the real
build-up-gradually safety margin still fully applies), and log the real
fix (an actual assessment-logging UI) in enough detail to be picked up
immediately later — not lost, not silently forgotten.

## What changed (Option 2 — the workaround)

`src/engine/volumeEngine.ts`, `VolumeDecisionInput` gains an optional
`training_experience?: TrainingExperienceLevel | null`. Two effects, both
gated strictly on `training_experience === 'advanced'`:

1. **§9 starting volume** (target has zero existing direct volume): an
   advanced trainee starts directly at the target's own real Blueprint
   package reference (`development_reference.weekly_direct_set_reference`)
   instead of `min(Blueprint's conservative universal starting point,
   that reference)` — the "build up gradually, never jump" caution this
   skips is specifically aimed at protecting a less experienced lifter,
   which a confirmed advanced trainee doesn't need the same margin for.
2. **`insufficient_data` trend** (no assessment exists — the permanent
   real-world state right now): instead of unconditional `maintain`
   forever, an advanced trainee with `recovery_ok` gets the exact same
   small, bounded step (`PROGRESSION_INCREMENTS.weeklyExposureUnits`,
   currently 2/week) the stagnation-confirmed path already uses, capped
   at the target's own reference ceiling. Recovery caution still fully
   applies — a flagged recovery signal still means plain `maintain`,
   workaround or not. `'improving'` is deliberately left untouched
   (still always `maintain`, matching spec §10/§13's "don't fix what's
   working" principle) — the fix is scoped to the specific stuck state
   found, not a general loosening.

`src/engine/workoutBuilder.ts`: the one real call site
(`buildWeeklyProgrammingPlan`'s per-target `decideVolume(...)` call)
already had `input.trainingExperience` in scope (an existing
Coaching Depth Batch 5 field, previously only consumed by
`intensityTechniques.ts`) — threaded straight through, no new data read
needed.

6 new tests in `tests/engine/volumeEngine.test.ts` cover both effects
directly: advanced-trainee starting volume vs. the unaffected non-advanced
case, the bounded insufficient_data increase, the ceiling cap, recovery
caution still overriding the workaround, and a non-advanced trainee being
completely unaffected.

## Verification

`npm run typecheck` clean. Full vitest suite diffed test-by-test against
the established baseline: exact match, zero regressions.

## Not yet done — Option 1, the real fix (do this before the workaround is needed again)

A real UI for logging a goal's aesthetic assessment. Concretely, this
needs:

1. **A small form** — likely on `public/coaching-insights.html` (already
   the closest existing page conceptually, currently has no real form) or
   a new section on the goal's own detail view. Needs: a 1-5 rating input
   (the existing `ASSESSMENT_SCALE` labels — 1/2=worse, 3=no meaningful
   change, 4/5=improved), an optional free-text notes field, and a submit
   that calls the real, already-working `POST /api/goals/:id/assessments
   {date, rating, notes}` endpoint (`src/server/routes/goals.ts:188`).
2. **A read-back view** — `GET /api/goals/:id/assessments`
   (`src/server/routes/goals.ts:206`) already exists too; the UI should
   show past assessments for a goal (date, rating, notes) so a
   reassessment isn't done blind.
3. **A prompt/reminder mechanism** — each goal already has its own
   `review_cadence_days` (e.g. 28 days for both current active goals).
   Nothing currently surfaces "this goal is due for a review" anywhere in
   the app; without that, the form existing isn't enough — it needs to be
   surfaced at the right moment, not just theoretically reachable.
4. **The §11 introspection checklist itself has no UI path either** —
   even once a `'stagnant'` assessment can be logged, `decideVolume`
   still requires `introspection_confirmed_no_other_explanation` to be
   explicitly `true` before it will increase volume, and nothing today
   ever sets that. This is a second, related gap in the same area —
   worth building alongside the assessment form itself (e.g., the
   `STAGNATION_CHECKLIST` array already exported from `volumeEngine.ts`
   could drive a real "confirm each of these" UI step), not a separate
   effort later.

Once this exists for real, the Option 2 workaround in this entry should
be reconsidered — it was explicitly a stopgap for advanced trainees only,
not the intended long-term mechanism.

## Also flagged this session, not yet acted on — goal-volume calibration for sub-slice targets

Separate, related, larger design question raised the same day (see the
model-eval report and this session's own discussion, not yet written up
as its own spec): when a goal only needs a *portion* of a muscle group's
full package (e.g. "arms look thin from the side" needing only
triceps-long-head, not general triceps), that sub-target's own
package-derived numbers under-represent what it actually needs, because
Blueprint's package numbers were authored assuming the *whole* package is
trained together. Direction discussed (not yet designed or built): a
one-time, goal-setup-time AI reasoning pass — informed by Blueprint's own
real anatomical/technical-explanation text (`aestheticOutcomes[].
technical_explanation`, already real, already detailed) — decides a
durable, curated volume number for that specific sub-target once, stored
the same way obliques' curated frequency override already works
(`src/coaching/profiles/`), rather than either a rigid formula or a
live per-session AI judgment call (which this same day's model eval
showed is unreliable for exact numeric delivery even when the reasoning
itself is correct). This is the natural next extension of the still-open
"genuine reasoning setup" decision from earlier in the day — not a
separate feature.

## Not yet deployed

Committed to the repo only, per this project's established practice of
confirming before deploying.
