# Change log: Phase 2 §1 — timezone/date semantics + single-user scope

- **Date:** 2026-08-30
- **Commit:** `6e68e66`
- **Source:** `workout_programmer_phase2_training_engine.md`, the Phase 2
  spec ("Training Engine Design & Foundation"). Phase 1/1.5's architecture
  was approved as the base; this spec asked for a small set of remaining
  foundation fixes (§1) before the Training Engine design work.

## What changed

- **Timezone contract (§1.1).** Added `TrainingProfile.timezone` (IANA
  name, validated via a new `InvalidTimezoneError` on write). Documented
  the full contract in `docs/architecture.md`: `date`/`start_time`/
  `end_time` are plain strings with no offset, interpreted in the
  configured zone; a session crossing midnight keeps one `date` field
  (its start date), never split or inferred from `end_time`.

  Fixed a real bug the documentation work surfaced: `workouts.ts`'s
  `/today` route and `export.ts`'s default `?date` both computed "today"
  via `new Date().toISOString().slice(0,10)` — always UTC, wrong on
  either side of midnight for any non-UTC user. Added
  `src/lib/timezone.ts` (`todayInTimezone`, `isValidTimezone`) and
  `src/lib/userTimezone.ts` (`resolveUserTimezone`/`todayForUser`,
  reading the configured profile, falling back to `DEFAULT_TIMEZONE`),
  wired into both routes. Fixed the equivalent client-side bug in
  `public/app.js` (`todayIso()` used `toISOString()`, always UTC
  regardless of browser timezone; switched to
  `toLocaleDateString('en-CA')`).

- **Single-user scope (§1.2).** Added an explicit "Scope: single-user"
  section to `docs/architecture.md` — authentication and multi-user
  authorization are out of scope by design, not an oversight; every
  repository/route already operates against the one implicit user from
  `UsersRepo.getOrCreateDefault()`.

## Why

Both were prerequisites the spec asked for before Training Engine design
work, since completed-workout data (date-filtered) will eventually feed
Calorie Tracker's daily calculations and needs a correct, documented
timezone contract first.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 55/55 passing (12 new tests in
  `tests/timezone.test.ts`, plus `trainingProfile.test.ts` updated for
  the new required field).
- Manual `curl` smoke test: saved a training profile with
  `timezone: "Asia/Kolkata"`, confirmed it round-trips; confirmed
  `"Not/AZone"` is rejected with a clear 400 error.
