import type Database from 'better-sqlite3';
import type { OutsideBlueprintExercise, OutsideBlueprintJustification } from '../contracts/types.js';
import { parseRange } from '../blueprint/developmentPackages.js';
import { newId, nowIso } from './ids.js';

export interface ProposeOutsideBlueprintExerciseInput {
  name: string;
  description?: string | null;
  justification_category: OutsideBlueprintJustification;
  justification_text: string;
  target_type: 'physique_target' | 'functional_goal';
  target_id: string;
  role: 'primary' | 'secondary';
  equipment: string[];
  reps_range: string;
  rir_range: string;
}

export class InvalidOutsideBlueprintExerciseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutsideBlueprintExerciseError';
  }
}

interface OutsideBlueprintExerciseRow {
  id: string;
  name: string;
  description: string | null;
  justification_category: OutsideBlueprintJustification;
  justification_text: string;
  target_type: 'physique_target' | 'functional_goal';
  target_id: string;
  role: 'primary' | 'secondary';
  equipment: string;
  reps_range: string;
  rir_range: string;
  proposed_at: string;
  approved: number;
  approved_at: string | null;
}

function rowToExercise(row: OutsideBlueprintExerciseRow): OutsideBlueprintExercise {
  return { ...row, equipment: JSON.parse(row.equipment), approved: row.approved === 1 };
}

/**
 * Spec §4.2: an exercise outside Blueprint's pool may only be *proposed*
 * when Blueprint can't adequately satisfy the requirement, a contextual
 * constraint makes Blueprint exercises unsuitable, or an outside exercise
 * offers a clearly meaningful advantage. It must never silently become
 * prescribable — `approved` starts false and only a separate, explicit
 * `approve()` call flips it. See src/engine/exerciseUniverse.ts for where
 * this gate is enforced against workout/program writes, and
 * src/engine/workoutBuilder.ts for where an approved one becomes a real
 * exercise-selection candidate (remediation §10).
 *
 * target_type/target_id/role/equipment/reps_range/rir_range are required
 * at proposal time — a real programming candidate, not just an approval
 * record with nothing to actually prescribe once approved.
 */
export class OutsideBlueprintExercisesRepo {
  constructor(private db: Database.Database) {}

  propose(input: ProposeOutsideBlueprintExerciseInput): OutsideBlueprintExercise {
    if (input.equipment.length === 0) {
      throw new InvalidOutsideBlueprintExerciseError('equipment must list at least one item (or an explicit "bodyweight" entry)');
    }
    // The same range format Blueprint's own package data uses (and the
    // same parser, src/blueprint/developmentPackages.ts's parseRange)
    // applies identically to a human-proposed exercise — re-thrown as
    // this repo's own error type so callers get one consistent error
    // class to handle, not a mix of this repo's and parseRange's.
    for (const [field, value] of [
      ['reps_range', input.reps_range],
      ['rir_range', input.rir_range],
    ] as const) {
      try {
        parseRange(value);
      } catch {
        throw new InvalidOutsideBlueprintExerciseError(`${field} must be a range like "8-12" or a single number, got "${value}"`);
      }
    }

    const exercise: OutsideBlueprintExercise = {
      id: newId('outside-ex'),
      name: input.name,
      description: input.description ?? null,
      justification_category: input.justification_category,
      justification_text: input.justification_text,
      target_type: input.target_type,
      target_id: input.target_id,
      role: input.role,
      equipment: input.equipment,
      reps_range: input.reps_range,
      rir_range: input.rir_range,
      proposed_at: nowIso(),
      approved: false,
      approved_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO outside_blueprint_exercises
           (id, name, description, justification_category, justification_text, target_type, target_id, role, equipment, reps_range, rir_range, proposed_at, approved, approved_at)
         VALUES (@id, @name, @description, @justification_category, @justification_text, @target_type, @target_id, @role, @equipment, @reps_range, @rir_range, @proposed_at, 0, NULL)`
      )
      .run({ ...exercise, equipment: JSON.stringify(exercise.equipment) });
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
    const row = this.db.prepare('SELECT * FROM outside_blueprint_exercises WHERE id = ?').get(id) as OutsideBlueprintExerciseRow | undefined;
    return row ? rowToExercise(row) : undefined;
  }

  list(): OutsideBlueprintExercise[] {
    const rows = this.db.prepare('SELECT * FROM outside_blueprint_exercises ORDER BY proposed_at DESC').all() as OutsideBlueprintExerciseRow[];
    return rows.map(rowToExercise);
  }

  /** All approved outside-Blueprint exercises serving `targetType`/
   * `targetId` — the candidate-gathering entry point
   * src/engine/workoutBuilder.ts uses as a fallback pool alongside
   * Blueprint's own exercises (remediation §10). An unapproved proposal
   * never appears here, matching exerciseUniverse's resolution rule. */
  listApprovedForTarget(targetType: 'physique_target' | 'functional_goal', targetId: string): OutsideBlueprintExercise[] {
    const rows = this.db
      .prepare('SELECT * FROM outside_blueprint_exercises WHERE approved = 1 AND target_type = ? AND target_id = ? ORDER BY proposed_at ASC')
      .all(targetType, targetId) as OutsideBlueprintExerciseRow[];
    return rows.map(rowToExercise);
  }
}
