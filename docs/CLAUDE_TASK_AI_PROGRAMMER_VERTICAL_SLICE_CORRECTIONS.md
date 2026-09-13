# AI Programmer First Vertical Slice — Correction Pass

## Purpose

This task is a focused correction and verification pass for the already-implemented AI Programmer first vertical slice.

The existing architecture is accepted. **Do not rewrite the implementation or replace the deterministic programming engine.** Fix the correctness gaps identified during review, add the required regression tests, and independently verify the final state from a clean install.

This task is specifically about:

1. Full enforcement of Blueprint-authored prescriptions.
2. Strict calendar-date validation.
3. Cross-validation of the proposal's target date and weekday.
4. Clarification and correction of timezone semantics.
5. Safer bounds on validation diagnostics.
6. Proposal ID ownership.
7. Clean verification and reporting.

---

# 1. Repository and implementation context

The current implementation contains an AI Programmer proposal-only vertical slice with approximately this flow:

```text
POST /api/ai-programmer/generate-session
        ↓
AIProgrammerService
        ↓
Context builder
        ↓
Velona provider
        ↓
Structural validation
        ↓
Blueprint/domain validation
        ↓
Validated proposal response
```

The implementation must continue to:

- Reuse the existing deterministic programming engine.
- Reuse existing repositories and Blueprint adapter logic.
- Keep the provider isolated behind a provider interface.
- Keep the provider database-independent.
- Keep the first slice proposal-only.
- Avoid automatically persisting or committing AI-generated workouts.
- Treat Blueprint data as authoritative.
- Preserve completed and in-progress session protection.
- Avoid treating package membership as a rigid exercise-selection quota.
- Avoid adding outside-Blueprint exercises in this task.

Use the actual repository snapshot as the source of truth when file names or implementation details differ from this document.

---

# 2. P0 — Enforce full authored prescription fidelity

## Problem

The current implementation appears to expose authored prescription data in context and enforce an authored set cap, but it does not fully enforce all authored prescription fields.

The intended rule is:

> When an exercise has an authored prescription, its sets, repsMin, repsMax, rirMin, and rirMax are authoritative.

A model must not alter those values merely because its generated values remain within broad global limits.

## Required behavior

For an exercise with an authored prescription, validate all of the following:

- `sets`
- `repsMin`
- `repsMax`
- `rirMin`
- `rirMax`

The returned values must match the authored Blueprint prescription exactly unless the existing specification explicitly defines a different permitted transformation.

Do not silently convert exact authored values into only upper bounds.

### Example

If Blueprint contains:

```json
{
  "sets": 3,
  "repsMin": 8,
  "repsMax": 12,
  "rirMin": 1,
  "rirMax": 3
}
```

Then this must be rejected:

```json
{
  "sets": 3,
  "repsMin": 3,
  "repsMax": 5,
  "rirMin": 0,
  "rirMax": 1
}
```

It must also be rejected if only one field differs, for example:

```json
{
  "sets": 2,
  "repsMin": 8,
  "repsMax": 12,
  "rirMin": 1,
  "rirMax": 3
}
```

## Implementation guidance

Locate the existing domain validator and its Blueprint catalogue/prescription lookup.

Add a dedicated helper if useful, for example:

```ts
validateAuthoredPrescription(
  generatedExercise,
  authoredPrescription,
  path
)
```

The helper should produce precise validation issues identifying:

- the generated field
- the expected authored value
- the received value

Example issue:

```text
exercises[0].sets must equal Blueprint-authored value 3; received 2
```

Do not weaken the global validation rules. Authored prescription validation should operate in addition to the global safety limits.

## Required tests

Add regression tests for an exercise with an authored prescription:

- exact authored values are accepted
- altered `sets` are rejected
- altered `repsMin` are rejected
- altered `repsMax` are rejected
- altered `rirMin` are rejected
- altered `rirMax` are rejected
- multiple altered fields produce appropriate validation issues
- an exercise without an authored prescription still follows the existing non-authored rules

---

# 3. P0 — Strict calendar-date validation

## Problem

The current route appears to validate the requested date using a pattern similar to:

```ts
/^\d{4}-\d{2}-\d{2}$/
```

This validates formatting but not whether the date exists.

