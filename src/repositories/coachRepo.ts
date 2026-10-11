import type Database from 'better-sqlite3';
import { addDays } from '../engine/dateMath.js';
import { newId, nowIso } from './ids.js';

export type CoachAdviceKind = 'rep_range' | 'load' | 'swap' | 'technique' | 'volume';
export type CoachAdviceStatus = 'open' | 'accepted' | 'dismissed';

export interface CoachReviewBody {
  headline: string;
  wentWell: string[];
  needsAttention: string[];
  focusThisWeek: string[];
  recovery: string;
}

export interface CoachAdvice {
  id: string;
  reviewId: string;
  exerciseId: string;
  kind: CoachAdviceKind;
  observation: string;
  suggestion: string;
  swapToExerciseId: string | null;
  status: CoachAdviceStatus;
  decidedOn: string | null;
}

export interface CoachReview {
  id: string;
  weekStart: string;
  asOf: string;
  review: CoachReviewBody;
  model: string | null;
  createdAt: string;
  advice: CoachAdvice[];
}

/** How long accepted coach advice stays in the generation context. */
export const COACH_ADVICE_ACTIVE_DAYS = 21;

interface AdviceRow {
  id: string;
  review_id: string;
  exercise_id: string;
  kind: CoachAdviceKind;
  observation: string;
  suggestion: string;
  swap_to_exercise_id: string | null;
  status: CoachAdviceStatus;
  decided_on: string | null;
}

const toAdvice = (r: AdviceRow): CoachAdvice => ({
  id: r.id,
  reviewId: r.review_id,
  exerciseId: r.exercise_id,
  kind: r.kind,
  observation: r.observation,
  suggestion: r.suggestion,
  swapToExerciseId: r.swap_to_exercise_id,
  status: r.status,
  decidedOn: r.decided_on,
});

/** Weekly coach reviews and their plateau advice. */
export class CoachRepo {
  constructor(private db: Database.Database) {}

  saveReview(input: {
    weekStart: string;
    asOf: string;
    review: CoachReviewBody;
    advice: Array<Pick<CoachAdvice, 'exerciseId' | 'kind' | 'observation' | 'suggestion' | 'swapToExerciseId'>>;
    model: string | null;
    requestId: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }): CoachReview {
    const id = newId('coachreview');
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO coach_reviews (id, week_start, as_of, review_json, model, request_id, input_tokens, output_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.weekStart, input.asOf, JSON.stringify(input.review), input.model, input.requestId, input.inputTokens, input.outputTokens, now);
      const insert = this.db.prepare(
        `INSERT INTO coach_advice (id, review_id, exercise_id, kind, observation, suggestion, swap_to_exercise_id, status, decided_on, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?)`
      );
      for (const a of input.advice) insert.run(newId('coachadvice'), id, a.exerciseId, a.kind, a.observation, a.suggestion, a.swapToExerciseId, now);
    })();
    return this.latestReview()!;
  }

  latestReview(): CoachReview | null {
    const row = this.db.prepare('SELECT * FROM coach_reviews ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as
      | { id: string; week_start: string; as_of: string; review_json: string; model: string | null; created_at: string }
      | undefined;
    if (!row) return null;
    const advice = (this.db.prepare('SELECT * FROM coach_advice WHERE review_id = ? ORDER BY rowid').all(row.id) as AdviceRow[]).map(toAdvice);
    return { id: row.id, weekStart: row.week_start, asOf: row.as_of, review: JSON.parse(row.review_json), model: row.model, createdAt: row.created_at, advice };
  }

  hasReviewForWeek(weekStart: string): boolean {
    return this.db.prepare('SELECT 1 FROM coach_reviews WHERE week_start = ? LIMIT 1').get(weekStart) !== undefined;
  }

  getAdvice(id: string): CoachAdvice | null {
    const row = this.db.prepare('SELECT * FROM coach_advice WHERE id = ?').get(id) as AdviceRow | undefined;
    return row ? toAdvice(row) : null;
  }

  decide(id: string, status: 'accepted' | 'dismissed', on: string): void {
    this.db.prepare('UPDATE coach_advice SET status = ?, decided_on = ? WHERE id = ?').run(status, on, id);
  }

  /** Advice accepted within the last COACH_ADVICE_ACTIVE_DAYS days of `asOf`. */
  activeAccepted(asOf: string): CoachAdvice[] {
    return (
      this.db
        .prepare("SELECT * FROM coach_advice WHERE status = 'accepted' AND decided_on >= ? AND decided_on <= ? ORDER BY decided_on")
        .all(addDays(asOf, -COACH_ADVICE_ACTIVE_DAYS), asOf) as AdviceRow[]
    ).map(toAdvice);
  }
}
