# 2026-08-30 — Resource allocation across competing goals

## Why

Spec §17 was not previously stubbed as its own module at all — it had
no code. It's needed before `workoutBuilder` can decide how to split a
scarce resource (session minutes, exercise slots) across multiple
active goals competing for it, respecting the user's explicit ranking
without letting the #1 goal hoard everything.

## What changed

`src/engine/resourceAllocation.ts` (new) — `allocateResource()`:
resource-agnostic (the caller names what's being allocated via
`resource_name` — minutes, exercise slots, anything countable), and
reduces to one clean deterministic pass: process goals strictly in
priority order (rank 1 first — "ranking is respected... cannot be
overridden"), and cap each goal's allocation at its own
`desired_amount` rather than handing whoever's served first the entire
remaining budget. That single cap is what satisfies both halves of
§17's sentence at once: a well-progressing #1 is protected (served
first, in full, up to what it actually wants) *and* it doesn't hoard —
leftover naturally reaches lower-ranked goals, stagnant ones included,
without a second reallocation pass. `progress_status` is accepted per
goal but only used in `reasoning` text (to note when a stagnant goal
benefited from a higher goal's leftover) — it never changes the
arithmetic, since re-reading §17 closely, the exception it describes is
about #1 not over-consuming, not about reordering ranks below #1.

## Tests

`tests/engine/resourceAllocation.test.ts` (8 tests): **required test
5** — a high-priority small-ask goal is fully served before a
low-priority big-ask goal, even when the low-priority goal asked for
more; swapping which goal is priority 1 changes who gets served first
(ranking, not identity, drives allocation); total allocated never
exceeds `total_available`; a goal never receives more than its own
`desired_amount` even with abundant leftover; a well-progressing #1 is
fully served *and* a stagnant lower-ranked goal still gets the
leftover (not blindly maximizing #1); equal-priority ties break
deterministically by `goal_id`; zero available resource doesn't error;
every allocation carries real reasoning text.

## Verification (actually run)

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  33 passed (33)
      Tests  257 passed (257)
```

(249 tests before this batch; 257 after adding
`tests/engine/resourceAllocation.test.ts`'s 8 tests — no regressions.)

## Still open

`workoutBuilder` is now blocked on exactly one remaining thing: a real
time-fitting algorithm (§6.2) — `constraintEngine.ts` currently only
has the budget-check primitives (`fitsWithinBudget`,
`remainingBudgetMinutes`), not the actual "preserve higher-priority
work, substitute/trim without truncating arbitrarily" fitting
algorithm. That's next, then the full §19 pipeline itself.
