import type Database from 'better-sqlite3';
import type { AestheticAssessment } from '../contracts/types.js';
import { ASSESSMENT_SCALE } from '../engine/config.js';
import { newId, nowIso } from './ids.js';

export class InvalidAssessmentRatingError extends Error {
  constructor(public rating: number) {
    super(`rating must be an integer between ${ASSESSMENT_SCALE.min} and ${ASSESSMENT_SCALE.max}, got ${rating}`);
    this.name = 'InvalidAssessmentRatingError';
  }
}

export interface RecordAssessmentInput {
  goal_id: string;
  date: string;
  rating: number;
  notes?: string | null;
}

/** Dated 1-5 user assessments of aesthetic progress — spec §3. Never the
 * source of a "workout strength alone proves progress" claim; this is
 * the deliberately separate signal for that. */
export class AestheticAssessmentsRepo {
  constructor(private db: Database.Database) {}

  record(input: RecordAssessmentInput): AestheticAssessment {
    if (!Number.isInteger(input.rating) || input.rating < ASSESSMENT_SCALE.min || input.rating > ASSESSMENT_SCALE.max) {
      throw new InvalidAssessmentRatingError(input.rating);
    }

    const assessment: AestheticAssessment = {
      id: newId('assessment'),
      goal_id: input.goal_id,
      date: input.date,
      rating: input.rating as AestheticAssessment['rating'],
      notes: input.notes ?? null,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO aesthetic_assessments (id, goal_id, date, rating, notes, created_at)
         VALUES (@id, @goal_id, @date, @rating, @notes, @created_at)`
      )
      .run(assessment);
    return assessment;
  }

  listForGoal(goalId: string): AestheticAssessment[] {
    const rows = this.db
      .prepare('SELECT * FROM aesthetic_assessments WHERE goal_id = ? ORDER BY date ASC')
      .all(goalId) as AestheticAssessment[];
    return rows;
  }
}
