# AI Programmer Phase 2 — Correction Pass

Addresses reviewer feedback on `docs/AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT_REPORT.md`'s original implementation (commit `a64eae6`, branch `ai-programmer-first-vertical-slice`). No architectural rewrite — this is a data-model correction plus documentation/test additions.

## The defect

`commitAIProposalToPlannedSession()` (`src/ai-programmer/service/aiProposalLifecycle.ts`) mapped each proposed exercise's `sets` (count) into `exercise.sets` worth of `workout_sets` rows, but left `reps`/`weight`/`rir`/`rpe` on those rows `null` and wrote the proposal's `restSeconds` into `workout_sets.rest_seconds` — a PERFORMED-value column. The proposal's `repsMin`/`repsMax`/`rirMin`/`rirMax` were dropped entirely: nowhere in the schema was there anywhere correct to put a prescribed *range*, since `workout_sets` only ever recorded a single performed number per field.

## The fix

**Extended the existing planned-prescription model, following its own established naming convention, rather than inventing a new one or overloading performed-value fields.** `program_session_exercises` already had `target_sets`/`target_reps_min`/`target_reps_max` for exactly this purpose (a Program's own planned sessions) — it just never needed an RIR range or rest seconds. `workout_exercises` (the table the AI-committed session actually uses) gained the same three columns plus `target_rir_min`/`target_rir_max`/`target_rest_seconds`:

```sql
ALTER TABLE workout_exercises ADD COLUMN target_sets INTEGER;
ALTER TABLE workout_exercises ADD COLUMN target_reps_min INTEGER;
ALTER TABLE workout_exercises ADD COLUMN target_reps_max INTEGER;
ALTER TABLE workout_exercises ADD COLUMN target_rir_min REAL;
ALTER TABLE workout_exercises ADD COLUMN target_rir_max REAL;
ALTER TABLE workout_exercises ADD COLUMN target_rest_seconds INTEGER;
```

(`src/db/schema.sql` for fresh databases; `src/db/client.ts`'s `addColumnIfMissing()` for an already-existing one — all nullable/additive, safe on real logged history.)

`ExercisePerformance` (`src/contracts/types.ts`), `AddExercisePerformanceInput`/`addExercisePerformance()`/`getExercisePerformances()` (`src/repositories/workoutSessionsRepo.ts`) were extended to carry these six fields end-to-end. The commit mapper now writes the proposal's `repsMin`/`repsMax`/`rirMin`/`rirMax`/`restSeconds`/`sets`(count) into these `target_*` columns, and every `workout_sets` row it creates keeps `weight`/`reps`/`rir`/`rpe`/`rest_seconds` at `null` — correctly representing "prescribed but not yet performed" rather than smuggling a plan into a performance field. A plain logged exercise (added via the existing `POST /api/workouts/:id/exercises`) is unaffected: its `target_*` columns are simply `null`, meaning "no prescription recorded."

## Verification

- **New regression test** (`tests/ai-programmer/aiProposalRoutes.test.ts`, `'commit preserves the full prescription'`): generates a proposal with deliberately distinctive values (`sets: 5, repsMin: 7, repsMax: 11, rirMin: 2, rirMax: 4, restSeconds: 137`), approves and commits it, then reads the resulting session back through the real `GET /api/workouts/:id` HTTP endpoint (not just internal repo state) and asserts every `target_*` field matches exactly, while every one of the 5 created `workout_sets` rows still reads `reps: null, weight: null, rir: null, rpe: null, rest_seconds: null, completed: false`.
- **Verified by reversion**: temporarily reverted only the mapper's field assignments back to the original (buggy) shape while keeping the schema/type extensions — the new test failed (`expected null to be 5`), confirming it genuinely exercises the fix. Restored and re-confirmed green.
- **Two new repository-level tests** (`tests/workoutSessions.test.ts`) directly exercise `WorkoutSessionsRepo` independent of the AI proposal flow: a plain logged exercise leaves every `target_*` field `null`; an exercise created with an explicit prescription preserves it exactly, separate from its performed set values.

## `contextHash` clarification (reviewer question)

**`contextHash` is audit metadata only — it was never, and still is not, compared against a freshly-computed hash as an equality gate at commit time.** This is now stated explicitly in three places: a doc comment on `AIProposalRecord.contextHash` (`src/repositories/aiProposalRepo.ts`), an inline comment at the staleness-check site in `commitAIProposalToPlannedSession()`, and a rewritten **Stale-context / stale-Blueprint detection** section in `docs/AI_PROGRAMMER_PHASE_2_PROPOSAL_LIFECYCLE.md`.

**Why not enforce it:** `hashContext()` hashes the entire generation-time context, which includes point-in-time-volatile facts (`currentDate`, every target's live exposure/recovery snapshot). An exact-match check would fail almost any proposal more than a few minutes old regardless of whether anything commit-relevant actually changed, defeating the entire purpose of a 24-hour approval window.

**What IS enforced, and why it's the right scope:** (1) `blueprint_commit` equality — a cheap, exact, semantically meaningful fingerprint; and (2) a full domain revalidation (`validateProposalDomain()`) against a **freshly rebuilt** context. This second check already catches every state change that could actually invalidate a specific proposal — a changed/drifted authored prescription (re-derived from Blueprint's own current static truth), an exercise no longer valid for its target (including one that only exists in the *separate* outside-Blueprint catalogue, approved or not), and a target-date/weekday mismatch (which transitively also catches a `TrainingProfile.timezone` change shifting what "today" is) — without the false positives an opaque hash comparison would produce (e.g. an unrelated new goal being activated would trip a hash check but has no bearing on this proposal's own validity).

Two new tests demonstrate this precisely:
- `'contextHash is audit metadata, not an equality gate'` — activates a new goal (which changes what a freshly-built context/hash looks like) between approval and commit, and confirms commit still succeeds.
- `'a proposal whose stored sets/reps/RIR drifted from Blueprint's authored prescription is rejected at commit'` — tampers the stored proposal's `sets` value away from the authored cap and confirms `422 AI_PROPOSAL_STALE`.

## Outside-Blueprint exercise rejection (reviewer request)

New test: `'a proposal retargeted (post-generation) at an approved outside-Blueprint exercise is still rejected'` — proposes and **approves** an outside-Blueprint exercise via the existing, separate `OutsideBlueprintExercisesRepo`, then retargets a stored (already-approved) AI proposal at that exercise's id and attempts commit. Result: `422 AI_PROPOSAL_STALE`, because `BlueprintAdapter.isKnownExercise()` (used inside `validateProposalDomain()`) never resolves an outside-Blueprint id regardless of its own approval state — this milestone's AI proposals accept `source: "blueprint"` only, with no exception.

## Confirmed still passing (unmodified)

Re-ran the full suite and the specific named tests after the data-model change:
- Idempotent repeated commit (same `committedSessionId`, no duplicate session).
- Concurrent commit via `Promise.all` (no duplicate session).
- Transactional rollback on a forced mid-commit persistence failure (`vi.spyOn(WorkoutSessionsRepo.prototype, 'addExercisePerformance')`) — proposal stays `approved`, no orphaned session.
- Completed/in-progress/planned session conflicts (409 `AI_TARGET_NOT_EDITABLE` / `AI_PROPOSAL_CONFLICT`).

All of the above were already present from the original Phase 2 pass and required no changes.

## Verification commands (all run from a clean state)

```
$ npm ci                    # 196 packages, clean (pre-existing audit warnings only, unrelated)
$ npm run build              # tsc -p tsconfig.build.json — clean
$ npx tsc --noEmit            # clean
$ npm test  (== npx vitest run)
 Test Files  93 passed (93)
      Tests  971 passed (971)     # was 965 before this pass; +2 new prescription-only repo tests +4 new route tests
$ npm run verify              # build + typecheck + test composed — identical result, re-confirmed after npm ci
```

Focused: `npx vitest run tests/ai-programmer/aiProposalRoutes.test.ts tests/workoutSessions.test.ts` → 31 + 8 = 39 tests, all passing.

## Files changed in this correction pass

- `src/db/schema.sql`, `src/db/client.ts` — `workout_exercises` prescription columns.
- `src/contracts/types.ts` — `ExercisePerformance` gains `target_*` fields, documented.
- `src/repositories/workoutSessionsRepo.ts` — thread prescription through `AddExercisePerformanceInput`/`addExercisePerformance()`/`getExercisePerformances()`.
- `src/repositories/aiProposalRepo.ts` — `contextHash` doc-comment clarification (no behavior change).
- `src/ai-programmer/service/aiProposalLifecycle.ts` — commit mapper fix; expanded staleness-check comments.
- `tests/ai-programmer/aiProposalRoutes.test.ts` — 4 new tests (prescription preservation, contextHash-is-audit-only, authored-prescription drift, outside-Blueprint rejection).
- `tests/workoutSessions.test.ts` — 2 new repository-level tests.
- `docs/AI_PROGRAMMER_PHASE_2_PROPOSAL_LIFECYCLE.md` — new **Prescription preservation** subsection; rewritten **Stale-context / stale-Blueprint detection** section.
- `docs/AI_PROGRAMMER_PHASE_2_CORRECTION_REPORT.md` — this file.

## Remaining limitations

Unchanged from the original Phase 2 report — no reject endpoint, no multi-user authorization, no generation deduplication, malformed stored JSON at commit surfaces as a generic 500. None of this correction pass's changes affect those.

## Final state

```
$ git status
working tree clean at commit bdc3ee7 (this report's own commit)

$ git rev-parse HEAD
bdc3ee7a18e15c8fef2c4e541da76ffa0ffd2b25

$ git log -1 --oneline
bdc3ee7 AI Programmer Phase 2 correction: preserve prescription, clarify contextHash, add tests
```
