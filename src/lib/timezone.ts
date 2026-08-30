// The timezone contract for workout-logger. See docs/architecture.md
// "Timezone and date semantics" for the full write-up — summary:
//
//   Workout dates and times are interpreted in the user's configured
//   local timezone (TrainingProfile.timezone, an IANA name). This app
//   never converts to or reasons in UTC for anything user-facing; `date`
//   is always a plain YYYY-MM-DD string with no timezone offset attached,
//   and `start_time`/`end_time` are plain HH:MM wall-clock strings in
//   that same zone.
//
// DEFAULT_TIMEZONE is used only until a TrainingProfile exists (Phase 2
// bootstrapping) or wherever no profile has been created yet — it is NOT
// a silent assumption baked into engine logic, callers should prefer a
// real TrainingProfile.timezone once one exists.
export const DEFAULT_TIMEZONE = 'UTC';

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Today's date (YYYY-MM-DD) as of `now`, in `timezone` — never the
 * server process's own timezone. */
export function todayInTimezone(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
}
