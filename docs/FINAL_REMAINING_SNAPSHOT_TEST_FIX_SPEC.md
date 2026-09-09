# Final Remaining Fix — Correct the Broken Snapshot Persistence Test

## Objective

Fix the remaining test-quality issue identified in the latest repository review.

The test in:

```text
tests/routes/weekProgramPersistence.test.ts
```

currently contains an assertion equivalent to:

```ts
const snapshotsAfterFirst = repo
  .getByWeekStart(weekStart)!
  .sessions
  .map((s) => s.snapshot);

expect(snapshotsAfterFirst).toEqual(snapshotsAfterFirst);
```

This compares a value with itself and therefore can never fail.

The test comment claims that full JSON snapshots remain byte-identical across repeated reads, but the current assertion does not actually verify that.

Fix the test so it compares the first captured snapshots against snapshots captured after the repeated GET/read operations.

---

# Required Fix

## 1. Capture the first snapshot state

Immediately after the first relevant GET/read operation, capture the session snapshots:

```ts
const snapshotsAfterFirst = repo
  .getByWeekStart(weekStart)!
  .sessions
  .map((s) => s.snapshot);
```

Preserve this value.

---

## 2. Perform the repeated read operations

Run the same repeated GET/read operations that the test is intended to verify.

Do not remove or weaken those operations.

The purpose is to confirm that repeated reads do not mutate the persisted program/session snapshots.

---

## 3. Capture the second snapshot state

After the repeated GET/read operations, retrieve the persisted session data again:

```ts
const snapshotsAfterRepeatedGets = repo
  .getByWeekStart(weekStart)!
  .sessions
  .map((s) => s.snapshot);
```

Use a separate variable.

---

## 4. Compare the two states

Replace the self-comparison:

```ts
expect(snapshotsAfterFirst).toEqual(snapshotsAfterFirst);
```

with:

```ts
expect(snapshotsAfterRepeatedGets).toEqual(snapshotsAfterFirst);
```

The exact variable names may differ if the surrounding test structure makes another naming scheme clearer, but the semantic requirement is mandatory:

> **Compare snapshots captured before and after repeated reads.**

---

# Important: Do Not Broaden This Task

This is a **test correction only**.

Do NOT change:

- workout-programming logic
- exercise selection
- equipment behavior
- candidate selection
- Efficient/Complete package behavior
- goal programming
- direct/indirect exposure logic
- rolling exposure/recovery logic
- session notes
- Copy functionality
- friendly explanations
- database schema
- production data
- historical workouts
- goals

Do not refactor unrelated code.

---

# Preserve the Test's Original Intent

The corrected test should continue verifying that repeated GET/read operations do not mutate:

- session IDs
- persisted session data
- full JSON snapshots

If the test has separate assertions for session IDs or other persisted state, leave them intact.

Only repair the broken self-comparison.

---

# Verification

Run the project's normal test/verification commands.

At minimum, where supported:

```text
npm run typecheck
npm test
npm run build
npm run verify
```

Use the project's actual scripts if the names differ.

The final report must state:

```text
Typecheck: PASS/FAIL
Tests: X passed / Y failed / Z skipped
Build: PASS/FAIL
Verify: PASS/FAIL
```

Also explicitly state that the corrected snapshot assertion now compares:

```text
before repeated reads
        VS
after repeated reads
```

and is no longer a self-comparison.

---

# Production Safety

Do NOT:

- reset SQLite
- delete any data
- modify workout history
- regenerate workouts
- modify goals
- modify Blueprint data
- change package contents
- change nginx/systemd configuration

This task should result in a small test-only diff.

---

# Final Report

Provide:

## Changed File

```text
tests/routes/weekProgramPersistence.test.ts
```

## Change

Explain the old self-comparison and the new before/after comparison.

## Verification

Provide actual test/typecheck/build/verify results.

## Scope

Confirm that no application or production behavior was changed.
