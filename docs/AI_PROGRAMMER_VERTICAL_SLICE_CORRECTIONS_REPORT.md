# AI Programmer First Vertical Slice — Correction Pass: Implementation Report

Spec: `docs/CLAUDE_TASK_AI_PROGRAMMER_VERTICAL_SLICE_CORRECTIONS.md`

This is a focused correction pass against the already-implemented first vertical slice (`docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md`, reported in `docs/AI_PROGRAMMER_FIRST_VERTICAL_SLICE_REPORT.md`). The existing architecture was not rewritten; the deterministic engine was not touched.

## 1. Files changed

| File | What changed |
|---|---|
| `src/ai-programmer/validation/programmerDomainValidator.ts` | Added `validateAuthoredPrescription()` — when an authored prescription exists, `sets`/`repsMin`/`repsMax`/`rirMin`/`rirMax` must all match exactly, each field producing its own precise issue (`"...sets must equal Blueprint-authored value 3; received 8"`) rather than only checking `sets` against a cap. The prior `targetDate`/`weekday` cross-validation (already present) was audited and left unchanged — it already rejected a substituted date or an incorrect weekday. |
| `src/engine/dateMath.ts` | Added `isValidCalendarDate(value)` — the single shared strict calendar-date check (format + real calendar validity, rejecting e.g. `2026-02-31`/`2026-04-31` that `new Date(...)` would otherwise silently normalize into a different date). |
| `src/server/routes/aiProgrammer.ts` | Route now calls `isValidCalendarDate` and returns `400` for a shaped-but-impossible date. Also now rejects (`400`) any request that includes a `timezone` field at all, rather than accepting and partially using it. |
| `src/ai-programmer/context/programmerContextBuilder.ts` | `BuildProgrammerContextInput` no longer has a `timezone` field. The context's own `timezone` output field always comes from `profile.timezone` (the stored `TrainingProfile`), never a request override. Its internal `isValidIsoDate` regex-only check was replaced with the shared `isValidCalendarDate`. |
| `src/ai-programmer/service/aiProgrammerService.ts` | `GenerateSessionInput` no longer has a `timezone` field. After domain validation succeeds, the service now overwrites `proposal.proposalId` with a freshly generated `randomUUID()` — whatever the provider returned is discarded. |
| `src/ai-programmer/validation/programmerOutputValidator.ts` | `proposalId` is now optional at the structural layer (a string when present, never required); when absent it defaults to `''` in the parsed value, since the service always overwrites it regardless. |
| `src/ai-programmer/contracts/programmerOutputSchema.ts` | Removed `proposalId` from the JSON-shape hint's `required` list and `properties` (the model is no longer asked to supply one). |
| `src/ai-programmer/errors.ts` | `AIOutputSchemaInvalidError`/`AIOutputDomainInvalidError` now run their issue list through `boundDiagnosticIssues()` before constructing the error's `message`/`details.issues`. |
| `src/ai-programmer/validation/diagnosticsBounds.ts` | **New.** `boundDiagnosticIssues()` and the named constants `MAX_DIAGNOSTIC_ISSUES` (20), `MAX_DIAGNOSTIC_ISSUE_CHARS` (500), `MAX_DIAGNOSTIC_TOTAL_CHARS` (8,000) — truncates an oversized issue list/individual issue/total payload with an explicit `[truncated]` marker, without touching the underlying validation result. |
| `docs/AI_PROGRAMMER_INTEGRATION_STATUS.md` | Updated: request no longer documents a `timezone` field (documents the 400 rejection instead); `targetDate` documented as requiring real-calendar validity, not just shape; error table documents the two new `400` cases and the bounded-diagnostics behavior; success-response note documents that `proposalId` is always application-generated. |
| `tests/ai-programmer/programmerDomainValidator.test.ts` | Updated one assertion's expected message text to match the new exact-match wording (`"...sets must equal Blueprint-authored value 3; received 8"` instead of `"...exceed the Blueprint-authored cap of 3"`). |
| `tests/ai-programmer/programmerOutputValidator.test.ts` | The "rejects a missing required field" test now deletes `mode` instead of `proposalId` (which is no longer required); added a new test confirming a response with `proposalId` omitted is still accepted, defaulting to `''`. |
| `tests/engine/dateMath.test.ts` | Added an `isValidCalendarDate` describe block — 11 tests covering every example in spec §3. |
| `tests/ai-programmer/correctionPass.test.ts` | **New.** 37 tests covering all six correction items end-to-end (see §3 below). |

