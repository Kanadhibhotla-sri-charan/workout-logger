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

export const CONTRACT_VERSION = '1.3.0';

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
  /** User-controlled rank (lower = higher priority). The system never
   * infers or overrides this — spec §2.2. */
  priority: number;
  notes: string | null;
  active: boolean;
  /** Recommended (or user-overridden) days between aesthetic-outcome
   * reviews — spec §3. See src/engine/config.ts
   * REVIEW_CADENCE_DEFAULT_DAYS for the recommended starting point. */
  review_cadence_days: number;
  /** How this goal was created. A 'natural_language' goal is only ever
   * persisted after explicit user confirmation — see
   * src/engine/goalCreation.ts — so both sources represent a confirmed
   * activation by the time a Goal row exists. */
  source: 'structured' | 'natural_language';
  source_text: string | null;
  created_at: string;
}

export type GoalEventType =
  | 'created'
  | 'activated'
  | 'deactivated'
  | 'priority_changed'
  | 'cadence_changed'
  | 'exercise_changed'
  | 'programming_modified';

/** One entry in a Goal's append-only history — spec §18: "when a goal
 * returns, use its historical evidence rather than restarting from
 * zero." `detail`'s shape depends on `event_type` (see
 * src/repositories/goalEventsRepo.ts). */
export interface GoalEvent {
  id: string;
  goal_id: string;
  event_type: GoalEventType;
  occurred_at: string;
  detail: Record<string, unknown> | null;
  notes: string | null;
}

/** A dated 1-5 user assessment of aesthetic progress toward one goal —
 * spec §3. Never conflate with performance/strength data. */
export interface AestheticAssessment {
  id: string;
  goal_id: string;
  date: string;
  /** 1 = significantly worse .. 5 = significantly improved. See
   * src/engine/config.ts ASSESSMENT_SCALE. */
  rating: 1 | 2 | 3 | 4 | 5;
  notes: string | null;
  created_at: string;
}

/** A dated body measurement — spec §3. `goal_id` is nullable and
 * singular: not every measurement applies to every goal, and this app
 * does not assume one does. */
export interface Measurement {
  id: string;
  goal_id: string | null;
  date: string;
  metric_name: string;
  value: number;
  unit: string;
  notes: string | null;
  created_at: string;
}

export type BadmintonIntensity = 'low' | 'medium' | 'high';
export type BadmintonFormat = 'singles' | 'doubles';

/** Badminton-specific detail attached to a WorkoutSession whose
 * session_type is 'badminton' — spec §15. Badminton is a first-class
 * modality, not converted into hypertrophy-set-equivalents (see
 * docs/TRAINING_ENGINE_DESIGN.md's badminton section). */
export interface BadmintonSessionDetails {
  workout_session_id: string;
  intensity: BadmintonIntensity | null;
  format: BadmintonFormat | null;
  games_count: number | null;
  session_quality: 1 | 2 | 3 | 4 | 5 | null;
  post_session_fatigue: 1 | 2 | 3 | 4 | 5 | null;
  notes: string | null;
}

export type OutsideBlueprintJustification = 'blueprint_inadequate' | 'contextual_constraint' | 'meaningful_advantage';

/** A proposed exercise outside Blueprint's pool — spec §4.2. Never
 * prescribable until `approved`. See
 * src/engine/exerciseUniverse.ts for the resolution/enforcement point. */
export interface OutsideBlueprintExercise {
  id: string;
  name: string;
  description: string | null;
  justification_category: OutsideBlueprintJustification;
  justification_text: string;
  proposed_at: string;
  approved: boolean;
  approved_at: string | null;
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
 * A neutral, goal-agnostic rollup of how much a given Blueprint target has
 * actually been trained over a period — see docs/TRAINING_EXPOSURE_MODEL.md
 * for the full design. Deliberately NOT the same concept as
 * HypertrophyVolume or FunctionalExposure below — see that document's §0.
 *
 * `exposure_units` counts one completed set as one unit of exposure to
 * every target the exercise directly lists (Strategy A — see
 * docs/TRAINING_EXPOSURE_MODEL.md §B) — implemented in
 * src/engine/exposureEngine.ts. It is intentionally NOT named
 * "effective_sets": that name implies hypertrophy-specific physiological
 * precision (proximity to failure, indirect contribution, target
 * priority) that this flat count does not have. Never rename or reuse
 * this field to mean that.
 */
export interface TrainingExposure {
  target_type: 'physique_target' | 'functional_goal';
  target_id: BlueprintId;
  period_start: string;
  period_end: string;
  exercise_ids: BlueprintId[];
  total_sets: number;
  exposure_units: number;
}

/**
 * A goal-specific interpretation of TrainingExposure for physique
 * development — NOT the same as raw TrainingExposure (see
 * docs/TRAINING_EXPOSURE_MODEL.md §0). Shape only: nothing in this
 * codebase computes a HypertrophyVolume yet. Reserved for once direct vs.
 * indirect weighting, RIR/RPE-based intensity, exercise role, and target
 * priority all have approved rules (docs/TRAINING_EXPOSURE_MODEL.md §E,
 * §F; docs/open-decisions.md).
 */
export interface HypertrophyVolume {
  target_type: 'physique_target';
  target_id: BlueprintId;
  period_start: string;
  period_end: string;
  goal_id: string | null;
  /** Deliberately distinct from TrainingExposure.exposure_units — see
   * docs/TRAINING_EXPOSURE_MODEL.md §6. Not computed by any code yet. */
  effective_sets: number | null;
}

/**
 * A goal-specific interpretation of TrainingExposure for a functional
 * goal (e.g. rotator-cuff, core-anti-rotation) — explicitly NOT assumed
 * to share HypertrophyVolume's arithmetic (see
 * docs/TRAINING_EXPOSURE_MODEL.md §0). Shape only: nothing in this
 * codebase computes a FunctionalExposure yet.
 */
export interface FunctionalExposure {
  target_type: 'functional_goal';
  target_id: BlueprintId;
  period_start: string;
  period_end: string;
  goal_id: string | null;
  /** No formula decided — placeholder until one is approved. */
  adequacy: 'insufficient' | 'adequate' | 'unknown' | null;
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
  /** First day of this user's training week, for weekly exposure
   * aggregation (docs/TRAINING_EXPOSURE_MODEL.md §G). Stored data, never
   * a hard-coded Monday assumption — see that document and
   * docs/TRAINING_ENGINE_DESIGN.md §13. */
  week_start_day: Weekday;
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
