import type Database from 'better-sqlite3';
import { BlueprintAdapter, type BlueprintAestheticOutcome, type BlueprintFunctionalGoal } from '../blueprint/adapter.js';
import type { Goal, GoalType } from '../contracts/types.js';
import { newId, nowIso } from './ids.js';

export class UnknownBlueprintGoalReferenceError extends Error {
  constructor(public goalType: GoalType, public blueprintRef: string) {
    super(`"${blueprintRef}" is not a known Blueprint ${goalType} goal id`);
    this.name = 'UnknownBlueprintGoalReferenceError';
  }
}

interface GoalRow {
  id: string;
  goal_type: GoalType;
  blueprint_ref: string;
  priority: number;
  notes: string | null;
  active: number;
  created_at: string;
}

function rowToGoal(row: GoalRow): Goal {
  return { ...row, active: row.active === 1 };
}

/** Resolves goal.blueprint_ref through BlueprintAdapter, keyed on
 * goal.goal_type. Throws UnknownBlueprintGoalReferenceError if it doesn't
 * resolve — a Goal must never point at a Blueprint id that doesn't exist. */
function resolveBlueprintRef(goal: Pick<Goal, 'goal_type' | 'blueprint_ref'>): BlueprintAestheticOutcome | BlueprintFunctionalGoal {
  const resolved =
    goal.goal_type === 'aesthetic'
      ? BlueprintAdapter.getAestheticGoal(goal.blueprint_ref)
      : BlueprintAdapter.getFunctionalGoal(goal.blueprint_ref);
  if (!resolved) {
    throw new UnknownBlueprintGoalReferenceError(goal.goal_type, goal.blueprint_ref);
  }
  return resolved;
}

export interface CreateGoalInput {
  goal_type: GoalType;
  blueprint_ref: string;
  priority: number;
  notes?: string | null;
  active?: boolean;
}

export class GoalsRepo {
  constructor(private db: Database.Database) {}

  /** Creates a local Goal instance. `input.blueprint_ref` is validated
   * against BlueprintAdapter before anything is written — an invalid
   * reference fails cleanly and nothing is persisted. Note that the
   * returned Goal.id (this app's own identifier for this instance) is
   * never the same value as blueprint_ref (Blueprint's identifier for the
   * underlying outcome/goal) — see the Goal type doc comment. */
  create(input: CreateGoalInput): Goal {
    resolveBlueprintRef(input);

    const goal: Goal = {
      id: newId('goal'),
      goal_type: input.goal_type,
      blueprint_ref: input.blueprint_ref,
      priority: input.priority,
      notes: input.notes ?? null,
      active: input.active ?? true,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO goals (id, goal_type, blueprint_ref, priority, notes, active, created_at)
         VALUES (@id, @goal_type, @blueprint_ref, @priority, @notes, @active, @created_at)`
      )
      .run({ ...goal, active: goal.active ? 1 : 0 });
    return goal;
  }

  get(id: string): Goal | undefined {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | undefined;
    return row ? rowToGoal(row) : undefined;
  }

  list(opts: { active?: boolean } = {}): Goal[] {
    const rows =
      opts.active === undefined
        ? (this.db.prepare('SELECT * FROM goals ORDER BY priority ASC').all() as GoalRow[])
        : (this.db
            .prepare('SELECT * FROM goals WHERE active = ? ORDER BY priority ASC')
            .all(opts.active ? 1 : 0) as GoalRow[]);
    return rows.map(rowToGoal);
  }

  /** Resolves a local Goal (by its own id) through to the Blueprint
   * knowledge it references: goal.id -> Goal row -> goal.blueprint_ref ->
   * BlueprintAdapter. Returns undefined if the Goal itself doesn't exist;
   * throws UnknownBlueprintGoalReferenceError if a stored blueprint_ref
   * somehow no longer resolves (e.g. Blueprint data changed underneath a
   * stale reference). */
  resolveBlueprint(id: string): BlueprintAestheticOutcome | BlueprintFunctionalGoal | undefined {
    const goal = this.get(id);
    if (!goal) return undefined;
    return resolveBlueprintRef(goal);
  }
}