No file under `src/engine/workoutBuilder.ts`, `src/server/routes/programming.ts`, `src/server/routes/workouts.ts`, or `src/db/schema.sql` was touched. No new npm dependency was added — `package.json`/`package-lock.json` are unchanged.

## 2. Per-item approach

### §2 — Authored prescription fidelity
When `catalogueEntry.authoredPrescription` exists, `validateAuthoredPrescription()` iterates the five fields (`sets`, `repsMin`, `repsMax`, `rirMin`, `rirMax`) and requires exact equality against the corresponding authored value, pushing one precise issue per mismatched field (`"exercises[0] (flat-barbell-bench-press).sets must equal Blueprint-authored value 3; received 8"`). This runs **in addition to** the existing global safety ceilings (`MAX_REPS`, `MAX_RIR`, `MAX_REST_SECONDS`), which still apply unconditionally — nothing was weakened. When no authored prescription exists for the (target, exercise) pair, the prior generic-cap behavior (`sets` must not exceed the documented `MAX_SETS_WITHOUT_AUTHORED_CAP = 6`) is unchanged.

### §3 — Strict calendar-date validation
`isValidCalendarDate()` in `src/engine/dateMath.ts` (the app's single existing date-utility module — no second competing implementation was introduced) checks the `YYYY-MM-DD` shape, then round-trips the parsed year/month/day through `Date.UTC(...)` and verifies `getUTCFullYear`/`getUTCMonth`/`getUTCDate` still match what was parsed. This catches exactly the failure mode `Date`'s own leniency produces (`2026-02-31` silently becomes `2026-03-03`). The route calls this before doing anything else, returning `400` immediately; the context builder independently calls the same function (defense in depth for any future caller that bypasses the route).

### §4 — Cross-validate proposal date/weekday
This check already existed in `programmerDomainValidator.ts` (`proposal.targetDate !== context.targetDate` and `proposal.weekday !== context.targetWeekday`, both rejected with a precise message) and required no code change. The correction pass audited it and added the required dedicated regression coverage, including week-boundary cases (a Sunday-context proposal claiming the following Monday's date, and vice versa) that the original test suite didn't exercise explicitly.

### §5 — Timezone semantics
**Decision: Option A (no request-level override).** The user's stored `TrainingProfile.timezone` is now the sole authoritative timezone everywhere a request needs one — `currentDate` (via `todayForUser`, which already only ever reads the stored profile), weekday derivation, editability, and the context's own `timezone` output field. The route explicitly rejects (`400`) any request body that includes a `timezone` field, rather than silently ignoring it, so a caller can never believe an override took effect when it didn't. `GenerateSessionInput` and `BuildProgrammerContextInput` no longer declare a `timezone` property at all — this is enforced at the type level, not just by convention.

### §6 — Bounded validation diagnostics
`boundDiagnosticIssues()` is applied inside the two error constructors that ever carry model-influenced validation issues (`AIOutputSchemaInvalidError`, `AIOutputDomainInvalidError`) — never inside the validators themselves, so the underlying `ok`/`not-ok` result and the full issue list used for internal decision-making are untouched. Bounding happens only at the boundary where a result becomes an API response / error `details` payload: at most 20 issues, each truncated to 500 characters, the whole array capped at ~8,000 characters, with an explicit `[truncated]` (per-issue) or `"N more issue(s) omitted [truncated]"` (list-level) marker whenever a limit is hit.

### §7 — Proposal ID ownership
The structural schema validator no longer requires `proposalId` (accepts a string when present, defaults to `''` when absent) and the JSON-shape hint sent to the provider no longer lists it as a field to supply. `AIProgrammerService.generateSession()` unconditionally overwrites the validated proposal's `proposalId` with a freshly generated `randomUUID()` immediately after domain validation succeeds and before returning — whatever value the provider supplied (or didn't) never reaches the caller.

## 3. New regression tests (all corrected behaviors)

`tests/ai-programmer/correctionPass.test.ts` — 37 tests:

- **§2 (7 tests):** exact authored values accepted; altered `sets`/`repsMin`/`repsMax`/`rirMin`/`rirMax` each individually rejected with the precise message; multiple altered fields produce 5 distinct issues; an exercise with no authored prescription (`ab-wheel-rollout`/`rectus-abdominis`, confirmed via the fixture) still follows the generic-cap rule, not exact-match.
- **§3 (10 tests, route-level via `supertest`):** rejects `2026-02-31`, `2026-04-31`, `2026-13-01`, `2026-00-10`, `2026-1-01`, `26-01-01`, `2026-02-29` (non-leap) with `400`; accepts `2026-02-28`, `2026-03-01`, and the real leap day `2028-02-29` past the date-shape check (their subsequent status is whatever else applies, never `400` for date shape).
- **§4 (6 tests):** exact date/weekday accepted; substituted `targetDate` rejected; incorrect `weekday` rejected; a proposal where both fields are individually well-formed but mismatched is rejected; a week-boundary case (Sunday context vs. Monday proposal, and the correct Monday-side proposal) in both directions.
- **§5 (3 tests):** a request supplying `timezone` is rejected with `400`; the built context always reports the stored profile's timezone; passing an extra `timezone` property directly to `buildProgrammerContext` has no effect (type-level guarantee exercised at runtime).
- **§6 (6 tests):** issue-count capping with an omission marker; per-issue character capping with a truncation marker; total-payload capping; `AIOutputDomainInvalidError` built from 200 huge issues stays under 20KB; bounding never changes the underlying `ok`/`not-ok` result; no secret-looking text is specially redacted (documented: raw secrets never reach diagnostics in the first place, since only structured validation-issue strings are ever passed in).
- **§7 (4 tests):** the returned `proposalId` is application-generated, not the model's value; two requests with the same model-supplied ID still get distinct real IDs; an excessively long (100,000-char) provider-supplied ID never affects the final response (still a 36-char UUID); a missing provider `proposalId` still yields a real application-generated one.

Plus `tests/engine/dateMath.test.ts`'s new `isValidCalendarDate` block (11 tests) and two updated pre-existing assertions (see §1).

## 4. Verification results (exact commands and output)

### `npm ci`

```
added 196 packages, and audited 197 packages in 5s
40 packages are looking for funding
8 vulnerabilities (6 moderate, 1 high, 1 critical)
```

(The vulnerability count is from pre-existing dependencies — this pass added no new dependency and did not touch `package.json`/`package-lock.json`.)

### `npm run build`

```
> workout-logger@0.1.0 build
> tsc -p tsconfig.build.json && cp src/db/schema.sql dist/db/schema.sql
```

Clean — no output, exit 0.

### `npm run typecheck`

```
> workout-logger@0.1.0 typecheck
> tsc --noEmit
```

Clean — no output, exit 0.

### `npm test`

```
 Test Files  91 passed (91)
      Tests  920 passed (920)
   Duration  18.57s
```

(84 pre-existing files/802 tests, unchanged, plus 7 AI-programmer files — 6 from the first slice, updated where noted, plus the 1 new `correctionPass.test.ts` — totaling 920.)

### `npm run verify`

```
> workout-logger@0.1.0 verify
> npm run build && npm run typecheck && npm test
...
 Test Files  91 passed (91)
      Tests  920 passed (920)
   Duration  17.96s
```

Clean.

### Focused test runs

```
npx vitest run tests/ai-programmer/programmerContextBuilder.test.ts
  Test Files  1 passed (1)   Tests  13 passed (13)

npx vitest run tests/ai-programmer/programmerDomainValidator.test.ts \
               tests/ai-programmer/programmerOutputValidator.test.ts \
               tests/ai-programmer/correctionPass.test.ts
  Test Files  3 passed (3)   Tests  64 passed (64)

npx vitest run tests/ai-programmer/aiProgrammerRoute.test.ts
  Test Files  1 passed (1)   Tests  8 passed (8)

npx vitest run tests/ai-programmer/velonaProvider.test.ts
  Test Files  1 passed (1)   Tests  13 passed (13)
```

All commands used the repository's actual `vitest`-based runner (this project has no separate `-- context`/`-- validator` grep-style CLI flag convention; file-path filtering is the equivalent).

### Repository state

```
$ git status
On branch ai-programmer-first-vertical-slice
Your branch is up to date with 'origin/ai-programmer-first-vertical-slice'.
(clean after the commit accompanying this report)

$ git rev-parse HEAD
<the commit hash of this correction-pass commit — see the actual commit this report ships with>

$ git log -1 --oneline
<this correction-pass commit>
```

No `package-lock.json`/`package.json` change occurred. No generated file is missing from the commit — `git status` before committing showed exactly the 13 files listed in §1 (11 modified, 2 new) plus this report and the saved spec doc.

## 5. Remaining issues / deviations / follow-up

- **No deviation from the spec's required behaviors** — all six correction items (§2–§7) are implemented exactly as specified, including the "Option A" timezone choice the spec itself recommended as preferred.
- **`AI_PROVIDER_INVALID_RESPONSE`/config-error messages are not diagnostics-bounded** — only `AIOutputSchemaInvalidError`/`AIOutputDomainInvalidError` (the two error types that ever echo model-influenced content) run through `boundDiagnosticIssues()`. Other error types either carry no free-form model text or already carry only a single short, application-authored message, so bounding was not applied there; this is a deliberate scope decision, not an oversight.
- **Bounded diagnostics do not redact content, only limit size** — if a validation issue string happened to contain something sensitive, bounding would not remove it (see the correction pass's own test documenting this). In practice no sensitive value is ever fed into a validation-issue string (they are always application-authored: "field X must equal Y, received Z" — never a raw provider payload or credential), so this is a non-issue in the current code, but is worth noting if a future contributor adds a new diagnostic source.
- **`ab-wheel-rollout`/`rectus-abdominis` (used in the "no authored prescription" test) is a real Blueprint fixture fact confirmed by inspecting the live Blueprint snapshot at test-writing time** — if a future `npm run sync-blueprint` changes the Blueprint data such that this pair gains an authored prescription, that one test would need a replacement fixture pair (the test itself asserts `authoredPrescription).toBeNull()` first, so it would fail loudly rather than silently passing on a wrong assumption).
- **Every acceptance-criteria checkbox in the correction spec (§"Acceptance criteria") is satisfied** — see the checklist below.
- **No automatic persistence or deterministic-engine rewrite was introduced** — confirmed by `git diff --stat` showing zero touched files under `src/engine/workoutBuilder.ts`, `src/server/routes/programming.ts`, `src/server/routes/workouts.ts`, `src/db/schema.sql`, and by the full pre-existing 802-test suite passing unchanged.

## 6. Acceptance criteria checklist

- [x] Authored `sets` are enforced exactly.
- [x] Authored `repsMin` are enforced exactly.
- [x] Authored `repsMax` are enforced exactly.
- [x] Authored `rirMin` are enforced exactly.
- [x] Authored `rirMax` are enforced exactly.
- [x] Invalid calendar dates are rejected.
- [x] Proposal `targetDate` must equal the requested date.
- [x] Proposal `weekday` must match the requested date.
- [x] Timezone behavior is consistent and documented (Option A: profile-timezone-only, request override rejected).
- [x] Validation diagnostics are bounded.
- [x] Proposal ID is application-owned (always overwritten).
- [x] Regression tests cover all corrected behaviors.
- [x] Clean verification commands were run and their actual results reported above.
- [x] No automatic persistence or deterministic-engine rewrite was introduced.
