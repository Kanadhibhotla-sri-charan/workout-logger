# 2026-09-01 — UI Build Phase: Program/Today/Logger/Goals/History/Profile

## What changed

Converted the static UI skeleton into the actual usable product loop
(goal → weekly program → today's workout → execution → logged
performance → history → next programming decision), per the "UI BUILD —
NEXT PHASE IMPLEMENTATION SPECIFICATION". The core programming engine
(`src/engine/workoutBuilder.ts` and everything it calls) was not
redesigned — this pass is UI + the smallest necessary read/write API
surface on top of it.

**New read-only programming API** (`src/server/routes/programming.ts`):
`GET /api/programming/week` (the complete real weekly plan, all 7 days,
rest/badminton days included) and `GET /api/programming/today` (today's
exact slice of that same plan, via the existing `assembleAndBuildWorkout`
— a deliberately separate code path from `/week`'s
`buildWeeklyProgrammingPlan` call, so the two genuinely prove agreement
rather than trivially matching one shared object sliced twice) and
`GET /api/programming/substitutes` (Blueprint-first, equipment-filtered
real candidates for a target, reusing `exercisesTrainingTarget` +
`filterEquipmentFeasible` + `OutsideBlueprintExercisesRepo`). Every route
only reads real state and calls the existing engine; the only
"computation" in this file is resolving a Blueprint id to its display
name and labeling which real user Goal (by real priority) a target
belongs to.

Two small, additive engine changes made this possible without
duplicating logic: `assembleWeeklyPlanInput` and `weekdayOfDate` (both
previously module-private in `workoutBuilder.ts`) are now exported, and
`WorkoutBuildResult` gained `weekday`/`session_purpose` fields populated
from values `buildWorkout` already computes — no behavior change, just
exposing already-real data the UI genuinely needed.

**New/changed goal routes** (`src/server/routes/goals.ts`):
`PATCH /:id/priority`, `POST /:id/deactivate`, `POST /:id/reactivate`,
`GET /:id/events` — all thin wrappers over the existing `GoalsRepo`/
`GoalEventsRepo` methods, which already existed but weren't exposed.

**New exercise-history route** (`src/server/routes/workouts.ts` +
`WorkoutSessionsRepo.listPerformancesForExercise`): real logged
performances of one exact exercise across every session, most-recent-
first — the History page's exercise filter.

**Frontend**: `public/style.css` and `public/app.js` rewritten/extended
as the shared design system and helper layer (loading/error/empty
states, formatters, `createButton`/`createCard`, a shared 5-item nav).
`public/program.html` is new. `public/today.html`, `logger.html`,
`index.html` (now the Goals page), `history.html`, and `profile.html`
were all rewritten against the new API. The frontend never computes a
programming decision — every set count, rep range, exposure number, and
"why" explanation displayed comes straight from a backend response
field; the only client-side logic is formatting, sorting, filtering, and
local UI state (spec §46/§70).

## New tests

`tests/routes/programming.test.ts` (10), `tests/routes/
loggerRoundTrip.test.ts` (3), `tests/routes/goalsRoutes.test.ts` (6) —
19 new tests total, all real HTTP calls against the actual Express app
via `supertest` (added as a dev dependency), not just the underlying
repo/engine functions. Covers: `/week` determinism, all 7 days
represented, Monday-never-lower-body, Goal 1 priority preserved and
labeled, real compound exposure reflected, time/equipment constraints
respected; `/today` matching `/week`'s exact corresponding session;
logger round-trips (session → exercise performance → completion; session
→ badminton details); exercise history most-recent-first; goal match
never persisting, confirm persisting with source/source_text; the
priority/deactivate/reactivate/events routes; the real 3rd-active-
aesthetic-goal rejection.

## Manual smoke test

Actually performed via Playwright driving Chromium against a running
`npm run dev` instance — all 19 required steps passed (see
`docs/UI_BUILD_PHASE_REPORT.md` for the full transcript). The first run
caught a real bug (a missing `id` on the "Add unplanned exercise" search
input in `logger.html`, breaking its label association); fixed and
re-verified clean on a second full run from a fresh database. 13
additional targeted checks (completed-workout read-only mode,
substitution, skip, badminton persistence, modals, History search) also
passed.

## Verification (real commands, real output)

```
$ npm ci
added 196 packages, and audited 197 packages in 4s
(no errors)

$ npm run verify
> npm run build && npm run typecheck && npm test
 Test Files  45 passed (45)
      Tests  435 passed (435)
```

Both run against a genuinely clean checkout. 435 = 416 pre-existing
engine tests (unchanged, still passing — confirming no engine
regressions) + 19 new route tests.

## Status against the acceptance gates

Today/Program/Goals/Logger/History/Profile acceptance items (spec
§71-78) are addressed as described above and in
`docs/UI_BUILD_PHASE_REPORT.md`. Programming integrity (§77) is
unchanged and re-verified through the full existing engine test suite
passing unmodified. The Calorie Tracker boundary (§78) was not touched —
`GET /api/export/completed-workouts` remains the existing, unmodified
contract.
