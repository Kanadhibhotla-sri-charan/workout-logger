import type Database from 'better-sqlite3';
import type { OutsideBlueprintExercise, OutsideBlueprintJustification } from '../contracts/types.js';
import { newId, nowIso } from './ids.js';

export interface ProposeOutsideBlueprintExerciseInput {
  name: string;
  description?: string | null;
  justification_category: OutsideBlueprintJustification;
  justification_text: string;
}

/**
 * Spec §4.2: an exercise outside Blueprint's pool may only be *proposed*
 * when Blueprint can't adequately satisfy the requirement, a contextual
 * constraint makes Blueprint exercises unsuitable, or an outside exercise
 * offers a clearly meaningful advantage. It must never silently become
 * prescribable — `approved` starts false and only a separate, explicit
 * `approve()` call flips it. See src/engine/exerciseUniverse.ts for where
 * this gate is enforced against workout/program writes.
 */
export class OutsideBlueprintExercisesRepo {
  constructor(private db: Database.Database) {}

  propose(input: ProposeOutsideBlueprintExerciseInput): OutsideBlueprintExercise {
    const exercise: OutsideBlueprintExercise = {
      id: newId('outside-ex'),
      name: input.name,
      description: input.description ?? null,
      justification_category: input.justification_category,
      justification_text: input.justification_text,
      proposed_at: nowIso(),
      approved: false,
      approved_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO outside_blueprint_exercises
           (id, name, description, justification_category, justification_text, proposed_at, approved, approved_at)
         VALUES (@id, @name, @description, @justification_category, @justification_text, @proposed_at, 0, NULL)`
      )
      .run(exercise);
    return exercise;
  }

  /** The only way an outside-Blueprint exercise becomes prescribable —
   * an explicit, separate call representing the user's approval. Never
   * invoked automatically by proposal creation. */
  approve(id: string): OutsideBlueprintExercise | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    this.db.prepare('UPDATE outside_blueprint_exercises SET approved = 1, approved_at = ? WHERE id = ?').run(nowIso(), id);
    return this.get(id);
  }

  get(id: string): OutsideBlueprintExercise | undefined {
    const row = this.db.prepare('SELECT * FROM outside_blueprint_exercises WHERE id = ?').get(id) as
      | (Omit<OutsideBlueprintExercise, 'approved'> & { approved: number })
      | undefined;
    return row ? { ...row, approved: row.approved === 1 } : undefined;
  }

  list(): OutsideBlueprintExercise[] {
    const rows = this.db.prepare('SELECT * FROM outside_blueprint_exercises ORDER BY proposed_at DESC').all() as Array<
      Omit<OutsideBlueprintExercise, 'approved'> & { approved: number }
    >;
    return rows.map((r) => ({ ...r, approved: r.approved === 1 }));
  }
}
