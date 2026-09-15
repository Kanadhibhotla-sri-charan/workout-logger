import type Database from 'better-sqlite3';
import { BlueprintAdapter, type BlueprintAestheticOutcome, type BlueprintFunctionalGoal } from '../blueprint/adapter.js';
import type { Goal, GoalType } from '../contracts/types.js';
import {
  MAX_ACTIVE_AESTHETIC_GOALS,
  PULL_PHYSIQUE_TARGETS,
  PUSH_PHYSIQUE_TARGETS,
  LEGS_PHYSIQUE_TARGETS,
  REVIEW_CADENCE_DEFAULT_DAYS,
} from '../engine/config.js';
import { addDays } from '../engine/dateMath.js';
import { todayForUser } from '../lib/userTimezone.js';
import { GoalEventsRepo } from './goalEventsRepo.js';
import { GoalPhaseRepo } from './goalPhaseRepo.js';
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

/** Goal Same-Day Conflict Fix (2026-09-14): two active aesthetic goals
 * whose own Blueprint targets both fall in the same push/pull/legs
 * category (e.g. a chest goal and a triceps goal, both push) previously
 * had no reason to ever land on different real sessions — the
 * deterministic engine schedules by session-purpose compatibility, not
 * by goal identity, so two same-category goals always compete for the
 * SAME session's limited capacity every single week, rather than each
 * getting a session of its own. Verified against every real Blueprint
 * aesthetic outcome (26 total, `programming.json`): 25 are single-
 * category; exactly one (`arm-side-thickness`) spans two (push:
 * triceps + pull: brachialis) — by explicit product decision, a goal
 * that itself spans more than one category counts as occupying BOTH,
 * so it can never be paired with any other active aesthetic goal, not
 * just ones sharing one of its two categories. */
export class ConflictingGoalCategoryError extends Error {
  constructor(public newBlueprintRef: string, public conflictingBlueprintRef: string) {
    super(
      `Cannot activate "${newBlueprintRef}" alongside "${conflictingBlueprintRef}" — both would compete for the same push/pull/legs session every week instead of each getting a real session of its own. Deactivate "${conflictingBlueprintRef}" first, or choose a goal in a different category.`
    );
    this.name = 'ConflictingGoalCategoryError';
  }
}

type PplCategory = 'push' | 'pull' | 'legs';

/** The real push/pull/legs categories a Blueprint aesthetic outcome's
 * own targets fall into — reuses the exact same PUSH_PHYSIQUE_TARGETS/
 * PULL_PHYSIQUE_TARGETS/LEGS_PHYSIQUE_TARGETS lists the deterministic
 * engine's own session-purpose eligibility already uses (config.ts),
 * never a second, independently-maintained classification. A universal
 * target (abs, neck — eligible on every session) contributes no
 * category and can never itself cause a conflict. `primary_targets` and
 * `supporting_targets` (optional in the raw Blueprint data — see
 * BlueprintAestheticOutcome's own doc comment) are both considered:
 * either can genuinely land the goal's real work on a given day. */
function ppiCategoriesForGoal(outcome: BlueprintAestheticOutcome): Set<PplCategory> {
  const targets = [...outcome.primary_targets, ...(outcome.supporting_targets ?? [])];
  const categories = new Set<PplCategory>();
  for (const targetId of targets) {
    if (PUSH_PHYSIQUE_TARGETS.includes(targetId)) categories.add('push');
    else if (PULL_PHYSIQUE_TARGETS.includes(targetId)) categories.add('pull');
    else if (LEGS_PHYSIQUE_TARGETS.includes(targetId)) categories.add('legs');
  }
  return categories;
}

/** Throws ConflictingGoalCategoryError if `newOutcome` cannot be
 * activated alongside `existingActiveGoals` — either it shares a real
 * push/pull/legs category with one of them, or either side spans more
 * than one category itself (which by definition always overlaps
 * whatever the other side occupies). Only ever called for aesthetic
 * goals — functional goals have no Blueprint push/pull/legs
 * classification and are exempt from this rule entirely. */
