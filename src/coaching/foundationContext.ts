// Coaching Depth Batch 1 spec §7: the one integration point combining
// all three coaching modules into a single, deterministic,
// serializable context — built from real, already-fetched application
// state (spec: "1. Active program state, 2. Canonical targets, 3.
// Profile registry, 4. Current generated plan, 5. Historical workout
// records"), never a second independently-derived plan/history system.
// Exposed to the existing AI context builders as a READ-ONLY field
// (programmerContextBuilder.ts/reconciliationContextBuilder.ts) — the
// AI must never be able to authoritatively mutate any of it; every
// value here is server-computed and server-authoritative.

import type Database from 'better-sqlite3';
import { addDays, rollingRangeEnding } from '../engine/dateMath.js';
import type { Weekday } from '../contracts/types.js';
import type { PersistedWeekSession } from '../repositories/weeklyProgramRepo.js';
import { getProfile } from './profiles/muscleProfiles.js';
import { getActualScheduledFrequency, type ScheduledPlanDay } from './profiles/muscleProfileService.js';
import type { MuscleProgrammingProfile } from './profiles/muscleProfileTypes.js';
import { getOrCreateActiveProgramState } from './programState/programStateService.js';
import type { ProgramState } from './programState/programStateTypes.js';
import { getTargetSummary } from './history/historicalService.js';
import type { TargetHistoricalSummary } from './history/historicalTypes.js';

/** Spec §7's own required shape, exactly. */
export interface CoachingFoundationContext {
  programState: ProgramState;
  targetProfiles: Record<string, MuscleProgrammingProfile>;
  scheduledFrequency: Record<string, number>;
  historicalSummaries: Record<string, TargetHistoricalSummary>;
}

/** No block-length preference exists anywhere in this app yet (Batch 1
 * introduces no periodization UI) — 4 weeks is a documented, adjustable
 * default used only the first time a program's state is ever
 * initialized; it never changes on its own once a block exists, and
 * nothing in this batch acts on it (spec §12: no ramping/periodization
 * cycles implemented). */
const DEFAULT_BLOCK_LENGTH_WEEKS = 4;

/** How far back `historicalSummaries` looks by default — matches the
 * default block length above only coincidentally; this is a separate,
 * independently-adjustable read-window, never a stored/periodization
 * concept itself. */
const DEFAULT_HISTORY_WINDOW_DAYS = 28;

export interface BuildCoachingFoundationContextInput {
  /** This app's single stable user id — see programStateTypes.ts's own
   * doc comment for why `programId` is keyed this way rather than to a
   * per-week `programs.id` row. */
  programId: string;
  /** A real calendar date the caller already resolved through the
   * app's own timezone-aware "today" logic (e.g. `todayForUser`) —
   * never computed here from wall-clock time (spec §5.3). */
  referenceDate: string;
  weekBoundary: Weekday;
  /** The Monday-anchored start of `referenceDate`'s/`targetDate`'s
   * programming week — the exact value the calling context builder
   * already computed via `programmingWeekStart`, reused here (never
   * recomputed) to convert `persistedWeekSessions[].day_index` into
   * real calendar dates. */
  weekStart: string;
  /** Exactly the target ids the calling context already built
   * (`targets.map(t => t.targetId)`) — this context is scoped to the
   * SAME targets the rest of the AI context already covers, never a
   * separate, wider "every physique target in Blueprint" dump. */
  targetIds: readonly string[];
  /** This week's already-fetched persisted plan sessions (e.g.
   * `weeklyProgram?.sessions ?? []`) — never a second
   * `WeeklyProgramRepo` read; the caller already has this. */
  persistedWeekSessions: readonly Pick<PersistedWeekSession, 'day_index' | 'snapshot'>[];
  historyWindowDays?: number;
  defaultBlockLengthWeeks?: number;
}

/** A real day's snapshot shape only ever has `plannedWork` as an array
 * when it is a real gym/both day (see WeeklyProgramRepo's own doc
 * comment); every item's `target_id` is read defensively since
 * `snapshot` is stored as an opaque JSON blob (`unknown`), never
 * assumed to match a specific shape without checking. */
function extractPlannedTargetIds(snapshot: unknown): string[] {
  if (snapshot === null || typeof snapshot !== 'object') return [];
  const plannedWork = (snapshot as { plannedWork?: unknown }).plannedWork;
  if (!Array.isArray(plannedWork)) return [];
  const ids = new Set<string>();
  for (const item of plannedWork) {
    if (item !== null && typeof item === 'object' && typeof (item as { target_id?: unknown }).target_id === 'string') {
      ids.add((item as { target_id: string }).target_id);
    }
  }
  return [...ids];
}

/** Builds one deterministic `CoachingFoundationContext` — identical
 * inputs (same db state, same `referenceDate`/`weekStart`/`targetIds`)
 * always produce an identical result (spec §7: "the context must be
 * deterministic"). Lazily initializes program state the first time it
 * is ever read for this user (spec §5.3's "regeneration must not reset
 * the block or week" concerns weekly plan regeneration specifically —
 * this function is called from context-BUILDING, an explicit read, not
 * from `computeFreshWeek` itself). */
export function buildCoachingFoundationContext(db: Database.Database, input: BuildCoachingFoundationContextInput): CoachingFoundationContext {
  const programState = getOrCreateActiveProgramState(
    db,
    input.programId,
    input.referenceDate,
    input.weekBoundary,
    input.defaultBlockLengthWeeks ?? DEFAULT_BLOCK_LENGTH_WEEKS
  );

  const targetProfiles: Record<string, MuscleProgrammingProfile> = {};
  for (const targetId of input.targetIds) {
    targetProfiles[targetId] = getProfile(targetId);
  }

  const scheduledPlanDays: ScheduledPlanDay[] = input.persistedWeekSessions.map((session) => ({
    date: addDays(input.weekStart, session.day_index),
    targetIds: extractPlannedTargetIds(session.snapshot),
  }));
  const scheduledFrequency: Record<string, number> = {};
  for (const targetId of input.targetIds) {
    scheduledFrequency[targetId] = getActualScheduledFrequency(targetId, scheduledPlanDays);
  }

  const { start: windowStart, end: windowEnd } = rollingRangeEnding(input.referenceDate, input.historyWindowDays ?? DEFAULT_HISTORY_WINDOW_DAYS);
  const historicalSummaries: Record<string, TargetHistoricalSummary> = {};
  for (const targetId of input.targetIds) {
    historicalSummaries[targetId] = getTargetSummary(db, targetId, windowStart, windowEnd);
  }

  return { programState, targetProfiles, scheduledFrequency, historicalSummaries };
}
