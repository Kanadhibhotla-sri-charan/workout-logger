// Pure calendar-day arithmetic over plain YYYY-MM-DD strings — see
// docs/architecture.md's timezone contract: `WorkoutSession.date` has no
// offset attached, so all this needs is calendar math, never wall-clock/
// instant math. Parsing as UTC midnight and doing arithmetic in UTC
// sidesteps DST entirely (there is no "instant" here to be DST-ambiguous
// about — just day counting).

import type { Weekday } from '../contracts/types.js';

const WEEKDAY_INDEX: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** True only for a string that is both shaped like `YYYY-MM-DD` AND a
 * real calendar date — rejects e.g. "2026-02-31" or "2026-04-31", which
 * `new Date(...)`/`Date.UTC(...)` would otherwise silently normalize
 * into a different, real date (2026-02-31 -> 2026-03-03) rather than
 * signal an error. Verifies round-trip equality against the parsed
 * UTC components rather than trusting `Date`'s own leniency. The single
 * shared calendar-date validity check for this app — anything
 * accepting an external/untrusted date string (e.g. the AI Programmer
 * route) should call this rather than a second, competing check. */
export function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseIsoDate(dateIso: string): Date {
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${dateIso}", expected YYYY-MM-DD`);
  return d;
}

function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(dateIso: string, days: number): string {
  const d = parseIsoDate(dateIso);
  d.setUTCDate(d.getUTCDate() + days);
  return formatIsoDate(d);
}

/** Number of calendar days from `a` to `b` (positive if b is after a). */
export function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((parseIsoDate(b).getTime() - parseIsoDate(a).getTime()) / msPerDay);
}

/** True if `date` falls within [start, end], inclusive. */
export function isDateInRange(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

/**
 * The 7-day [start, end] window (inclusive) containing `date`, given the
 * configured week-start day (TrainingProfile.week_start_day —
 * docs/TRAINING_EXPOSURE_MODEL.md §G explicitly rejects a silently
 * hard-coded Monday).
 */
export function weekRangeContaining(dateIso: string, weekStartDay: Weekday): { start: string; end: string } {
  const dayIndex = parseIsoDate(dateIso).getUTCDay(); // 0=Sunday..6=Saturday
  const startIndex = WEEKDAY_INDEX[weekStartDay];
  const offsetFromStart = (dayIndex - startIndex + 7) % 7;
  const start = addDays(dateIso, -offsetFromStart);
  const end = addDays(start, 6);
  return { start, end };
}

/** The [start, end] rolling window (inclusive) of `windowDays` days ending
 * on `asOfDate`. No default window — see
 * docs/TRAINING_EXPOSURE_MODEL.md §G on why a silent default here is
 * exactly the failure mode the spec warns against. */
export function rollingRangeEnding(asOfDate: string, windowDays: number): { start: string; end: string } {
  if (windowDays < 1) throw new Error('windowDays must be >= 1');
  return { start: addDays(asOfDate, -(windowDays - 1)), end: asOfDate };
}