function assertNoGoalCategoryConflict(newOutcome: BlueprintAestheticOutcome, existingActiveGoals: readonly Goal[]): void {
  const newCategories = ppiCategoriesForGoal(newOutcome);
  for (const existing of existingActiveGoals) {
    if (existing.goal_type !== 'aesthetic' || existing.blueprint_ref === newOutcome.id) continue;
    const existingOutcome = BlueprintAdapter.getAestheticGoal(existing.blueprint_ref);
    if (!existingOutcome) continue; // an already-invalid stored reference is a separate, pre-existing failure mode
    const existingCategories = ppiCategoriesForGoal(existingOutcome);
    const spansMultiple = newCategories.size > 1 || existingCategories.size > 1;
    const overlaps = [...newCategories].some((c) => existingCategories.has(c));
    if (spansMultiple || overlaps) {
      throw new ConflictingGoalCategoryError(newOutcome.id, existingOutcome.id);
    }
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

  /** Remediation (Step 12 Fix) §5: connects the goal lifecycle to the
   * goal-phase lifecycle — an active goal should have an appropriate
   * active phase, so becoming active (creation or reactivation) starts
   * one if it doesn't already have one. Complete package level: an
   * active goal is by definition a training priority. A no-op if the
   * goal already has a non-completed phase (never opens a second
   * concurrent one). */
  private ensureActivePhase(goal: Goal): void {
    const phaseRepo = new GoalPhaseRepo(this.db);
    if (phaseRepo.getActiveForGoal(goal.id)) return;
    const startDate = todayForUser(this.db);
    phaseRepo.create({
      goal_id: goal.id,
      start_date: startDate,
      review_date: addDays(startDate, goal.review_cadence_days),
      package_level: 'complete',
    });
  }

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
    const resolved = resolveBlueprintRef(input);

    const active = input.active ?? true;
    if (active && input.goal_type === 'aesthetic') {
      const activeAestheticGoals = this.list({ active: true, goal_type: 'aesthetic' });
      if (activeAestheticGoals.length >= MAX_ACTIVE_AESTHETIC_GOALS) {
        throw new TooManyActiveAestheticGoalsError(MAX_ACTIVE_AESTHETIC_GOALS);
      }
      assertNoGoalCategoryConflict(resolved as BlueprintAestheticOutcome, activeAestheticGoals);
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
      this.ensureActivePhase(goal);
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
   * with its evidence intact (§18). Remediation (Step 12 Fix) §5: also
   * completes this goal's own active phase, if it has one — a
   * deactivated goal must never be left with a falsely-active phase.
   * Already-completed (historical) phases are untouched. */
  deactivate(id: string, notes?: string | null): Goal | undefined {
    const goal = this.get(id);
    if (!goal || !goal.active) return goal;

    this.db.prepare('UPDATE goals SET active = 0 WHERE id = ?').run(id);
    new GoalEventsRepo(this.db).record({ goal_id: id, event_type: 'deactivated', notes: notes ?? null });

    const phaseRepo = new GoalPhaseRepo(this.db);
    const activePhase = phaseRepo.getActiveForGoal(id);
    if (activePhase) phaseRepo.complete(activePhase.id);

    return this.get(id);
  }

  /** Reactivates a previously deactivated goal — still subject to the
   * active-aesthetic-goal cap. Remediation (Step 12 Fix) §5: also starts
   * a fresh active phase (this goal's prior phase was already completed
   * by deactivate() above, so there is nothing to resume). */
  reactivate(id: string): Goal | undefined {
    const goal = this.get(id);
    if (!goal || goal.active) return goal;

    if (goal.goal_type === 'aesthetic') {
      const activeAestheticGoals = this.list({ active: true, goal_type: 'aesthetic' });
      if (activeAestheticGoals.length >= MAX_ACTIVE_AESTHETIC_GOALS) {
        throw new TooManyActiveAestheticGoalsError(MAX_ACTIVE_AESTHETIC_GOALS);
      }
      const outcome = resolveBlueprintRef(goal) as BlueprintAestheticOutcome;
      assertNoGoalCategoryConflict(outcome, activeAestheticGoals);
    }

    this.db.prepare('UPDATE goals SET active = 1 WHERE id = ?').run(id);
    new GoalEventsRepo(this.db).record({ goal_id: id, event_type: 'activated', notes: 'reactivated' });
    this.ensureActivePhase({ ...goal, active: true });
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
