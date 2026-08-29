# Change log: Scaffold Phase 1 — BlueprintAdapter, data contract, storage, minimal UI

- **Date:** 2026-08-29
- **Commit:** `2bc634eec1e1b3587d7749950fcf2f09d43195e9`
- **Scope:** Phase 1 of the Workout Programmer app — infrastructure and
  contracts only, no AI, no volume/frequency/recovery decision engine.

## What changed

Built the new app from scratch as a Node.js/TypeScript/Express project:

- **`scripts/sync-blueprint.mts`** — regenerates a vendored data snapshot
  (`src/blueprint/snapshot/{exercises,programming,manifest}.json`) by
  reading workout-blueprint's canonical YAML directly (its own generated
  JSON is gitignored upstream) and replicating its exact transform. Run
  against a shallow clone of `Kanadhibhotla-sri-charan/workout-blueprint`
  at commit `b018abc1049cb578e13ece8af442852af1dfacfe`; produced 123
  exercises, 26 aesthetic outcomes, 7 functional goals, 25 physique
  targets.
- **`src/blueprint/adapter.ts` + `types.ts`** — `BlueprintAdapter`, the
  only module allowed to know Blueprint's raw JSON shape.
  `getExercise/getExercises/getAestheticGoal(s)/getFunctionalGoal(s)/
  getTarget(s)/getEquipment/getEquipmentList/isKnownExercise/getManifest`.
  All snapshot data is deep-frozen at load time.
- **`src/contracts/types.ts`** — the versioned (`CONTRACT_VERSION`)
  canonical data contract: `User`, `Goal`, `Program`, `ProgramSession`,
  `WorkoutSession`, `ExercisePerformance`, `Set`, `TrainingExposure`.
- **`src/db/schema.sql` + `client.ts`** — SQLite (`better-sqlite3`) schema:
  `goals`, `programs`, `program_goals`, `program_sessions`,
  `program_session_exercises`, `workout_sessions`, `workout_exercises`,
  `workout_sets`, plus a `schema_meta` table recording the contract
  version. Applied idempotently on startup.
- **`src/repositories/`** — `GoalsRepo`, `ProgramsRepo`,
  `WorkoutSessionsRepo`. `WorkoutSessionsRepo.addExercisePerformance`
  rejects any `exercise_id` that doesn't resolve via
  `BlueprintAdapter.isKnownExercise`, throwing
  `UnknownBlueprintExerciseError`.
- **`src/services/calorieTrackerExport.ts`** — `getCompletedWorkouts(db,
  date)`, the Calorie Tracker read contract. Always attaches an
  `expenditure_note` framing the data as an **estimate**, never an exact
  calorie figure.
- **`src/server/`** — Express app (`app.ts`) + routes for
  `/api/blueprint`, `/api/goals`, `/api/programs`, `/api/workouts`,
  `/api/export`; `index.ts` entrypoint.
- **`public/`** — minimal static UI: `index.html` (goals/programs),
  `today.html` (start a workout), `logger.html` (log sets against a
  session), `history.html` (past sessions). Vanilla JS, no framework, no
  analytics dashboard.
- **`tests/`** — 17 Vitest tests: known/unknown Blueprint exercise id
  resolution, Blueprint data immutability (frozen at multiple levels),
  session/exercise/set creation with valid Blueprint ids, incomplete-set
  representation, duration persistence, goal-context persistence for both
  aesthetic and functional goals, and the Calorie Tracker export shape
  (including an explicit assertion that no `calories`/`calories_burned`
  field exists and the note always says "estimate").

## Why

Implements the Phase 1 deliverables list in full: clean standalone repo
(no Blueprint copy, no submodule), a thin read-only adapter at the
Blueprint boundary, a versioned contract separating Blueprint knowledge
from user-owned training state, persistent storage, the Calorie Tracker
export contract, and minimal UI screens — see
`docs/architecture.md` for the full rationale.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 17/17 passing.
- Manual smoke test: started the server against an in-memory DB, hit
  `/api/health`, `/api/blueprint/exercises` (123 results), and created a
  goal via `POST /api/goals` — all returned expected shapes.
- `npm audit` reviewed: 5 findings, all dev-only (`vite`/`esbuild`/
  `vitest` dev-server request-forwarding advisory), none applicable to
  the production runtime; not fixed in this change to avoid an
  unrequested breaking Vitest major-version bump.
