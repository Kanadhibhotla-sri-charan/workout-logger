# AI Programmer — First Vertical Slice: Implementation Report

Spec: `docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md` (authoritative task), informed by the supporting architecture docs uploaded alongside it (`docs/AI_PROGRAMMER_CONTEXT_SPEC.md`, `docs/AI_PROGRAMMER_CONTEXT_BUILDER_IMPLEMENTATION.md`, `docs/AI_PROGRAMMER_OUTPUT_SCHEMA.md`, `docs/AI_PROGRAMMER_SCHEMA_IMPLEMENTATION.md`, `docs/AI_PROGRAMMER_IMPLEMENTATION_PLAN.md`, `docs/AI_PROGRAMMER_INTEGRATION_AUDIT.md`, `docs/VELONA_PROVIDER_INTEGRATION_SPEC.md`).

## 1. Files created / modified

### Created

| File | Purpose |
|---|---|
| `src/ai-programmer/errors.ts` | Typed error classes for every failure mode in spec §13, each with its own HTTP status and a public-safe message. |
| `src/ai-programmer/contracts/programmerTypes.ts` | `AIWorkoutSessionProposal` / `AIWorkoutExerciseProposal` — the narrow single-session output contract (spec §7). |
| `src/ai-programmer/contracts/providerTypes.ts` | `AIProgrammerProvider` interface + request/response types (spec §8). |
| `src/ai-programmer/contracts/programmerOutputSchema.ts` | A plain-JSON shape description sent to the provider as prompting material (`outputSchema`) — not a runtime validator. |
| `src/ai-programmer/context/programmerContextTypes.ts` | `AIProgrammerContext` and its nested per-target/per-goal/per-day types. |
| `src/ai-programmer/context/programmerContextBuilder.ts` | `buildProgrammerContext(db, {targetDate, timezone})` — the real context builder. |
| `src/ai-programmer/context/programmerContextDiagnostics.ts` | Stable SHA-256 context hashing. |
| `src/ai-programmer/provider/config.ts` | Environment-based config (`isAiProgrammerEnabled`, `loadVelonaConfig`). |
| `src/ai-programmer/provider/velonaProvider.ts` | `VelonaProvider` — native Velona HTTP adapter with timeout/bounded-retry/error mapping. |
| `src/ai-programmer/validation/programmerOutputValidator.ts` | Structural (schema-level) validation of raw provider JSON. |
| `src/ai-programmer/validation/programmerDomainValidator.ts` | Blueprint/domain/lock validation of a structurally-valid proposal. |
| `src/ai-programmer/service/aiProgrammerService.ts` | `AIProgrammerService` — wires context → provider → validate; fixed system instruction. |
| `src/server/routes/aiProgrammer.ts` | `POST /api/ai-programmer/generate-session`. |
| `docs/AI_PROGRAMMER_INTEGRATION_STATUS.md` | Status, env vars, endpoint contract, error codes, troubleshooting, security notes. |
| `tests/ai-programmer/programmerContextBuilder.test.ts` | 13 tests — context-builder matrix (spec §14.1). |
| `tests/ai-programmer/velonaProvider.test.ts` | 13 tests — provider matrix with mocked `fetch` (spec §14.2). |
| `tests/ai-programmer/programmerOutputValidator.test.ts` | 13 tests — structural schema validation. |
| `tests/ai-programmer/programmerDomainValidator.test.ts` | 13 tests — domain-validation matrix (spec §14.3). |
| `tests/ai-programmer/aiProgrammerService.test.ts` | 9 tests — service-level tests with a fake provider. |
| `tests/ai-programmer/aiProgrammerRoute.test.ts` | 8 tests — real HTTP route tests via `supertest` + mocked `fetch` (spec §14.4). |

### Modified

| File | Change |
|---|---|
| `src/server/app.ts` | Registered `aiProgrammerRouter` at `/api/ai-programmer`. |
| `README.md` | New "AI Programmer" pointers: repository layout entry, docs list entry, env-var section note (still "no secrets required" for the deterministic app; the AI layer is separately flagged). |

No existing file under `src/engine/`, `src/server/routes/programming.ts`, `src/server/routes/workouts.ts`, or `src/db/schema.sql` was modified. No database migration was added — this milestone persists nothing new.

