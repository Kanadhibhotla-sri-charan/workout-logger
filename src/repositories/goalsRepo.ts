import type Database from 'better-sqlite3';
import type { Goal, GoalType } from '../contracts/types.js';
import { newId, nowIso } from './ids.js';

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

export interface CreateGoalInput {
  goal_type: GoalType;
  blueprint_ref: string;
  priority: number;
  notes?: string | null;
  active?: boolean;
}

export class GoalsRepo {
  constructor(private db: Database.Database) {}

  create(input: CreateGoalInput): Goal {
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
}