Invalid dates such as `2026-02-31` could pass and potentially be normalized by JavaScript date handling into another real date.

That must not happen.

## Required behavior

The request's `targetDate` must be:

- exactly formatted as `YYYY-MM-DD`
- a real calendar date
- valid for the specified month
- valid for leap-year rules

Reject invalid dates with a client error, preferably HTTP `400`.

Examples that must be rejected:

```text
2026-02-29
2026-02-31
2026-04-31
2026-13-01
2026-00-10
2026-1-01
26-01-01
```

Examples that must be accepted:

```text
2026-02-28
2026-03-01
2028-02-29
```

## Implementation guidance

Create a strict date helper rather than relying only on `new Date(value)`.

A UTC-based implementation is acceptable if it verifies round-trip equality:

```ts
function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
```

Adapt this to the project's existing date utilities if an equivalent helper already exists. Avoid introducing multiple competing date-validation implementations.

## Required tests

Add tests for:

- valid ordinary date
- valid leap-day date
- invalid non-leap-year February 29
- invalid February 31
- invalid April 31
- invalid month 00
- invalid month 13
- invalid day 00
- invalid day 32
- malformed date strings

---

# 4. P0 — Cross-validate proposal date and weekday

## Problem

The AI output includes both:

- `targetDate`
- `weekday`

The model could return a weekday that does not correspond to the requested date.

Prompt instructions alone are insufficient for this integrity check.

## Required behavior

After structural validation and before returning the proposal, enforce:

1. The proposal's `targetDate` equals the requested `targetDate`.
2. The proposal's `weekday` equals the weekday derived from the requested date.
3. If the context contains an authoritative target weekday, the proposal's weekday equals that context value.
4. The proposal cannot substitute another date.

Examples that must be rejected:

```json
{
  "targetDate": "2026-09-20",
  "weekday": "monday"
}
```

if the actual requested date is Sunday.

Also reject:

```json
{
  "targetDate": "2026-09-21",
  "weekday": "sunday"
}
```

when the request was for September 20.

## Implementation guidance

Use the existing project date/weekday helper rather than adding a second weekday algorithm.

Validate at the domain/service boundary after parsing the provider output.

Error messages should identify the mismatch, for example:

```text
targetDate must equal requested target date 2026-09-20; received 2026-09-21
weekday must equal the weekday derived from targetDate; expected sunday, received monday
```

## Required tests

Add tests for:

- exact target date accepted
- altered target date rejected
- correct weekday accepted
- incorrect weekday rejected
- date and weekday mismatch rejected even when both fields are individually valid
- requested date at week boundaries

---

# 5. P1 — Resolve timezone override semantics

## Problem

The route/context appears to permit a timezone override while some date-sensitive calculations continue to use the user's stored profile timezone.

That can produce internally inconsistent context.

For example:

- current date calculated in profile timezone
- context timezone reported as a request override
- weekday or editability interpreted under different timezone assumptions

## Preferred solution

For this application, prefer the simplest safe behavior:

### Option A — Recommended

Do not allow a request-level timezone override.

Use the user's stored training-profile timezone as the authoritative timezone for:

- current-date calculation
- target-date interpretation
- weekday calculation
- editability checks
- context output
- proposal validation

If the request currently accepts `timezone`, either remove it from the public request schema or reject it clearly.

### Option B — Only if the product genuinely requires overrides

If a request-level timezone override must remain:

- validate it as a real IANA timezone
- use it consistently for every date-sensitive operation in that request
- document that it is authoritative for the request
- ensure `todayForUser`, weekday calculation, editability, and context construction all use the same timezone
- add tests around date boundaries

Do not retain a timezone override that only changes a displayed context field.

## Required tests

Depending on the selected design:

- stored profile timezone is used consistently
- invalid timezone is rejected
- timezone override behavior is explicitly tested if supported
- current-date/editability and context timezone cannot disagree

Document the chosen behavior in the API documentation.

---

# 6. P1 — Bound validation diagnostics

## Problem

Validation errors may include model-generated values or strings. Even though the raw provider payload is not returned, arbitrary model content could still create oversized error responses or noisy logs.

## Required behavior

Add defensive limits to validation diagnostics:

