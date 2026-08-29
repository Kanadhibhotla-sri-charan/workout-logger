// The canonical data contract for workout-logger.
//
// Split deliberately in two:
//  - Blueprint knowledge: read-only, owned by workout-blueprint, never
//    copied here — referenced only by BlueprintId (a Blueprint `id`)
//    resolved on demand through BlueprintAdapter.
//  - User-owned training state (everything below): what this app decides
//    a person should do, and what they actually did. Persisted by this
//    app; Blueprint has no knowledge of it.
//
// Bump CONTRACT_VERSION on any breaking shape change and add a migration
// (see src/db/schema.sql + src/db/migrate.ts).

export const CONTRACT_VERSION = '1.0.0';

/** A Blueprint entity id (exercise, physique target, aesthetic outcome,
 * functional goal, or equipment). Opaque to this app — never resolved
 * except through BlueprintAdapter, and never duplicated as a display name. */
export type BlueprintId = string;

export type GoalType = 'aesthetic' | 'functional';

/**
 * A goal a user is training toward. References Blueprint's own outcome/goal
 * catalog by id — this app does not define what "bigger upper chest" means,
 * Blueprint does.
 */
export interface Goal {
  id: string;
  goal_type: GoalType;
  /** For 'aesthetic': a Blueprint aestheticOutcome id. For 'functional': a
   * Blueprint functionalGoal id. */
  blueprint_ref: BlueprintId;
  priority: number;
  notes: string | null;
  active: boolean;
  created_at: string;
}

export type ProgramStatus = 'draft' | 'active' | 'completed' | 'archived';

/** A plan: an ordered set of ProgramSessions in service of one or more Goals. */
export interface Program {
  id: string;
  name: string;
  goal_ids: string[];
  status: ProgramStatus;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  created_at: string;
}

export type ExerciseRole = 'primary' | 'secondary' | 'accessory' | 'finisher';

export interface ProgramSessionExercise {
  exercise_id: BlueprintId;
  order: number;
  /** Open string so a role vocabulary can grow without a contract bump;
   * ExerciseRole names the values known today. */
  role: ExerciseRole | string;
  target_sets: number | null;
  target_reps_min: number | null;
  target_reps_max: number | null;
  notes: string | null;
}

/** One planned day within a Program (e.g. "Push A"), not yet performed. */
export interface ProgramSession {
  id: string;
  program_id: string;
  day_index: number;
  name: string;
  planned_session_type: SessionType;
  exercises: ProgramSessionExercise[];
  notes: string | null;
  created_at: string;
}

/** Known values today: 'gym' | 'badminton' | 'other'. Kept as an open
 * string, matching Calorie Tracker's own workout_log.csv session_type
 * column, which already accepts arbitrary values. */
export type SessionType = 'gym' | 'badminton' | 'other' | (string & {});

export type WorkoutSessionStatus = 'planned' | 'in_progress' | 'completed' | 'skipped';

/** Why this workout happened: which Goal it serves and at what priority/
 * phase. A workout is an execution of a program toward a goal, not just a
 * list of exercises. */
export interface GoalContext {
  goal_type: GoalType;
  goal_id: string;
  priority: number;
  program_phase: string | null;
}

/** One actually-happened (or planned-and-not-yet-happened) training day. */
export interface WorkoutSession {
  session_id: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  session_type: SessionType;
  program_id: string | null;
  program_session_id: string | null;
  goal_context: GoalContext | null;
  status: WorkoutSessionStatus;
  notes: string | null;
  created_at: string;
}

/** One set. Core fields are required; the rest is deliberately left open
 * (nullable) for Phase 2 — see docs/open-decisions.md on effective-set and
 * progression methodology. */
export interface Set {
  set_number: number;
  weight: number | null;
  reps: number | null;
  completed: boolean;
  rir: number | null;
  rpe: number | null;
  rest_seconds: number | null;
  technique: string | null;
  tempo: string | null;
  notes: string | null;
}

/** One exercise as actually performed within a WorkoutSession. */
export interface ExercisePerformance {
  id: string;
  workout_session_id: string;
  exercise_id: BlueprintId;
  order: number;
  role: ExerciseRole | string;
  sets: Set[];
}

/**
 * Derived rollup: how much a given Blueprint target/goal has actually been
 * trained over a period. Phase 1 defines the shape only — the aggregation
 * rule (what counts as an "effective set", partial-completion weighting)
 * is an open decision for Phase 2. Nothing in this app computes or persists
 * TrainingExposure yet.
 */
export interface TrainingExposure {
  target_type: 'physique_target' | 'functional_goal';
  target_id: BlueprintId;
  period_start: string;
  period_end: string;
  exercise_ids: BlueprintId[];
  total_sets: number;
  effective_sets: number | null;
}

export interface User {
  id: string;
  name: string;
  created_at: string;
}
