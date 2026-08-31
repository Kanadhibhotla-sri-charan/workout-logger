# UI Build Phase — Implementation Report

Per §79/§80 of the "UI BUILD — NEXT PHASE IMPLEMENTATION SPECIFICATION".

## Files changed

Backend:
- `src/server/routes/programming.ts` — **new**. `GET /api/programming/week`,
  `GET /api/programming/today`, `GET /api/programming/substitutes`.
- `src/server/app.ts` — registers the new programming router.
- `src/server/routes/goals.ts` — adds `PATCH /:id/priority`,
  `POST /:id/deactivate`, `POST /:id/reactivate`, `GET /:id/events`.
- `src/server/routes/workouts.ts` — adds
  `GET /exercises/:exerciseId/history`.
- `src/repositories/workoutSessionsRepo.ts` — adds
  `listPerformancesForExercise`.
- `src/engine/workoutBuilder.ts` — exports `assembleWeeklyPlanInput` and
  `weekdayOfDate` (were module-private; the read-only API needed them,
  no logic changed); `WorkoutBuildResult` gains additive `weekday` and
  `session_purpose` fields, populated from values `buildWorkout` already
  computes internally.

Frontend:
- `public/style.css` — full rewrite (design system: tokens, cards,
  badges, forms, responsive week grid, mobile-first logger chrome,
  accessible focus states).
- `public/app.js` — extended with the required shared helpers
  (`showLoading`/`showError`/`showEmpty`, formatters, `createButton`/
  `createCard`, `renderAppHeader`, `withSaving`), on top of the existing
  `api()`/`el()`/`todayIso()`.
- `public/program.html` — **new**.
- `public/today.html`, `public/logger.html`, `public/index.html`,
  `public/history.html`, `public/profile.html` — rewritten per the spec.

Dev dependency: `supertest`/`@types/supertest` added (real HTTP-level
route tests — see below); `package.json`/`package-lock.json` updated
accordingly.

## New endpoints

```
GET   /api/programming/week          full real weekly plan
GET   /api/programming/today         today's real slice of the same plan
GET   /api/programming/substitutes   Blueprint-first substitution candidates
PATCH /api/goals/:id/priority
POST  /api/goals/:id/deactivate
POST  /api/goals/:id/reactivate
GET   /api/goals/:id/events
GET   /api/workouts/exercises/:exerciseId/history
```

Every one of these reuses the existing engine/repository functions
(`buildWeeklyProgrammingPlan`, `assembleAndBuildWorkout`,
`exercisesTrainingTarget`, `filterEquipmentFeasible`, `GoalsRepo`,
`GoalEventsRepo`, `OutsideBlueprintExercisesRepo`) — no new programming
logic was written; the routes only read, call the existing engine, and
resolve Blueprint ids to display names for the UI.

## UI pages changed

`public/today.html` (rewritten), `public/program.html` (new),
`public/index.html` (rewritten, Goals page), `public/logger.html`
(rewritten, mobile-first execution screen), `public/history.html`
(rewritten), `public/profile.html` (rewritten), `public/style.css`
(rewritten), `public/app.js` (extended).

## Tests added

- `tests/routes/programming.test.ts` (10 tests) — real HTTP calls
  against the Express app: `/week` determinism, all 7 days represented
  including rest/badminton days, gym sessions carry final programmed
  work, Monday never lower-body, Goal 1's priority survives and is
  labeled, real compound exposure reflected, time/equipment constraints
  respected (a minimal profile delivers strictly less than a full one);
  `/today` matches its exact corresponding session from `/week` (ids,
  total sets, purpose, minutes — not "similar"); `/substitutes`
  Blueprint-first + equipment-filtered, rejects a missing target.
- `tests/routes/loggerRoundTrip.test.ts` (3 tests) — POST session → POST
  exercise performance → PATCH completion → GET session round-trips
  exactly; POST session → PUT badminton-details → GET session
  round-trips exactly; exercise-history endpoint returns real
  performances most-recent-first.
- `tests/routes/goalsRoutes.test.ts` (6 tests) — `POST /match` never
  persists; `POST /` with `source=natural_language` persists with
  `source_text` preserved (and rejects a missing `source_text`);
  priority/deactivate/reactivate/events round-trip against the real
  routes; a third active aesthetic goal is rejected by the real backend
  restriction.

