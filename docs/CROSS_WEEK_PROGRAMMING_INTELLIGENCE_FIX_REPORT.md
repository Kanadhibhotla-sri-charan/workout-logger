# Cross-Week Programming Intelligence Fix — Implementation Report

## The reported bug

Production generated absurd single sessions — Push: 19 exercises/2h15m,
Pull: 16/1h58m, Legs: 20/2h17m — for a real 3-gym-day week (Tuesday
Push/Wednesday Pull/Thursday Legs). Both the "Regenerate" and
"Reorganize" AI Programmer UI actions also failed with a generic
"Something went wrong."

## Root causes

**Volume cramming.** `buildWeeklyProgrammingPlan` (`src/engine/
workoutBuilder.ts`) divides each target's weekly objective across
`realExposureCountThisRun` — the number of this-week gym days compatible
with that target's session purpose. With no concept of any week other
than the one being built, a target compatible with only one day this
week (e.g. a push-only muscle in a 3-day PPL week with no Upper session)
had its *entire* weekly objective assigned to that one session — the
`WORKOUT_PROGRAMMER_CONSOLIDATED_FIX_SPEC.md` §7 removal of time-based
candidate elimination means nothing then trims the result back down; it
is placed in full.

**AI request failures.** nginx had no explicit `proxy_read_timeout`
(60s default), racing the app's own identical 60000ms Velona provider
timeout. Production logs showed two byte-identical 578-byte 504 bodies
for two different endpoints — nginx's own default error page, not the
app's JSON. `aiApi()`'s `res.json().catch(() => ({}))` swallowed that
non-JSON body into `{}`, so `mapAiErrorCode(undefined)` fell through to
the generic string with no way to tell a timeout from any other failure.

## Design: a genuine, bounded cross-week horizon

Rejected an earlier superficial "look at next week, increase the
divisor, carry the remainder forward and forget it" patch — it would
compute a smaller number without ever proving next week's *actual
generated sessions* absorb the deferred work. The real fix instead:

1. **Read-only lookback, exactly one week**: `assembleWeeklyPlanInput`
   reads the immediately preceding week's own persisted
   `WeeklyPlanTargetAllocation[]` (`programs.target_allocations_json`,
   already-existing, already-written infrastructure that was previously
   always zero in practice) and folds any `unmetDirectSets > 0` into
   this week's own `desiredWeekly` via a new `carryoverByTarget` input.
   This is real, persisted carryover, genuinely consumed by the next
   real week's own generation — not a number computed and discarded.
2. **Read-only lookahead, exactly one week**: when this week's own
   compatible days fall short of a target's frequency reference,
   `realExposureCountThisRun` extends into next week's own compatible
   days (via `nextWeekOrderedGymDays`/`nextWeekSessionPurposes`) —
   bounded so it never exceeds the target's own frequency reference
   total. This is what stops the cram: a target's per-session share is
   now divided across the *realistic* number of upcoming exposures, not
   forced into one.