## 2. What was implemented

1. **AI programmer domain contracts** (`contracts/`) — the narrow `generate_session` output contract from spec §7, the provider interface from spec §8, and typed errors for every code in spec §13.
2. **Context builder** (`context/`) — reuses, rather than duplicates, the existing engine:
   - `assembleWeeklyPlanInput` (already `historyAsOfDate`-aware from the prior "Same-Week History" fix) supplies every target's real weekly exposure, rolling exposure, exercise history, and recent-badminton signal.
   - `exerciseSelector.exercisesTrainingTarget` / `roleFor` supply the valid exercise library and Blueprint's own primary/secondary role per (target, exercise).
   - `developmentPackages.lookupExercisePrescriptionAnyLevel` / `parseRange` supply authoritative per-(target, exercise) prescriptions (sets/rep range/RIR range) with **no package-membership eligibility gating** — every valid exercise is listed regardless of package inclusion.
   - `recoveryEngine.applyRecoveryConstraint` supplies a real per-target recovery decision, evaluated as of the requested `targetDate` (not "today"), reusing the identical function `workoutBuilder.ts` itself calls.
   - `dailyActivity.applyWeekOverrides` / `deriveDailyActivity` supply the effective (override-applied) Gym/Badminton/Both/Unselected routine — the same resolution `GET /api/programming/week` uses.
   - Explicit lock/editability check: a `targetDate` that is in the past, or already has a `completed`/`in_progress` workout session, throws `AITargetNotEditableError` before any provider call is made.
   - Stable SHA-256 `contextHash` (key-order-independent, volatile fields excluded) so two requests against identical real state hash identically, while any genuine state change changes the hash.
   - `diagnostics.missingData`/`diagnostics.warnings`/`diagnostics.approxContextSizeChars` — missing/malformed data (e.g. a goal whose `blueprint_ref` no longer resolves) is recorded explicitly, never silently guessed.
3. **Velona provider adapter** (`provider/velonaProvider.ts`) — native `fetch`-based HTTP integration against `POST {VELONA_BASE_URL}/inference/run`, with:
   - Environment-only configuration (`VELONA_API_KEY`, `VELONA_BASE_URL`, `VELONA_MODEL`, `VELONA_TIMEOUT_MS`, `VELONA_MAX_RETRIES`) — the model is never hard-coded, and startup/request-time fails clearly if `VELONA_API_KEY`/`VELONA_MODEL` are missing.
   - `AbortController`-based timeout, never retried.
   - Bounded retry only for network errors, HTTP 408/429/5xx (respecting `Retry-After` on 429), with a hard `maxRetries` ceiling. Authentication failures and other 4xx responses are never retried.
   - Response normalization defensive against missing `data`/`data.output`/usage/billing metadata, and a structured-vs-string `data.output`.
   - `safeLogFields()` helper proves no secret ever needs to appear in a log line.
4. **Provider-independent service** (`service/aiProgrammerService.ts`) — `AIProgrammerService.generateSession()`: checks `AI_PROGRAMMER_ENABLED` first (short-circuits before building any context or making any provider call when disabled), builds context, calls the provider with a fixed, versioned system instruction, parses JSON, runs structural then domain validation, and returns a validated proposal only.
5. **Structured output parsing and validation** — two independent layers exactly as spec §10 requires:
   - **Schema** (`validation/programmerOutputValidator.ts`): required fields, types, enums, numeric ranges, rejects unknown/dangerous string content (script/SQL-like patterns), enforces the declared schema version.
   - **Domain** (`validation/programmerDomainValidator.ts`): every `exerciseId` must resolve via `BlueprintAdapter.isKnownExercise` (Blueprint-only this milestone — no outside-Blueprint exercise is ever silently approved); every `targetId` must resolve to the declared `targetType` and be present in the request's own context; the exercise must actually train that target (`roleFor !== 'none'`, checked via the target's own `validExercises` catalogue); a declared `primary`/`secondary` role must match Blueprint's own resolution; `sets` must not exceed the authored per-(target, exercise) cap when one exists, or a documented application-level ceiling (6) otherwise; `repsMax`/`rirMax`/`restSeconds` are bounded by generic safety ceilings; no duplicate exercises; the target date must still be editable at validation time (a fresh DB re-check, guarding the race where a session was completed between context-build and validation).