Total: 19 new tests, all exercising the real Express app via HTTP
(`supertest`), never just the underlying repo/engine functions in
isolation.

## npm ci

PASS

```
added 196 packages, and audited 197 packages in 4s
(no errors)
```

Run against a genuinely clean checkout (working tree archived via
`git archive` on a `git stash create` snapshot, including the new
untracked files, into a scratch directory with no `node_modules`/`dist`).

## npm run verify

PASS

```
> workout-logger@0.1.0 verify
> npm run build && npm run typecheck && npm test

 Test Files  45 passed (45)
      Tests  435 passed (435)
   Duration  9.48s
```

Build (`tsc -p tsconfig.json`): PASS, no errors.
Typecheck (`tsc --noEmit`): PASS, no errors.
Tests: 435/435 passed (416 pre-existing engine tests, unchanged and
still passing, plus 19 new route tests above).

## Manual smoke test

PASS (all 19 steps) — actually performed, via Playwright driving
Chromium against a running `npm run dev` instance on a fresh SQLite
database (a real training profile was set up first through the API, the
same one-time setup a real new user would do through the Profile page,
before starting the 19-step walkthrough):

```
1.  Open Today.                                    PASS
2.  Load weekly program.                            PASS (verified via step 3's real fetch)
3.  Open Program.                                    PASS — 7 real days rendered
4.  Open Goals.                                      PASS
5.  Create a natural-language goal.                  PASS — 5 real candidates returned
6.  Confirm the matched goal.                        PASS
7.  Confirm priority.                                PASS — Goal 1 badge visible
8.  Return to Today.                                 PASS
9.  Start workout.                                   PASS — real session created, redirected to logger
10. Confirm programmed exercises are preloaded.      PASS — 5 real exercise cards
11. Enter at least two sets.                         PASS
12. Complete workout.                                PASS — status became "Completed"
13. Open History.                                    PASS
14. Verify actual workout appears.                   PASS
15. Open Profile.                                    PASS
16. Change a non-destructive constraint.             PASS
17. Save.                                            PASS — inline "Profile saved." shown
18. Return to Program.                                PASS
19. Verify program reloads.                           PASS — 7 real days shown, freshly fetched
```

A first run of this smoke test caught a real bug: the "Add unplanned
exercise" search input in `logger.html` had no `id`, so its
`<label>` wasn't explicitly associated with it. Fixed
(`public/logger.html`), re-verified with a second full clean-DB run —
19/19 passed.

Additional targeted checks beyond the required 19 steps (also via
Playwright, also all real): a completed workout renders read-only with
an explicit "Edit workout" action and no Save/Finish controls; the
substitute picker loads real feasible alternatives and applies the
chosen one; "Skip exercise" marks an exercise skipped without deleting
it; the badminton detail form persists via `PUT`; the Program page's
day-detail modal opens with real content and closes on Escape; the
weekly goal summary renders; History's exercise-history search and goal
progress sections render; the Goals page's "View Blueprint context" and
"History" modals load real content. All 13 passed.

No console or page errors were observed in the browser during any of
these runs.

## Known limitations

- The "Add unplanned exercise" flow does not fetch previous-performance
  data before the first save (only generated/preloaded exercises show
  "Last time…" inline); the History page's exercise-history search
  covers this need separately.
- "Skip exercise" and "substituted for X" state is tracked client-side
  for the duration of one logger page session — there is no dedicated
  backend field for "planned exercise the user chose not to perform,"
  since the existing `ExercisePerformance` contract has no such concept
  and adding one was out of scope for this phase (the spec's own §70/§81
  prohibit inventing new persisted programming concepts here). Skipping
  or substituting an exercise, then reloading the page before saving
  anything, will show the original generated exercise again.
- Calorie calculation, calorie-tracker UI, and any MET/expenditure
  logic were explicitly out of scope for this phase (§52/§53) and were
  not touched.
- `npm audit` reports pre-existing vulnerabilities in transitive
  dependencies (unrelated to this phase's changes); not addressed here.
