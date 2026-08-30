import type Database from 'better-sqlite3';
import { BlueprintAdapter, type BlueprintAestheticOutcome, type BlueprintFunctionalGoal } from '../blueprint/adapter.js';
import type { Goal, GoalType } from '../contracts/types.js';
import { MAX_ACTIVE_AESTHETIC_GOALS, REVIEW_CADENCE_DEFAULT_DAYS } from '../engine/config.js';
import { GoalEventsRepo } from './goalEventsRepo.js';
import { newId, nowIso } from './ids.js';

export class UnknownBlueprintGoalReferenceError extends Error {
  constructor(public goalType: GoalType, public blueprintRef: string) {
    super(`"${blueprintRef}" is not a known Blueprint ${goalType} goal id`);
    this.name = 'UnknownBlueprintGoalReferenceError';
  }
}

/** Spec §1.2: max MAX_ACTIVE_AESTHETIC_GOALS (2) simultaneous active
 * aesthetic goals in V1 — a hard cap, not a suggestion. */
export class TooManyActiveAestheticGoalsError extends Error {
  constructor(public limit: number) {
    super(`Cannot activate another aesthetic goal — the limit of ${limit} active aesthetic goals is already reached. Deactivate one first.`);
    this.name = 'TooManyActiveAestheticGoalsError';
  }
}

interface GoalRow {
  id: string;
  goal_type: GoalType;
  blueprint_ref: string;
  priority: number;
  notes: string | null;
  active: number;
  review_cadence_days: number;
  source: Goal['source'];
  source_text: string | null;
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
  review_cadence_days?: number;
  source?: Goal['source'];
  source_text?: string | null;
}

export class GoalsRepo {
  constructor(private db: Database.Database) {}

  /** Creates a local Goal instance. `input.blueprint_ref` is validated
   * against BlueprintAdapter before anything is written — an invalid
   * reference fails cleanly and nothing is persisted. If the goal is
   * active and aesthetic, enforces the spec §1.2 cap of
   * MAX_ACTIVE_AESTHETIC_GOALS — nothing is persisted if the cap is
   * already reached. Note that the returned Goal.id (this app's own
   * identifier for this instance) is never the same value as
   * blueprint_ref (Blueprint's identifier for the underlying outcome/
   * goal) — see the Goal type doc comment. */
  create(input: CreateGoalInput): Goal {
    resolveBlueprintRef(input);

    const active = input.active ?? true;
    if (active && input.goal_type === 'aesthetic') {
      const activeCount = this.list({ active: true, goal_type: 'aesthetic' }).length;
      if (activeCount >= MAX_ACTIVE_AESTHETIC_GOALS) {
        throw new TooManyActiveAestheticGoalsError(MAX_ACTIVE_AESTHETIC_GOALS);
      }
    }

    const goal: Goal = {
      id: newId('goal'),
      goal_type: input.goal_type,
      blueprint_ref: input.blueprint_ref,
      priority: input.priority,
      notes: input.notes ?? null,
      active,
      review_cadence_days: input.review_cadence_days ?? REVIEW_CADENCE_DEFAULT_DAYS[input.goal_type],
      source: input.source ?? 'structured',
      source_text: input.source_text ?? null,
      created_at: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO goals (id, goal_type, blueprint_ref, priority, notes, active, review_cadence_days, source, source_text, created_at)
         VALUES (@id, @goal_type, @blueprint_ref, @priority, @notes, @active, @review_cadence_days, @source, @source_text, @created_at)`
      )
      .run({ ...goal, active: goal.active ? 1 : 0 });

    const eventsRepo = new GoalEventsRepo(this.db);
    eventsRepo.record({ goal_id: goal.id, event_type: 'created', detail: { blueprint_ref: goal.blueprint_ref, priority: goal.priority } });
    if (goal.active) {
      eventsRepo.record({ goal_id: goal.id, event_type: 'activated' });
    }

    return goal;
  }

  get(id: string): Goal | undefined {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | undefined;
    return row ? rowToGoal(row) : undefined;
  }

  list(opts: { active?: boolean; goal_type?: GoalType } = {}): Goal[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.active !== undefined) {
      clauses.push('active = ?');
      params.push(opts.active ? 1 : 0);
    }
    if (opts.goal_type !== undefined) {
      clauses.push('goal_type = ?');
      params.push(opts.goal_type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM goals ${where} ORDER BY priority ASC`).all(...params) as GoalRow[];
    return rows.map(rowToGoal);
  }

  /** Deactivates a goal — spec §1.2: "a goal may be deactivated/replaced
   * when the user changes focus." Frees a slot under the active-aesthetic-
   * goal cap. Records a 'deactivated' event; the goal row itself and its
   * full history are kept, never deleted, so it can be reactivated later
   * with its evidence intact (§18). */
  deactivate(id: string, notes?: string | null): Goal | undefined {
    const goal = this.get(id);
    if (!goal || !goal.active) return goal;

    this.db.prepare('UPDATE goals SET active = 0 WHERE id = ?').run(id);
    new GoalEventsRepo(this.db).record({ goal_id: id, event_type: 'deactivated', notes: notes ?? null });
    return this.get(id);
  }

  /** Reactivates a previously deactivated goal — still subject to the
   * active-aesthetic-goal cap. */
  reactivate(id: string): Goal | undefined {
    const goal = this.get(id);
    if (!goal || goal.active) return goal;

    if (goal.goal_type === 'aesthetic') {
      const activeCount = this.list({ active: true, goal_type: 'aesthetic' }).length;
      if (activeCount >= MAX_ACTIVE_AESTHETIC_GOALS) {
        throw new TooManyActiveAestheticGoalsError(MAX_ACTIVE_AESTHETIC_GOALS);
      }
    }

    this.db.prepare('UPDATE goals SET active = 1 WHERE id = ?').run(id);
    new GoalEventsRepo(this.db).record({ goal_id: id, event_type: 'activated', notes: 'reactivated' });
    return this.get(id);
  }

  /** Changes a goal's user-controlled rank. Spec §2.2/§17: priority is
   * always explicit user input, this repo never computes or infers it. */
  setPriority(id: string, priority: number): Goal | undefined {
    const goal = this.get(id);
    if (!goal) return undefined;
    if (goal.priority === priority) return goal;

    this.db.prepare('UPDATE goals SET priority = ? WHERE id = ?').run(priority, id);
    new GoalEventsRepo(this.db).record({
      goal_id: id,
      event_type: 'priority_changed',
      detail: { from: goal.priority, to: priority },
    });
    return this.get(id);
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