3. **No new time-fitting.** The Consolidated Fix's §7 rule (`session
   time availability must have zero effect on normal program
   generation`) is preserved. The fix works entirely on which/how many
   *exposures* a target's volume is divided across — never an
   exercise-count cap or a deleted exercise.
4. **`UPPER_PHYSIQUE_TARGETS = [...PUSH_PHYSIQUE_TARGETS,
   ...PULL_PHYSIQUE_TARGETS]`** (already true in `config.ts`) is what
   lets a Friday Upper session naturally absorb carried-over Push volume
   through the existing intra-week balancing logic — no special-casing
   needed.

### Changed

- `src/engine/workoutBuilder.ts`: `WeeklyPlanInput` gains
  `nextWeekOrderedGymDays?`, `nextWeekSessionPurposes?`,
  `carryoverByTarget?` (all optional/backward-compatible);
  `desiredWeekly` adds `carryoverFromPriorWeek`; the exposure-count
  computation extends into next week under the bound described above;
  `assembleWeeklyPlanInput` computes all three new fields via one extra
  `WeekActivityOverridesRepo`/`WeeklyProgramRepo` read each.

### Regression proof

`tests/engine/crossWeekPlanningHorizon.test.ts` drives the exact
fixture required: current week Tuesday Push/Wednesday Pull/Thursday
Legs (Saturday/Sunday badminton, Monday/Friday rest) plus an existing
completed history session (2026-08-29, real logged
`flat-barbell-bench-press` sets — inside the engine's own real 14-day
rolling history window as seen from both weeks, so it is genuinely
visible history, not a date chosen outside the window by accident).
Next week adds a Friday Upper session via a week-scoped override (never
touching the recurring `TrainingProfile`). Two real calls to `GET
/api/programming/week` (the actual `ensureWeekProgramGenerated` →
`computeFreshWeek` → `reconcileWeekProgram` path) generate and persist
both weeks. Verified against the *real* `programs.target_allocations
_json`, real session `plannedWork`, and a direct `assembleWeeklyPlanInput`
read of the real per-target history context:

**1-2. Exercise count and duration, every session:**

| Session | Exercises | Minutes | vs. the reported bug |
|---|---|---|---|
| Current-week Push (Tue) | 16 | 104.4 | bug: 19 ex / 135.2 min |
| Current-week Pull (Wed) | 14 | 89.1 | bug: 16 ex / 117.8 min |
| Current-week Legs (Thu) | 11 | 71.8 | bug: 20 ex / 137.3 min |
| Next-week Push (Tue) | 17 | 115.3 | — |
| Next-week Upper (Fri) | 17 | 115.3 | — |

All five sessions land under the profile's own configured 120-minute
ceiling. Confirmed the test is genuinely discriminating (not vacuous)
by reverting the engine change: current-week Push then fails at
**135.1 minutes** — matching the reported bug's exact order of
magnitude — and passes at 104.4 with the fix restored.

**3. Direct-set distribution for the tracked push-only target
(mid-pec, the one specialization goal in this fixture — push+upper
compatible only, i.e. exactly one compatible day in the current week,
the precise failure condition):**

| Week | requiredDirectSets | deliveredDirectSets | unmetDirectSets | Delivered where |
|---|---|---|---|---|
| Week 1 | 8 | 4 | 4 | Tuesday Push only: 4 |
| Week 2 | 12 (8 fresh + 4 carried over) | 10 | 2 | Tuesday Push: 5, Friday Upper: 5 |

Week 1's single compatible session received a **fair share (4 of 8)**,
never the whole target crammed in. Week 2's own combined target
(fresh 8 + week 1's real carried-over 4 = 12) was then **split evenly
across its two now-compatible sessions (5 + 5)** — genuine
distribution, not a repeat of the single-session cram.

**4. Friday Upper accounts for both completed history and the planned
next-week Push exposure — confirmed directly, not inferred:**

- A direct `assembleWeeklyPlanInput` read at the moment Friday-of-week-2
  is evaluated shows mid-pec's real history context already reflects
  the completed session: `last_trained_date: "2026-08-29"`,
  `current_exercise_id: "flat-barbell-bench-press"`, and
  `exercise_history` populated with the 3 real logged sets — the exact
  facts `recoveryEngine`/Gate 5 exercise-selection continuity consume.
  This is asserted directly in the test, not just logged.
- Week 2's `target_allocations` entry for mid-pec has
  `allocatedSessionDates: ["2026-09-08", "2026-09-11"]` — **both**
  Tuesday Push and Friday Upper sit under the *same* real allocation
  object (10 delivered total), never two independent, disconnected
  allocations. Friday Upper's own 5 sets are what's left after
  Tuesday's 5 are already accounted for — genuine complementary
  planning across the week, not redundant re-maxing.

**5. No required work silently discarded; no unrelated future session
touched:**

- Week 1's 4 unmet sets are not discarded: they appear verbatim inside
  week 2's own `requiredDirectSets` (12 = 8 + 4) and are the reason
  week 2's remaining `unmetDirectSets` (2) is what it is — a real,
  traceable number, not a guess. If a week 3 were ever generated, that
  same mechanism would read week 2's own persisted `unmetDirectSets`
  (2) as its carryover — nothing is a dead end.
- `programs` row for week 3 (`2026-09-14`) was confirmed **not to
  exist** — never created, since it was never requested.
- The completed session's row **and** its real logged exercise/set
  performance (`getExercisePerformances`) are byte-identical before and
  after both generations.
- The recurring `TrainingProfile.training_days`/`other_activity_schedule`
  are byte-identical before and after — only a week-2-scoped override
  was added.
- No `fetch` call occurred at any point (spied and asserted) — this
  entire regression is the fully-deterministic path; no AI call is
  implied or made.

Full suite: baseline-diffed against the session's established 229
pre-existing (unrelated, stale-calendar-date) failures — zero new
failures, one new passing test, before and after every edit round,
including after strengthening this fixture with real completed-history
data.

## AI request-failure fixes

1. **`ops/nginx/workout-logger.conf`**: added `proxy_read_timeout
   150s;` — sized to exceed the app's own worst case,
   `(VELONA_MAX_RETRIES + 1) * VELONA_TIMEOUT_MS` plus retry delay
   (~120.3s with the documented defaults of 1 retry / 60000ms). Must
   still be applied on the production VM's live nginx config (this repo
   file is the template `certbot` originally installed from — nginx
   config is not part of the git-based app deploy).
2. **`public/app.js`'s `aiApi()`**: now distinguishes a fetch-level
   network failure (`AI_CLIENT_NETWORK_ERROR`), a non-JSON body on a
   502/503/504 status — the nginx-race signature —
   (`AI_CLIENT_UPSTREAM_TIMEOUT`, a new user-facing message), a non-JSON
   body on any other status (`AI_CLIENT_UNEXPECTED_RESPONSE`, same safe
   generic text as before), and a structured-but-unmapped backend code
   (already distinguishable via `err.code = body.error`, unchanged).
   `mapAiErrorCode`'s own contract (exact fallback string for an
   unknown/missing code) is unchanged — only `aiApi()`'s handling around
   it changed. New/updated tests in `tests/frontend/aiProposalUI.test.ts`.
3. **Token limit**: `src/ai-programmer/service/tokenReport.ts`'s dry-run
   tool reported `reconcile_week`'s real payload (~16.6k input tokens,
   3000-token fixed planning estimate) as fitting under the shared
   4096-token default — but that planning estimate is a static per-mode
   constant, not a measurement of a real, busy 7-day output. Given the
   output schema's own `rationale: string[]` per exercise and this same
   task's own empirical 16-exercise session, a busy real week could
   plausibly approach 4096 with no safety margin. Rather than raising
   the shared default (inflating `generate_session`'s much smaller real
   need for no reason), added a targeted `reconcile_week`-only floor —
   `effectiveMaxTokensForMode` in `velonaProvider.ts`, `Math.max(config.
   maxTokens, 6144)` — read back by `tokenReport.ts` from the same built
   request body so production and diagnostics can never disagree. Also
   added explicit prompt guidance (both context builders) to keep each
   exercise's `rationale` to one short phrase, reducing output size
   before relying on the raised ceiling. `AI_PROGRAMMER_ENABLED` was not
   touched.

## AI cross-week context

`generate-session` and `reconcile-week` previously received only their
own week's data, structurally unable to reason about deferring or
distributing volume across weeks. Added a shared, read-only `crossWeek`
context field (`AICrossWeekContext`, `programmerContextTypes.ts`) built
by `buildCrossWeekContext` (`programmerContextBuilder.ts`, reused by
`reconciliationContextBuilder.ts` — never duplicated) from data the
deterministic engine already computes, with one extra read-only lookup
each:

- `carryoverFromPriorWeek`: the same `unmetDirectSets` figures already
  folded into this week's own `desiredWeekly` — explains why a target's
  current-week requirement may already be larger than its plain weekly
  reference.
- `currentWeekAllocations`: this week's own persisted
  `WeeklyPlanTargetAllocation[]`, if a program already exists for it —
  lets the AI see that deferring volume now becomes real next-week
  carryover, never a reason to overstuff the current session.
- `nextWeek.days`/`programAlreadyExists`: the real, read-only eligible
  schedule (and any already-persisted sessions) exactly one week ahead
  — never further, and explicitly forbidden (`FORBIDDEN_BEHAVIORS`) from
  being described as something this request creates or changes.

Both context builders' priority-hierarchy guidance now explicitly tells
the model to prefer distributing/deferring lower-priority volume across
real compatible exposures (this week's other days, or next week) over
cramming one session — mirroring, in prompt form, the same trade-off the
deterministic engine itself now makes structurally.

## Verification summary

- `npm run typecheck` / `npm run build`: clean after every edit round.
- Full suite baseline-diffed (`git stash` baseline → strip ANSI → sorted
  `FAIL` lines → diff) against the session's established 229 pre-existing
  failures: zero new failures throughout.
- `tests/engine/crossWeekPlanningHorizon.test.ts`: new, proven
  discriminating (fails pre-fix, passes post-fix) end-to-end regression.
- `tests/frontend/aiProposalUI.test.ts`: updated/new coverage for the
  three distinguishable `aiApi()` failure modes.
- `npm run ai:token-report`: confirmed `reconcile_week` now reports
  `configuredMaxOutputTokens: 6144` while `generate_session` is
  unaffected at `4096`.

## Not yet done (requires separate production access/approval)

- Applying `proxy_read_timeout 150s` to the *live* nginx config on the
  production VM (this repo's `ops/nginx/workout-logger.conf` is a
  template, not something the app's git-based deploy touches).
- Deploying this commit to production at all — per the task's explicit
  instruction, held until this report was reviewed.
