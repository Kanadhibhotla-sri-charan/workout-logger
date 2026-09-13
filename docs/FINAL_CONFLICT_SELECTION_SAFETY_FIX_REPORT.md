# Implementation Report — Final Conflict Selection Safety Fix

Spec: `docs/CLAUDE_TASK_FINAL_CONFLICT_SELECTION_SAFETY_FIX_FOR_DEV.md`.
Base commit: `9606ae8` (spec saved).

This is a small, focused correction to the immediately-prior phase's
resolver, per the spec's own scope note ("Do not rewrite unrelated
scheduling, AI generation, blueprint, or programming logic"). It changes
exactly one behavior: what `selectedPlannedWorkout` is during a
conflict.

---

## The bug

`resolveSelectedSession` already detected multiple active planned
sessions and populated `selectionConflict`, but it also returned
`mostRecent(plannedAi)` (or `mostRecent(plannedDeterministic)`) as
`selectedPlannedWorkout` at the same time. That let any consumer that
only checked `if (selectedPlannedWorkout)` — without also checking
`selectionConflict` — silently treat an arbitrary "most recently
created" candidate as the authoritative actionable workout.

## The fix

`src/engine/selectedSessionResolver.ts`'s two conflict branches (`plannedAi.length
> 1` and `plannedDeterministic.length > 1`) now return:

```ts
{ historicalSession: null, selectedPlannedWorkout: null, selectionConflict: buildConflict(sessions), source: 'conflict' }
```

`selectedPlannedWorkout` is `null` whenever `source === 'conflict'` —
structurally, not by convention: the two branches that produce
`source: 'conflict'` are the ONLY places that can set it, and they now
never populate `selectedPlannedWorkout`. `mostRecent()` remains in the
codebase exactly where the spec says it's fine to stay — the
`completed`/`in_progress` tie-break (an already-historical fact, not a
live selection decision) — and is no longer called anywhere in the
conflict path.

## A second leak found and fixed: the deterministic snapshot

Inspecting every consumer (per the spec's own instruction) surfaced a
second, related leak the spec's example didn't explicitly call out:
`programming.ts`'s `resolveGymDaySelection` computed
`combinedSession = historicalSession ?? selectedPlannedWorkout`, then
`showDeterministic = !!persistedSnapshot && !supersedes`. Once
`selectedPlannedWorkout` became `null` during a conflict, `combinedSession`
was also `null`, which made `supersedes` `false` — so on a day that
ALSO had a persisted deterministic `program_sessions` snapshot (the
common case: a deterministic prescription existed first, then two
conflicting AI sessions were layered on top of it), `showDeterministic`
would have flipped to `true` and silently shown the deterministic
`plannedWork` as if it were the valid, current plan — right next to the
very `selectionConflict` warning saying the day's real state is
unresolved. This is exactly the "route substitutes another session"
failure mode the spec's Section 4 forbids, just via `plannedWork`
instead of `selectedPlannedWorkout`.

**Fix:** `resolveGymDaySelection` now short-circuits
`showDeterministic` to `false` whenever `resolution.source === 'conflict'`,
regardless of whether a persisted snapshot exists. A conflicted day now
shows neither an arbitrary selected session NOR the deterministic
snapshot — only the conflict itself.

---

## Section 2 — Non-conflict behavior preserved

Every non-conflict case is unchanged, verified by the full pre-existing
resolver test suite continuing to pass without modification: no session
(`source: 'none'`), one deterministic planned session, one AI planned
session, AI-supersedes-deterministic, completed (historical), and
in-progress (historical). Only the two multi-session conflict branches
changed.

---

## Section 3 — Frontend: conflict responses cannot open a workout

**Already correct by construction, now doubly so.** `today.html`'s
`renderSessionStatus` already checked `selectionConflict` first, before
`historicalSession`/`selectedPlannedWorkout` (built in the immediately-
prior phase). That order alone was already sufficient to prevent opening
a workout during a conflict. This phase's resolver fix makes it
impossible even if that check were ever accidentally reordered:
`selectedPlannedWorkout` and `historicalSession` are now genuinely
`null` during a conflict, not just "correctly ignored" by a well-ordered
`if`. `public/program.html`'s day-modal conflict branch is the same
story — it already never referenced `day.plannedSession` in that
branch, and `day.plannedSession` (the backward-compat combined field) is
now also `null` during conflict, closing the same gap there.

**No frontend code changes were needed** — the frontend was already
written correctly against the intended contract; only the resolver was
violating it.

---

## Section 4 — API/route behavior

`/week` and `/today` both derive their response purely from
`renderWeekDays`, which reads `resolution.selectedPlannedWorkout`
directly — no separate substitution logic exists in either route, so
both automatically inherited the fix. Verified directly: both endpoints
now return `selectedPlannedWorkout: null` and an identical
`selectionConflict` object for a conflicted date (see the new/updated
integration tests below). No route was changed to turn this into an
HTTP error — consistent with the spec's instruction to keep rendering a
conflict state through the existing `200` response shape, unchanged from
the prior phase's design.

---

## Section 5 — Tests

**Resolver unit tests** (`tests/engine/selectedSessionResolver.test.ts`,
rewritten for the corrected contract):

- Item 9 ("multiple active AI planned sessions") now asserts
  `selectedPlannedWorkout: null` and `historicalSession: null` alongside
  the existing conflict/code/sessionIds/source assertions.
- Item 10 ("multiple active deterministic planned sessions") — same.
- Item 13 (previously "tie-breaking is used only within a conflicted
  tier to keep a read endpoint usable") is rewritten to assert the
  opposite of its old premise: `mostRecent()` must NOT populate
  `selectedPlannedWorkout` during a conflict.
- The row-order-independence fuzz test now asserts `selectedPlannedWorkout:
  null` and a stable conflict across every permutation, instead of
  asserting a specific "most recent" winner.
- All other cases (no session, one AI, one deterministic, AI-supersedes-
  deterministic, completed, in-progress) are unchanged and still pass,
  proving no regression to valid non-conflict behavior.

**Integration tests** (`tests/routes/actionableVsHistoricalIntegration.test.ts`):

- The existing "multiple active planned AI sessions... surface a
  selectionConflict" test is rewritten exactly per the spec's own
  suggested replacement: `selectedPlannedWorkout` is asserted `null` on
  both `/week` and `/today`, plus the new deterministic-snapshot-leak
  coverage (`plannedWork: []`, `plannedSession: null`, `historicalSession:
  null`, `/today`'s `exercises: []`) proving the second leak found above
  is also fixed.
- Fixed an unrelated pre-existing flakiness surfaced while re-running
  this test under a fresh `npm ci`: comparing `selectionConflict` between
  `/week` and `/today` with a blanket `toEqual` occasionally failed on
  `sessionIds` array ORDER (two independent `listSessionsByDate` queries
  for rows with an identical, null `start_time` have no guaranteed
  relative ordering between calls). Fixed by comparing `code`/`message`
  directly and `sessionIds` with both sides sorted — a correctness fix to
  the test's own assertion, not a resolver behavior change.

**Frontend checks** (`tests/frontend/todaySessionResolution.test.ts`,
this codebase's established static-markup/script-text testing pattern —
no browser/jsdom framework exists here, documented in the immediately-
prior phase's report):

- Existing "checks selectionConflict FIRST... no `/logger.html` link in
  that branch" test, re-verified passing.
- **New**: "the actionable branch opens the logger by the exact resolved
  session id, never a fallback" — proves the spec's explicit ask ("valid
  selected session opens by exact ID") directly, closing the one gap the
  existing test suite hadn't yet named explicitly.

**Logger-opening behavior**, per the spec's own fallback instruction
("if the logger is not directly testable through the current
integration harness, add the narrowest appropriate service/route test"):
the logger (`GET /api/workouts/:id`) is a plain by-id lookup with no
resolver logic of its own — it was never capable of "opening a
conflicting session automatically" in the first place, since nothing
ever calls it with an id during a conflict (frontend code inspected,
above; `selectedPlannedWorkout`/`historicalSession` are `null`, so no
`?session=` link is ever constructed). This is proven indirectly by the
frontend test above (no link is built) rather than by a logger-route
test asserting a rejection, since there is no id for the logger to
reject in the first place.

---

## Verification

**Canonical command:**

```bash
rm -rf node_modules
npm ci
npm run verify   # = npm run build && npm run typecheck && npm test
```

**Result:**

- Environment: this session's Linux container, Node `v22.22.2`, npm `10.9.7`.
- Date: 2026-09-13 (UTC).
- Result: **PASS** — `npm run build` clean, `npm run typecheck` clean,
  **102 test files, 1172 tests, all passing**, exit code 0.
- Lint: N/A, no `lint` script exists in `package.json` (unchanged from
  every prior phase's own finding).

**Targeted checks:**

```bash
npm test -- selectedSessionResolver          # 1 file, 20 tests, PASS
npm test -- actionableVsHistoricalIntegration # 1 file, 5 tests, PASS
npm test -- programming                       # 1 file, 17 tests, PASS
```

**Live manual smoke test** (scratch in-memory SQLite DB, real
`createApp(db)` server, not mocked):

1. Generated a real deterministic prescription for a Thursday.
2. Directly created TWO `planned`/`'ai'` sessions for that same date
   (simulating exactly the pre-existing bad-data state the spec
   describes).
3. `GET /week` for that date returned `selectedPlannedWorkout: null`,
   `selectionConflict` populated with both conflicting session ids, AND
   `plannedWork: []`/`plannedSession: null` — confirming BOTH leaks
   (the recovery-candidate one the spec named, and the deterministic-
   snapshot one found during inspection) are closed.
4. `GET /today` for the same date returned the identical
   `selectedPlannedWorkout: null` and an equivalent `selectionConflict`,
   plus `exercises: []`.
5. Confirmed both conflicting session ids appear in
   `selectionConflict.sessionIds`, and that `selectedPlannedWorkout` is
   genuinely `null` — there is no session id anywhere in either response
   a frontend could construct a `/logger.html?session=` link from.

All five steps produced exactly the behavior Sections 1–4 of the spec
require.

---

## Files changed

- `src/engine/selectedSessionResolver.ts` — the two conflict branches no
  longer call `mostRecent()` to populate `selectedPlannedWorkout`; doc
  comments updated to state the corrected contract explicitly (including
  "whenever `source` is `'conflict'`, `selectedPlannedWorkout` is always
  `null`").
- `src/server/routes/programming.ts` — `resolveGymDaySelection` now
  suppresses `showDeterministic` explicitly when
  `resolution.source === 'conflict'`, closing the deterministic-snapshot
  leak found during this phase's own consumer audit.
- Tests: `tests/engine/selectedSessionResolver.test.ts` (3 tests
  rewritten for the corrected contract), `tests/routes/actionableVsHistoricalIntegration.test.ts`
  (1 test rewritten with expanded leak coverage, plus an unrelated
  flakiness fix in its own assertion), `tests/frontend/todaySessionResolution.test.ts`
  (1 new test).

## Remaining limitations / deliberately out of scope

- **No same-day makeup functionality, automatic conflict repair,
  automatic deletion, or automatic supersession was added** — per the
  spec's own explicit prohibition. A conflict is surfaced, never
  resolved automatically.
- **No new database-level constraint was added** — this phase changes
  only what the resolver RETURNS when it encounters a conflict, not
  whether the conflict can occur in the first place (already prevented
  going forward by the prior phase's write-time guard,
  `findActiveGymSessionConflict`; this state can only arise from data
  that predates that guard).
