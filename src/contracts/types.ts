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

export const CONTRACT_VERSION = '1.1.0';

/** A Blueprint entity id (exercise, physique target, aesthetic outcome,
 * functional goal, or equipment). Opaque to this app — never resolved
 * except through BlueprintAdapter, and never duplicated as a display name. */
export type BlueprintId = string;

export type GoalType = 'aesthetic' | 'functional';

/**
 * A goal a user is training toward. References Blueprint's own outcome/goal
 * catalog by id — this app does not define what "bigger upper chest" means,
 * Blueprint does.
 *
 * `id` and `blueprint_ref` are two different identifiers with different
 * meanings and must never be conflated:
 *   - `id` is this Goal's own identity in workout-logger's storage — a
 *     user-specific instance ("the goal I'm training toward, started
 *     2026-08-29, priority 1"). Programs and WorkoutSessions reference
 *     *this* id (via GoalContext.goal_id / Program.goal_ids), never
 *     `blueprint_ref` directly.
 *   - `blueprint_ref` is the canonical Blueprint id this instance points
 *     at (an aestheticOutcome or functionalGoal id, resolved only through
 *     BlueprintAdapter). It is not this app's identifier for anything —
 *     it's how this Goal instance finds out what the knowledge layer says
 *     about e.g. "arm-side-thickness".
 * Resolution always flows one way: `goal.id` -> load the Goal row ->
 * `goal.blueprint_ref` -> BlueprintAdapter.getAestheticGoal/getFunctionalGoal.
 * Never assume `goal.id === goal.blueprint_ref`, and never use a
 * Blueprint display name as a stand-in for either.
 */
export interface Goal {
  id: string;
  goal_type: GoalType;
  /** For 'aesthetic': a Blueprint aestheticOutcome id. For 'functional': a
   * Blueprint functionalGoal id. Resolve only through BlueprintAdapter. */
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
  /** The workout-blueprint commit (from BlueprintAdapter.getManifest()
   * .sourceCommit) in effect when this Program was created. Recorded once,
   * at creation, and never overwritten — Blueprint's knowledge can change
   * under a later commit, but a historical Program must stay explainable
   * against the data that actually informed it. */
  blueprint_commit: string;
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

export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export const WEEKDAYS: readonly Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Known values today: 'gym' | 'badminton' | 'rest' | 'other'. Kept open
 * (like SessionType) so a new recurring activity type doesn't need a
 * contract bump. */
export type ActivityType = 'gym' | 'badminton' | 'rest' | 'other' | (string & {});

/** One recurring commitment on the user's week — e.g. "badminton every
 * Tuesday and Thursday" — that a future programming engine must treat as
 * reduced training/recovery capacity, not just ignore. */
export interface RecurringActivity {
  day: Weekday;
  activity_type: ActivityType;
  notes: string | null;
}

/**
 * User-specific training constraints the programming engine must read as
 * data, never assume or hard-code: which days the user trains, how long
 * sessions can run, what equipment is actually available, and what other
 * recurring activity (badminton, etc.) competes for the same recovery
 * capacity. One profile per User.
 */
export interface TrainingProfile {
  id: string;
  user_id: string;
  /** IANA timezone name (e.g. "Asia/Kolkata"). All of this user's
   * WorkoutSession.date/start_time/end_time values are interpreted in
   * this zone — see docs/architecture.md's timezone contract. */
  timezone: string;
  training_days: Weekday[];
  /** Open string — Blueprint does not define a split taxonomy, so this
   * app doesn't invent a closed enum for it either (e.g. "push-pull-legs",
   * "upper-lower", "full-body"). */
  preferred_split: string | null;
  default_session_duration_minutes: number;
  minimum_session_duration_minutes: number;
  maximum_session_duration_minutes: number;
  /** Equipment ids as they appear in Blueprint's derived equipment
   * vocabulary (BlueprintAdapter.getEquipmentList()) — validated against
   * it at write time, not a separately invented catalog. */
  available_equipment: BlueprintId[];
  other_activity_schedule: RecurringActivity[];
  created_at: string;
  updated_at: string;
}
