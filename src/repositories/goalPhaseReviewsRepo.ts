import type Database from 'better-sqlite3';
import { newId, nowIso } from './ids.js';

// Programming Redesign (Step 12) §12-§13: persisted review
// evidence/recommendation/decision — "must allow a later user/developer
// to understand what evidence informed the decision." Never mutates
// `evidence`/`system_recommendation`/`reason` after creation (that would
// rewrite what the engine actually said); only `user_decision`/
// `decided_at` are ever set, exactly once, by recordUserDecision.

export type ReviewRecommendation = 'continue' | 'adjust' | 'graduate';

export interface GoalPhaseReview {
  id: string;
  goal_phase_id: string;
  review_date: string;
  system_recommendation: ReviewRecommendation;
  user_decision: ReviewRecommendation | null;
  evidence: unknown;
  reason: string;
  created_at: string;
  decided_at: string | null;
}

export interface CreateGoalPhaseReviewInput {
  goal_phase_id: string;
  review_date: string;
  system_recommendation: ReviewRecommendation;
  evidence: unknown;
  reason: string;
}

interface GoalPhaseReviewRow {
  id: string;
  goal_phase_id: string;
  review_date: string;
  system_recommendation: ReviewRecommendation;
  user_decision: ReviewRecommendation | null;
  evidence_json: string;
  reason: string;
  created_at: string;
  decided_at: string | null;
}

function rowToReview(row: GoalPhaseReviewRow): GoalPhaseReview {
  return {
    id: row.id,
    goal_phase_id: row.goal_phase_id,
    review_date: row.review_date,
    system_recommendation: row.system_recommendation,
    user_decision: row.user_decision,
    evidence: JSON.parse(row.evidence_json),
    reason: row.reason,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

export class GoalPhaseReviewsRepo {
  constructor(private db: Database.Database) {}

  create(input: CreateGoalPhaseReviewInput): GoalPhaseReview {
    const row: GoalPhaseReviewRow = {
      id: newId('greview'),
      goal_phase_id: input.goal_phase_id,
      review_date: input.review_date,
      system_recommendation: input.system_recommendation,
      user_decision: null,
      evidence_json: JSON.stringify(input.evidence),
      reason: input.reason,
      created_at: nowIso(),
      decided_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO goal_phase_reviews (id, goal_phase_id, review_date, system_recommendation, user_decision, evidence_json, reason, created_at, decided_at)
         VALUES (@id, @goal_phase_id, @review_date, @system_recommendation, @user_decision, @evidence_json, @reason, @created_at, @decided_at)`
      )
      .run(row);
    return rowToReview(row);
  }

  get(id: string): GoalPhaseReview | undefined {
    const row = this.db.prepare('SELECT * FROM goal_phase_reviews WHERE id = ?').get(id) as GoalPhaseReviewRow | undefined;
    return row ? rowToReview(row) : undefined;
  }

  listForPhase(goalPhaseId: string): GoalPhaseReview[] {
    const rows = this.db.prepare('SELECT * FROM goal_phase_reviews WHERE goal_phase_id = ? ORDER BY created_at DESC').all(goalPhaseId) as GoalPhaseReviewRow[];
    return rows.map(rowToReview);
  }

  /** Spec §12: "the engine recommends, the user decides." The user's
   * decision can differ from system_recommendation — that is not an
   * error, it is the whole point of keeping the two fields distinct.
   * A no-op (returns undefined) once a decision has already been
   * recorded — a decision, once made, is not silently overwritten. */
  recordUserDecision(id: string, decision: ReviewRecommendation): GoalPhaseReview | undefined {
    const existing = this.get(id);
    if (!existing || existing.decided_at !== null) return undefined;
    this.db.prepare('UPDATE goal_phase_reviews SET user_decision = ?, decided_at = ? WHERE id = ?').run(decision, nowIso(), id);
    return this.get(id);
  }
}
