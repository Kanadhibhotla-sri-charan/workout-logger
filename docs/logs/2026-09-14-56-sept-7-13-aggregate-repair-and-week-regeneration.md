# 2026-09-14 — Sept 7–13 Aggregate Repair + Sept 14–20 Regeneration

No code change in this entry — a production data-repair operation.
Follows directly from log entry 55 (the aggregate-integrity fix), which
corrected the *code* but not any already-persisted, already-stale
aggregate.

## The decision trail (recorded verbatim per explicit request)

After entry 55 was deployed, the user asked why Tuesday Push on the
live 2026-09-14 week still showed 19 exercises / 139.6 minutes —
barely improved from the original bug (19 / 135.2). Investigation
found the immediately preceding week (2026-09-07–13) had every one of
its 4 real gym days locked by a real completed workout, and its
persisted `target_allocations_json` — computed and stored **before**
entry 55's fix existed — still showed `deliveredDirectSets: 0` for the
large majority of targets, e.g. triceps (0 vs 6 really delivered) and
triceps-long-head (0 vs 4). Since the cross-week fix reads that stored
number as real backlog, 2026-09-14's own regeneration (done once,
immediately after entry 54's deploy) had inherited the corrupted
26-set combined triceps-family backlog rather than the legitimate
16-set one.

The user asked, plainly: *"So your fix makes 7-13 reappear and connect
to the program generator and hopefully make current week's program a
bit realistic, just tell me the answer don't implement anything until
I approve."*

The answer given: yes, but two more explicit steps were still needed,
neither done yet — (1) recompute 2026-09-07–13's own stored aggregate
using the code now in place, and (2) regenerate 2026-09-14–20 again so
it reads the corrected number. Framed honestly: this would reduce the
false inflation (26 → 16 combined sets) but would not make the session
small, since 16 real sets of backlog from two active specialization
goals is still a legitimate, substantial amount.

The user then asked for a plain day-by-day account of what was
actually logged 2026-09-07–13 (provided, matching the real
`workout_exercises`/`workout_sets` rows — real training happened on 4
of the 7 days), then asked why real training still "warrants such an
unrealistic" current week. Answered: "delivered" is tracked against
the deterministic **plan's own prescription** for a locked day, not a
fresh re-scan of whichever exercises were actually chosen — that
plan-level bookkeeping is exactly what entry 55 fixed; separately, two
active specialization goals (triceps, triceps-long-head) legitimately
want more weekly volume than a 4-day split delivered them, which
correctly and legitimately carries forward regardless of any bug.

The user then approved: *"Ok go ahead with both the steps. But
properly report me back on what you asked and what I said. And also
log everything properly."* — this entry is that report.

## What was actually done

1. **Isolated-copy verification first** (per an explicit clarifying
   question that was asked and answered before touching production):
   copied `workout-logger.sqlite` + `-wal` + `-shm` to `/tmp/agg-fix-verify/`
   on the VM, then ran a one-off script calling `computeFreshWeek` +
   `reconcileWeekProgram` directly against 2026-09-07 on that copy.
   - First attempt used `historyAsOfDate = todayForUser(db)` (2026-09-14)
     — this was caught as a mistake during verification: it anchors
     the "current week" volume calculation to the *wrong* week
     (2026-09-14–20's own, not 2026-09-07–13's), inflating unrelated
     `requiredDirectSets` figures for reasons that have nothing to do
     with the bug being fixed. Corrected to `historyAsOfDate =
     '2026-09-13'` (the target week's own last real day) before
     touching production.
   - Confirmed on the copy: `program_sessions` content byte-identical
     before and after (mathematically guaranteed, since every day that
     week is locked) — only the aggregate changed.
   - One transparent, expected side effect noted and reported before
     proceeding: 2 of 6 sampled targets (`back-thickness`,
     `upper-traps`) also showed their `requiredDirectSets` increase —
     not a mistake, but the same already-deployed one-week-back
     carryover mechanism now also applying between 2026-08-31–09-06
     and 2026-09-07–13 (a hop that never happened when 2026-09-07–13
     was originally generated, since the feature didn't exist yet).
2. **Backed up production** (`deployment-backups/workout-logger.sqlite{,-wal,-shm}.pre-sept7-13-repair-20260914-123434`).
3. **Stopped the app service**, ran the same corrected script directly
   against the live production database, confirmed
   `program_sessions` content byte-identical before/after (verified via
   unchanged `created_at` timestamps on every one of the 4 real
   sessions, and a direct JSON diff), confirmed DB-wide row counts
   unchanged (`11|34|94|3|9|3|9`), **restarted the service**, confirmed
   `/api/health` returns `200 ok`.
4. **Regenerated 2026-09-14–20** via the same supported deterministic
   endpoint used previously (`PUT /api/programming/week/days/tuesday/activity`,
   `{"activity":"gym","prescriptionPolicy":"regenerate"}`).

## Result

| Session | Before entry 55 (bug) | After entry 55's code deploy, before this repair | After this repair |
|---|---|---|---|
| Tue Push | 19 ex / 135.2 min | 19 ex / 139.6 min | **18 ex / 133.2 min** |
| Wed Pull | 16 ex / 117.8 min | 15 ex / 106.7 min | **16 ex / 106.5 min** |
| Thu Legs | 20 ex / 137.3 min | 14 ex / 98.2 min | **13 ex / 89.4 min** |

Triceps (the largest legitimate driver of Push's size):
`requiredDirectSets: 17, deliveredDirectSets: 9, unmetDirectSets: 8` —
down from the bug-inflated backlog, and now a real, traceable number
rather than a discarded hypothetical.

## Verification after regeneration

- DB row counts unchanged (`11|34|94|3|9|3|9`).
- `training_days` unchanged (`["monday","tuesday","thursday","friday"]`).
- Every `programs` row's own `created_at` unchanged (2026-08-31,
  2026-09-07, 2026-09-14 rows are all the SAME rows as before — no
  program was newly created or replaced).
- `AI_PROGRAMMER_ENABLED=true`, untouched.
- `/api/health` returns `200 {"status":"ok"}` after every restart.

## Honest summary for anyone reading this later

The session did not become "small." It became **correct**: Push's
size is now driven entirely by two active specialization goals
(triceps, triceps-long-head) legitimately wanting more weekly volume
than 2 of this week's 4 sessions can fully deliver — real, traceable,
intentional program design — rather than by a data-integrity bug
inventing a false 10-set-larger backlog on top of that real amount.
