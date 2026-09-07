import type Database from 'better-sqlite3';
import { newId, nowIso } from './ids.js';

// Programming Redesign (Step 12) §10-§11: persisted longitudinal
// goal-phase state — deliberately separate storage from
// workout_sessions.program_phase (spec rule #28) and from GoalsRepo's
// own active/priority fields (a goal can be active with no phase yet,
// or between phases). Lifecycle: active -> review_due -> review ->
// (continue back to active | adjust: this phase completes, a new one
// begins | graduate: this phase completes, the goal itself is
// deactivated elsewhere). "No volume debt transfers from one phase to
// another" (spec rule) is structural here: a new phase's own row
// carries nothing from its predecessor except goal_id — see create().

export type GoalPhaseStatus = 'active' | 'review_due' | 'review' | 'completed';
export type DevelopmentPackageLevel = 'complete' | 'efficient';

export interface GoalPhase {
  id: string;
  goal_id: string;
  start_date: string;
  review_date: string;
  status: GoalPhaseStatus;
  package_level: DevelopmentPackageLevel | null;
  priority_snapshot: number | null;
  emphasis: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CreateGoalPhaseInput {
  goal_id: string;
  start_date: string;
  review_date: string;
  package_level?: DevelopmentPackageLevel | null;
  priority_snapshot?: number | null;
  emphasis?: string | null;
}

export class UnknownGoalPhaseError extends Error {
  constructor(public goalPhaseId: string) {
    super(`No goal phase found with id "${goalPhaseId}"`);
  }
}

function rowToPhase(row: GoalPhase): GoalPhase {
  return row;
}

export class GoalPhaseRepo {
  constructor(private db: Database.Database) {}

  /** A phase always starts 'active' — no phase is ever created directly
   * into review_due/review/completed. */
  create(input: CreateGoalPhaseInput): GoalPhase {
    const phase: GoalPhase = {
      id: newId('gphase'),
      goal_id: input.goal_id,
      start_date: input.start_date,
      review_date: input.review_date,
      status: 'active',
      package_level: input.package_level ?? null,
      priority_snapshot: input.priority_snapshot ?? null,
      emphasis: input.emphasis ?? null,
      created_at: nowIso(),
      completed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO goal_phases (id, goal_id, start_date, review_date, status, package_level, priority_snapshot, emphasis, created_at, completed_at)
         VALUES (@id, @goal_id, @start_date, @review_date, @status, @package_level, @priority_snapshot, @emphasis, @created_at, @completed_at)`
      )
      .run(phase);
    return phase;
  }

  get(id: string): GoalPhase | undefined {
    const row = this.db.prepare('SELECT * FROM goal_phases WHERE id = ?').get(id) as GoalPhase | undefined;
    return row ? rowToPhase(row) : undefined;
  }

  /** Every phase this goal has ever had, most-recent-first — completed
   * phases remain historical (spec rule: "previous phases remain
   * historical"), never deleted or overwritten by a later phase. */
  listForGoal(goalId: string): GoalPhase[] {
    const rows = this.db.prepare('SELECT * FROM goal_phases WHERE goal_id = ? ORDER BY created_at DESC').all(goalId) as GoalPhase[];
    return rows.map(rowToPhase);
  }

  /** The one non-completed phase for this goal, if any — a goal has at
   * most one at a time (enforced by always completing the prior phase
   * before create() is called again, in goalPhaseEngine.ts). */
  getActiveForGoal(goalId: string): GoalPhase | undefined {
    const row = this.db
      .prepare(`SELECT * FROM goal_phases WHERE goal_id = ? AND status != 'completed' ORDER BY created_at DESC LIMIT 1`)
      .get(goalId) as GoalPhase | undefined;
    return row ? rowToPhase(row) : undefined;
  }

  private transition(id: string, from: readonly GoalPhaseStatus[], to: GoalPhaseStatus): GoalPhase | undefined {
    const existing = this.get(id);
    if (!existing || !from.includes(existing.status)) return undefined;
    this.db.prepare('UPDATE goal_phases SET status = ? WHERE id = ?').run(to, id);
    return this.get(id);
  }

  /** A phase's review_date has arrived — active -> review_due. A no-op
   * (returns undefined) if the phase isn't currently 'active'. */
  markReviewDue(id: string): GoalPhase | undefined {
    return this.transition(id, ['active'], 'review_due');
  }

  /** The review engine is now actively evaluating this phase —
   * review_due -> review. */
  beginReview(id: string): GoalPhase | undefined {
    return this.transition(id, ['review_due'], 'review');
  }

  /** 'continue' outcome: the SAME phase goes back to 'active' with a
   * new review_date — no new phase, no reset of start_date, exactly
   * "phase progression does not automatically mean volume escalation"
   * (spec rule #22): continuing changes nothing about this phase's own
   * package_level/emphasis. */
  continueActive(id: string, newReviewDate: string): GoalPhase | undefined {
    const existing = this.get(id);
    if (!existing || existing.status !== 'review') return undefined;
    this.db.prepare(`UPDATE goal_phases SET status = 'active', review_date = ? WHERE id = ?`).run(newReviewDate, id);
    return this.get(id);
  }

  /** Marks this phase 'completed' (adjust or graduate outcome) — never
   * deleted, remains real history. */
  complete(id: string): GoalPhase | undefined {
    const existing = this.get(id);
    if (!existing || existing.status === 'completed') return undefined;
    this.db.prepare(`UPDATE goal_phases SET status = 'completed', completed_at = ? WHERE id = ?`).run(nowIso(), id);
    return this.get(id);
  }
}