- maximum number of returned issues
- maximum length of an individual issue
- maximum total diagnostic payload
- no API keys, authorization headers, or raw provider payloads in errors
- no unbounded echoing of arbitrary model-generated strings

Suggested limits:

```text
Maximum issues: 20
Maximum characters per issue: 500
Maximum total diagnostic characters: 8,000
```

Use constants so the limits are visible and testable.

If truncation occurs, make it explicit, for example:

```text
[truncated]
```

Do not change the underlying validation result merely because diagnostics are truncated.

## Required tests

Add tests for:

- oversized rationale/string values
- many validation issues
- long malformed field values
- diagnostics remain bounded
- raw provider payload is not exposed
- secrets are not included in response or logs

---

# 7. P1 — Make proposal ID application-owned

## Problem

The provider currently appears to return `proposalId`. A model-controlled identifier is not ideal for future proposal tracking or commit workflows.

The model could return the same ID repeatedly or return an excessively long/unusual value.

## Preferred behavior

The application should generate the authoritative proposal ID.

Recommended approach:

1. Remove `proposalId` from the model-required output if practical.
2. Generate it in the application using the project's existing UUID/request-ID utility.
3. Add it to the validated proposal after provider validation.
4. Return only the application-generated value.

If compatibility requires the provider to return a `proposalId`, validate it if present but overwrite it with an application-generated ID before returning the response.

Do not use a model-generated ID as a future persistence or commit identity.

## Required tests

- returned proposal ID is generated by the application
- provider cannot force a duplicate proposal ID
- excessively long provider IDs do not affect the final response
- proposal IDs are unique across two successful requests, subject to the project's UUID guarantees

---

# 8. Clean verification requirements

After implementing the fixes, perform verification from a clean dependency state.

Run:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run verify
```

If the project does not define one of these scripts, report that explicitly and run the closest equivalent.

Also run the relevant focused tests separately, for example:

```bash
npm test -- context
npm test -- validator
npm test -- route
npm test -- provider
```

Use the actual test runner syntax supported by the repository.

## Verify repository state

Report:

```bash
git status
git rev-parse HEAD
git log -1 --oneline
```

Confirm:

- the archive/current checkout contains the tested changes
- no uncommitted required changes are omitted
- generated files are not accidentally missing
- package-lock changes, if any, are intentional
- all tests ran against the final implementation

Do not report “verification passed” unless the commands actually completed successfully.

---

# 9. Scope boundaries — do not expand this task

Do not implement the following in this correction pass:

- automatic persistence of AI-generated workouts
- automatic program mutation
- commit/approval workflow
- provider memory
- outside-Blueprint exercise generation
- a second independent workout-programming engine
- broad refactoring unrelated to the listed issues
- UI redesign
- production deployment changes unrelated to verification
- replacement of Velona with another provider

Those should remain separate milestones.

---

# 10. Required final report from the developer

When complete, report:

## Implementation

- files changed
- what was changed in each file
- authored prescription enforcement approach
- strict date validation approach
- proposal date/weekday cross-validation approach
- timezone decision
- diagnostic bounds
- proposal ID ownership decision

## Verification

Include exact results for:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run verify
```

Also include focused test results.

## Remaining issues

Clearly list:

- anything not completed
- any test that could not run
- any environment limitation
- any deviation from this task
- any known follow-up work

Do not simply state “implemented successfully.” Provide concrete evidence.

---

# Acceptance criteria

This correction pass is accepted only when all of the following are true:

- [ ] Authored `sets` are enforced exactly.
- [ ] Authored `repsMin` are enforced exactly.
- [ ] Authored `repsMax` are enforced exactly.
- [ ] Authored `rirMin` are enforced exactly.
- [ ] Authored `rirMax` are enforced exactly.
- [ ] Invalid calendar dates are rejected.
- [ ] Proposal `targetDate` must equal the requested date.
- [ ] Proposal `weekday` must match the requested date.
- [ ] Timezone behavior is consistent and documented.
- [ ] Validation diagnostics are bounded.
- [ ] Proposal ID is application-owned or safely overwritten.
- [ ] Regression tests cover all corrected behaviors.
- [ ] Clean verification commands are run and their actual results are reported.
- [ ] No automatic persistence or deterministic-engine rewrite was introduced.
