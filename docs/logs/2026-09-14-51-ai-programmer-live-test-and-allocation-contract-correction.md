# 2026-09-14 — AI Programmer: Live Test Finding + Allocation-Contract Correction

Commit `ceafe4b`. Follows directly from log entry 50.

## The live test

With `AI_PROGRAMMER_ENABLED=true` on production, one real
`generate-session` call for Tuesday 2026-09-15 (Push) was attempted
twice under the repair from entry 50 (a stale pre-repair pending
proposal for that date was first expired, with explicit authorization,
via the same `expires_at` mechanism the 24h TTL itself uses — no
approve/commit, no workout/program data touched). Attempt 1 failed on
provider-side invalid JSON (unrelated to this repair). Attempt 2's
**adequacy validator correctly rejected the output**: the model chose
2-3 sets for `upper-pec`/`side-delt`/`triceps`/`triceps-long-head`
against real deterministic floors of 7-8 (Efficient) and 8-12
(Complete, active-goal) sets. No proposal was persisted either time;
the production database was hash-verified byte-identical across all
six affected tables before and after both attempts.

Separately, the actual serialized `programmingBrief` for that date was
inspected against a **read-only copy** of the production database
(fetched via `cat` over SSH — the first copy attempt only grabbed the
main `.sqlite` file and produced a stale WAL-inconsistent snapshot,
caught before drawing any conclusion from it and corrected by also
copying the `-wal`/`-shm` files) — confirming the brief's numbers were
real and load-bearing (e.g. `upper-pec`'s cap of 8 in the brief was the
exact number the adequacy validator's rejection cited).

## Root cause of the rejection

The system instruction's rule 13 told the model to keep sets within
`recommendedSessionSets` "unless a stated reason... justifies falling
below the min" — a self-certifiable escape hatch with no actual check
behind it, so the model could always claim a reason and go arbitrarily
low.

## The correction

Prompt-only change, `buildProgrammerSystemInstruction()`
(`src/ai-programmer/service/aiProgrammerService.ts`) — no other file
touched, `programmerAdequacyValidator.ts` deliberately left unchanged
(it was already correctly catching the problem; the instruction was the
defect). New rules:

- Names and distinguishes the four guidance numbers explicitly:
  `weeklyDevelopmentReference` (a weekly total, never this session's
  number), `recommendedSessionSets {min,max}` ("this is the number you
  follow, not a suggestion"), `directSetsPerExposureCap` (hard
  ceiling), `approxSessionSetBudget` (total session budget).
- Separates two decisions explicitly: WHICH targets/exercises (fully
  flexible) vs. HOW MANY sets (not flexible).
- Replaces the old escape hatch with one objectively-checkable
  exception: falling below a target's own min is permitted only when
  every eligible target's own min already sums above the session's
  real set budget — and even then, maintenance (non-goal) targets must
  absorb the shortfall before any goal-oriented target does, with the
  trade-off named in `programmingRationale`. Names the exact observed
  failure pattern directly ("choosing 2-3 sets for a target whose min
  is 7-8 is a rules violation").

## New tests

`systemInstructionAllocationContract.test.ts` (9): proves the four
concepts are unambiguously distinguished, the allocation procedure is
explicit and ordered, the exact failure pattern is named, and the old
escape-hatch wording is verifiably gone (a negative-match assertion
against the literal old phrase). One new fixture test in
`programmerAdequacyValidator.test.ts`: a valid Push proposal allocating
within the brief's real production ranges (using exercises absent from
any Blueprint package, to keep proving exercise-selection flexibility)
passes cleanly.

## Verification

Full suite diffed against the same real-time baseline used throughout
this work: zero new failures. `npm run typecheck` / `npm run build`
clean. **Not yet deployed or live-tested** — the correction exists in
`origin/main` (`ceafe4b`) but the production VM was still running
`83d3223`'s build as of this entry. The next live Generate-only test
for Tuesday should confirm the model now allocates within
`recommendedSessionSets` rather than merely being caught when it
doesn't.

## Also fixed this session: repo documentation gap

Commits `3f2eda4`/`83d3223`/`ceafe4b` had all gone in without this
project's usual `docs/*_REPORT.md` treatment, and `ceafe4b`'s own code
change had briefly existed only in a local working tree, uncommitted.
Both gaps are closed by this entry, entry 50, entry 49, and
`docs/AI_PROGRAMMER_DEVELOPMENT_REFERENCE_REPAIR_REPORT.md`; the
adequacy validator's five tunable constants are now logged in
`docs/open-decisions.md` (item 21) as `[DEFAULT]`/PROVISIONAL, matching
this repo's existing tagging convention.