6. **Non-destructive generation endpoint** — `POST /api/ai-programmer/generate-session` returns `{ok, proposal, contextHash, provider, model, requestId}` on success, or a structured `{ok:false, error, message, details}` on any typed failure. It never writes to `workout_sessions`, `program_sessions`, or any other table — the second endpoint spec §12 explicitly defers (`commit-session-proposal`) was **not** implemented, matching "for this task, implementing only the first endpoint is acceptable and preferred."
7. **Tests with mocked provider responses** — 69 new tests across 6 files, none requiring a real Velona API key (global `fetch` is mocked with `vi.stubGlobal` where a provider call happens).
8. **Environment/configuration documentation** — `docs/AI_PROGRAMMER_INTEGRATION_STATUS.md` (env vars, enable/disable, endpoint examples, error-code table, troubleshooting, security notes) plus README pointers.
9. **Clear audit logging without exposing secrets** — `safeLogFields()` in the provider module, and every error's `details` field carries only structured, safe diagnostic data (validation issue lists) — never a raw provider payload, header, or credential. (A dedicated persistent audit-log table was judged out of scope for a proposal-only, non-persisting milestone — see §5 below.)

## 3. Non-negotiable programming rules — how each is enforced

| Rule (spec §16) | Enforcement point |
|---|---|
| Aesthetics primary; athletic capability supporting | Stated in `objectives.priorityHierarchy` (context) and rule 1-2 of the fixed system instruction |
| Active growth goals get extra emphasis, ranking preserved | `activeGoals` sorted by real `priority`, never reordered (tested) |
| Maintenance remains part of the program | `context.targets` includes every Blueprint physique target, not only goal-linked ones (via `assembleWeeklyPlanInput`'s existing normal-development coverage) |
| Package references are not rigid quotas / package membership ≠ eligibility | `validExercises` is built from `exercisesTrainingTarget` (Blueprint-wide), never filtered by package inclusion |
| Valid Blueprint variation never rejected for coverage reasons | Same as above — no such rejection path exists |
| Authored prescriptions authoritative; never inflate sets | Domain validator caps `sets` at `authoredPrescription.sets` when present (tested) |
| Valid exercises may be legitimately omitted | Domain validator never requires every valid exercise to appear (tested: "accepts a proposal that omits...") |
| Equipment/time never filter ordinary generation | `executionContext.programmingFilteringAllowed: false`; equipment is informational-only in context; no filtering code exists |
| Actual completed training drives programming | `currentWeeklyPrimarySets`/`exerciseHistory` come from real logged, completed sets only (incomplete sets excluded — tested) |
| Missed sets create no automatic debt | No such mechanism exists in the context or validators |
| Completed/locked sessions immutable | Context builder refuses to build a context for a locked/past date at all; domain validator re-checks at validation time (tested both) |
| In-progress work preserved | Same lock check covers `in_progress` status |
| AI receives explicit full context | Every context section is self-contained; no provider memory session is used (Velona `turns` are stateless per request) |
| Provider memory never required for correctness | No conversation/session ID is ever sent to or expected from Velona |
| AI output validated before persistence | Two-layer validation runs before the endpoint ever returns a proposal; nothing is persisted regardless |
| Provider never writes directly to the database | The provider module has zero database imports |

## 4. Test and build results

```
npm run verify
  build:      tsc -p tsconfig.build.json  →  clean
  typecheck:  tsc --noEmit                →  clean
  test:       vitest run                  →  90 test files, 871 tests, all passing
```

Breakdown of the new suite (`tests/ai-programmer/`):

| File | Tests |
|---|---|
| `programmerContextBuilder.test.ts` | 13 |
| `velonaProvider.test.ts` | 13 |
| `programmerOutputValidator.test.ts` | 13 |
| `programmerDomainValidator.test.ts` | 13 |
| `aiProgrammerService.test.ts` | 9 |
| `aiProgrammerRoute.test.ts` | 8 |
| **Total new** | **69** |

All 84 pre-existing test files (802 tests) continue to pass unchanged — this milestone touched no existing engine, route, or repository file except `src/server/app.ts` (one new router registration line).

### Live HTTP smoke test

A standalone script drove the real Express app (`createApp`) through real HTTP requests via `supertest`, against a disposable scratch SQLite file (never production data), with a stubbed global `fetch` standing in for Velona:

1. `AI_PROGRAMMER_ENABLED` unset → `503 AI_PROGRAMMER_DISABLED`, provider never called.
2. Enabled + mocked Velona response → `200`, a validated 2-exercise proposal (`incline-barbell-press`/upper-pec, `cable-fly`/mid-pec) matching the mocked model output exactly, with real `provider`/`model`/`contextHash`/`requestId` fields.
3. `workout_sessions` count unchanged after generation (still exactly the one real session the script itself logged) — no persistence occurred.
4. Requesting the already-completed date → `409 AI_TARGET_NOT_EDITABLE`, provider never called.
5. No response body anywhere contained the (fake) configured API key.

All 7 checks passed.

## 5. Remaining limitations (explicitly out of scope for this milestone, per spec §3/§18)

- **No commit/persistence endpoint.** `POST /api/ai-programmer/commit-session-proposal` (spec §12's suggested second endpoint) does not exist. A proposal is never written to `program_sessions`/`workout_sessions`.
- **No full-week generation or reconciliation.** Only a single `generate_session` proposal for one explicit `targetDate`.
- **No replacement of the deterministic engine.** `src/engine/workoutBuilder.ts` and every existing `/api/programming/*` route are completely untouched and remain the sole authority for the app's actual generated program.
- **Outside-Blueprint exercises are never accepted** in an AI proposal, even if separately approved via the existing `OutsideBlueprintExercisesRepo` — `source` must be exactly `"blueprint"`, and `BlueprintAdapter.isKnownExercise` is the only acceptance path.
- **No dedicated audit-log table.** Given nothing is persisted in this milestone, request/response audit data is not written to a durable store; `safeLogFields()` exists for whoever wires up application logging, and error `details` carry structured validation diagnostics, but there is no `ai_program_runs`-style table yet (`docs/AI_PROGRAMMER_IMPLEMENTATION_PLAN.md` §10.3's suggestion). This should be added alongside the future commit endpoint, where a persisted proposal genuinely needs an audit trail.
- **No streaming, no provider-side memory, no fine-tuning, no automatic exercise creation.** None of these were implemented, per spec's explicit non-goals.
- **Model quality/benchmarking not performed.** `VELONA_MODEL` has no default and must be explicitly configured; no model has been benchmarked or chosen — that is future work per `docs/VELONA_PROVIDER_INTEGRATION_SPEC.md` §14.
- **Context size is not yet empirically budgeted.** `validExercises` is included in full for every target `assembleWeeklyPlanInput` returns (effectively every Blueprint physique target plus any goal-linked functional goals), which can produce a sizable context on a Blueprint snapshot with many targets. `diagnostics.approxContextSizeChars` is reported and a soft warning threshold (200,000 chars) exists, but no token-based measurement against a real Velona model has been performed yet, and no compaction strategy is implemented beyond that warning.
- **`AIWorkoutExerciseProposal.role` validation is deliberately lenient for non-Blueprint-binary roles.** Only `primary`/`secondary` are cross-checked against Blueprint's own `roleFor` resolution; `accessory`/`isolation`/`conditioning` are accepted for any exercise that trains the target at all (primary or secondary), since Blueprint's own taxonomy has no equivalent finer categories to validate against.

## 6. Architectural decisions and deviations from the supporting docs

The supporting docs (`AI_PROGRAMMER_CONTEXT_SPEC.md`, `AI_PROGRAMMER_OUTPUT_SCHEMA.md`, `AI_PROGRAMMER_IMPLEMENTATION_PLAN.md`, `AI_PROGRAMMER_INTEGRATION_AUDIT.md`) describe a much larger eventual system — full week Generate/Reconcile, a multi-day `Programme`/`Day`/`Reconciliation` output contract, OpenRouter-style provider comparisons, and eventual retirement of the deterministic engine. `CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md` is explicit that this task is a narrower first slice, and where the two disagreed, the task file governed:

1. **Output contract**: implemented the task's narrow `AIWorkoutSessionProposal`/`AIWorkoutExerciseProposal` shape (§7), not the broader `Programme`/`Day`/`ExercisePrescription` schema from `AI_PROGRAMMER_OUTPUT_SCHEMA.md`. Blueprint has no separate "variation" concept distinct from exercise identity (confirmed by inspecting `src/blueprint/types.ts`'s `BlueprintExercise`), so no `variation_id` field was added — an exercise ID is already the atomic prescribable unit in this codebase.
2. **Provider scope**: implemented one provider-independent interface (`contracts/providerTypes.ts`) matching the task's §8 shape, informed by (not copied from) `VELONA_PROVIDER_INTEGRATION_SPEC.md`'s concrete endpoint/request/response mapping (§4, §6-§7) for the actual `VelonaProvider` implementation. The Velona spec's own separate `AIProgramRequest`/`AIProviderResult` types were not introduced as a second parallel interface — that would have created exactly the "two competing programmer contracts" the audit doc itself warns against.
3. **Validation library**: no schema-validation library (Zod, per `AI_PROGRAMMER_SCHEMA_IMPLEMENTATION.md` §3) was added. This repository has no existing validation library, and every other route in `src/server/routes/*.ts` validates external input by hand (`typeof`/`Array.isArray` checks). Adding a new dependency for a first vertical slice, when the codebase's own established convention already covers untrusted-external-data validation adequately, was judged unnecessary; `programmerOutputValidator.ts` follows that same hand-written convention.
4. **Reused the deterministic engine's own data-gathering, not its decisions.** `assembleWeeklyPlanInput` was called for its already-computed per-target exposure/history/recovery-input facts (exactly as the task instructs: "reuse existing code... avoid duplicating workload/exposure calculations"), but its actual exercise *selection* (`buildWeeklyProgrammingPlan`) was never called — the AI is handed the full valid-exercise catalogue per target and decides selection itself, preserving the task's "AI decides... exercise selection" boundary.
5. **`historyAsOfDate` semantics inherited unchanged.** Per the prior phase's "Same-Week History & Day-Specific Recovery Fix," `current_weekly_primary_sets`/etc. reflect the calendar week containing the *real current date*, not necessarily the week containing a future `targetDate`. This is the existing, already-correct application behavior (identical to what `/api/programming/week` does for a future week query) and was preserved rather than redesigned.
6. **Lock check duplicated intentionally (not a code-reuse violation).** `weekProgramReconciliation.ts`'s `isDayLocked` is a private, unexported one-line predicate; the context builder and domain validator each independently apply the identical rule (`status === 'completed' || 'in_progress'`) via `WorkoutSessionsRepo`, since importing a private function wasn't possible and extracting/exporting it was judged out of scope for this milestone (it would touch the deterministic reconciliation module, which spec explicitly says not to modify here).

## 7. Acceptance criteria checklist (spec §18)

- [x] AI programmer provider interface exists (`contracts/providerTypes.ts`).
- [x] Velona provider implementation exists (`provider/velonaProvider.ts`).
- [x] Provider configuration is environment-based (`provider/config.ts`).
- [x] Context builder reads real repository/Blueprint data.
- [x] Context is self-contained, no provider-memory dependency.
- [x] Context includes actual history and immutable program state.
- [x] AI output has a strict schema.
- [x] AI output passes domain validation before being returned.
- [x] Unknown/fabricated exercises are rejected.
- [x] Authored Blueprint caps are enforced.
- [x] Completed/locked sessions cannot be targeted for modification.
- [x] A generation endpoint exists.
- [x] The endpoint works with a mocked provider (route tests + live smoke test).
- [x] Provider failures are handled safely.
- [x] No credentials appear in logs or source (tested).
- [x] Tests cover the critical safety and Blueprint-fidelity rules.
- [x] `npm run verify` passes.

## 8. Not committed/deployed

Per this session's established convention: this work has been committed and pushed to a new branch, `ai-programmer-first-vertical-slice`, off `main`. It has not been merged to `main` and nothing has been deployed — both remain explicit follow-up actions for the user to request.
