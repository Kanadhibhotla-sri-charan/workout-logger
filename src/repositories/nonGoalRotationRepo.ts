import type Database from 'better-sqlite3';
import { nowIso } from './ids.js';

export interface NonGoalRotationState {
  weekStart: string | null;
  cursorUsed: number;
  cursorAfter: number;
}

/**
 * Non-Goal Muscle Rotation Fix (2026-09-16): persisted state for the
 * global rotation ring workoutBuilder.ts's `compareRankings` uses to
 * break an exact tie between two NON-goal physique targets (see that
 * module's own doc comment above `compareRankings` for the full "A,B ->
 * C,A -> B,C -> repeat" design). One row per user, matching
 * training_profiles' own keying — this is a single-user app today, but
 * this repo is scoped per-user exactly like every other piece of
 * training state, never a bare global.
 *
 * Deliberately NOT a single rolling counter: a plain "current cursor"
 * would advance the instant a week's FIRST generation persists it, so a
 * later regeneration of that SAME week (an activity-override
 * reconciliation, an actual-training adaptation pass, etc.) would read
 * an already-advanced value and re-rank non-goal ties differently from
 * the original generation — silently changing an unaffected day's own
 * composition and breaking the future-plan-stability guarantee
 * weekProgramReconciliation.ts's corePrescriptionEqual exists to
 * protect. Instead this stores which `weekStart` was most recently
 * generated, the cursor value THAT week used (`cursorUsed` — reused
 * byte-for-byte by every regeneration of the same week), and the value
 * to hand to the NEXT, genuinely different week (`cursorAfter`).
 *
 * KNOWN, DELIBERATE LIMITATION: only the single MOST RECENTLY generated
 * week is remembered — not a full per-week history. Regenerating an
 * OLDER week after a NEWER one already exists reads as "a new week"
 * relative to whatever is currently stored, and rolls forward from the
 * newer week's own `cursorAfter` rather than that older week's original
 * `cursorUsed`. In normal usage this never matters (a week is generated
 * once, then only ever regenerated relative to itself before the next
 * real week begins) — this is the one gap "the simple rotation
 * approach" (no backlog/history table, per explicit design) leaves
 * open, not an oversight. See this repo's own test file for the exact
 * scenario.
 */
export class NonGoalRotationRepo {
  constructor(private db: Database.Database) {}

  get(userId: string): NonGoalRotationState {
    const row = this.db
      .prepare('SELECT week_start, cursor_used, cursor_after FROM non_goal_rotation_state WHERE user_id = ?')
      .get(userId) as { week_start: string | null; cursor_used: number; cursor_after: number } | undefined;
    return row ? { weekStart: row.week_start, cursorUsed: row.cursor_used, cursorAfter: row.cursor_after } : { weekStart: null, cursorUsed: 0, cursorAfter: 0 };
  }

  /** The cursor a caller should rank `weekStart` with RIGHT NOW — the
   * same value every regeneration of that exact week keeps seeing
   * (stability), or the next rolling value once `weekStart` is
   * genuinely different from whatever was last recorded (so the ring
   * keeps advancing week over week, never resetting). Read-only — never
   * writes anything, so a plain GET/AI-context build never spends a
   * rotation turn. */
  cursorFor(userId: string, weekStart: string): number {
    const state = this.get(userId);
    return state.weekStart === weekStart ? state.cursorUsed : state.cursorAfter;
  }

  /** Records that `weekStart` was just generated using `cursorUsed`,
   * ending at `cursorAfter` — called ONLY by computeFreshWeek's
   * first-ever generation of a given week (see its own doc comment for
   * how it detects that). A regeneration of the SAME week must never
   * call this again — `cursorFor` already keeps returning the original
   * `cursorUsed` for it without any further write needed. */
  recordGeneration(userId: string, weekStart: string, cursorUsed: number, cursorAfter: number): void {
    this.db
      .prepare(
        `INSERT INTO non_goal_rotation_state (user_id, week_start, cursor_used, cursor_after, updated_at)
         VALUES (@user_id, @week_start, @cursor_used, @cursor_after, @updated_at)
         ON CONFLICT(user_id) DO UPDATE SET week_start = @week_start, cursor_used = @cursor_used, cursor_after = @cursor_after, updated_at = @updated_at`
      )
      .run({ user_id: userId, week_start: weekStart, cursor_used: cursorUsed, cursor_after: cursorAfter, updated_at: nowIso() });
  }
}
