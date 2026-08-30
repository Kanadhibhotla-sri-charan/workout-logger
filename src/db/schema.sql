-- Persistent storage for workout-logger's user-owned training state.
-- Blueprint knowledge (exercises, targets, goals, equipment) is NOT stored
-- here — only their ids, referenced from this schema. See
-- src/contracts/types.ts for the canonical shapes these tables implement,
-- and docs/architecture.md for why SQLite was chosen for Phase 1.

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per user. training_days and available_equipment are stored as
-- JSON text arrays (see src/repositories/trainingProfileRepo.ts) — SQLite
-- has no array type, and these are read/written whole, never queried by
-- individual element.
CREATE TABLE IF NOT EXISTS training_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL, -- IANA name, e.g. 'Asia/Kolkata'; see src/lib/timezone.ts
  week_start_day TEXT NOT NULL CHECK (week_start_day IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  training_days TEXT NOT NULL, -- JSON array of Weekday
  preferred_split TEXT,
  default_session_duration_minutes INTEGER NOT NULL,
  minimum_session_duration_minutes INTEGER NOT NULL,
  maximum_session_duration_minutes INTEGER NOT NULL,
  available_equipment TEXT NOT NULL, -- JSON array of Blueprint equipment ids
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- RecurringActivity rows for a TrainingProfile (e.g. badminton on Tue/Thu).
-- A real child table, not JSON, since these are structured per-day records
-- a future engine will want to query (e.g. "what's scheduled on Tuesday?").
CREATE TABLE IF NOT EXISTS training_profile_activities (
  id TEXT PRIMARY KEY,
  training_profile_id TEXT NOT NULL REFERENCES training_profiles(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (day IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  activity_type TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  goal_type TEXT NOT NULL CHECK (goal_type IN ('aesthetic', 'functional')),
  blueprint_ref TEXT NOT NULL,
  priority INTEGER NOT NULL, -- user-controlled rank; the system never infers/overrides this (spec §2.2)
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  -- [spec §3] recommended cadence (days) between aesthetic-outcome
  -- reviews; user can accept or override the recommended default
  -- (src/engine/config.ts REVIEW_CADENCE_DEFAULT_DAYS).
  review_cadence_days INTEGER NOT NULL,
  -- [spec §2.1] how this goal was created. A natural-language goal is
  -- never persisted until the user explicitly confirms it — see
  -- src/engine/goalCreation.ts — so every row in this table already
  -- represents a confirmed activation, structured or not.
  source TEXT NOT NULL DEFAULT 'structured' CHECK (source IN ('structured', 'natural_language')),
  source_text TEXT, -- the original natural-language statement, if source = 'natural_language'
  created_at TEXT NOT NULL
);

-- [spec §18] Goal history: an append-only log of everything that
-- happened to a goal, so a returning/reactivated goal loads prior
-- evidence instead of restarting from zero. Deliberately one generic,
-- append-only table rather than several narrow ones — every event type
-- shares the same shape (what happened, when, structured detail).
CREATE TABLE IF NOT EXISTS goal_events (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'created', 'activated', 'deactivated', 'priority_changed',
      'cadence_changed', 'exercise_changed', 'programming_modified'
    )
  ),
  occurred_at TEXT NOT NULL,
  -- Free-form structured detail for this event (e.g. for
  -- 'exercise_changed': {from, to, reason}; for 'priority_changed':
  -- {from, to}) — JSON text, shape varies deliberately by event_type,
  -- see src/repositories/goalEventsRepo.ts for the writer/reader.
  detail TEXT,
  notes TEXT
);

-- [spec §3] Dated 1-5 user assessment of aesthetic progress for a goal.
-- Never claims workout strength alone proves aesthetic progress (§3) —
-- this table is the deliberate, separate signal for that.
CREATE TABLE IF NOT EXISTS aesthetic_assessments (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  notes TEXT,
  created_at TEXT NOT NULL
);

-- [spec §3] Dated body measurements. goal_id is nullable and single —
-- "do not assume every measurement applies to every goal" (§3): a
-- measurement can stand alone (goal_id NULL) or be mapped to the one
-- goal it's actually relevant to.
CREATE TABLE IF NOT EXISTS measurements (
  id TEXT PRIMARY KEY,
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  metric_name TEXT NOT NULL, -- e.g. "upper arm circumference" — free text, not a closed enum
  value REAL NOT NULL,
  unit TEXT NOT NULL, -- e.g. "cm", "kg"
  notes TEXT,
  created_at TEXT NOT NULL
);

-- [spec §15] Badminton-specific detail for a workout_sessions row whose
-- session_type = 'badminton'. One-to-one child table rather than
-- overloading workout_sessions with sport-specific columns.
CREATE TABLE IF NOT EXISTS badminton_session_details (
  workout_session_id TEXT PRIMARY KEY REFERENCES workout_sessions(session_id) ON DELETE CASCADE,
  intensity TEXT CHECK (intensity IS NULL OR intensity IN ('low', 'medium', 'high')),
  format TEXT CHECK (format IS NULL OR format IN ('singles', 'doubles')),
  games_count INTEGER,
  session_quality INTEGER CHECK (session_quality IS NULL OR session_quality BETWEEN 1 AND 5),
  post_session_fatigue INTEGER CHECK (post_session_fatigue IS NULL OR post_session_fatigue BETWEEN 1 AND 5),
  notes TEXT
);

-- [spec §4.2] A proposed exercise outside Blueprint's pool. Never
-- prescribable until approved=1 — see
-- src/repositories/outsideBlueprintExercisesRepo.ts and
-- src/engine/exerciseUniverse.ts for the enforcement point.
-- Remediation §10: an outside-Blueprint exercise must be a real,
-- usable candidate once approved — not just an approval record with no
-- programming data. target_type/target_id/role mirror Blueprint's own
-- muscle-role model exactly (never a separate vocabulary); equipment
-- mirrors TrainingProfile.available_equipment's own id space;
-- reps_range/rir_range are the human proposer's own explicit numbers
-- (this app has no Blueprint development-package data for a
-- non-Blueprint exercise, and does not invent a substitute — see
-- src/engine/workoutBuilder.ts).
CREATE TABLE IF NOT EXISTS outside_blueprint_exercises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  justification_category TEXT NOT NULL CHECK (
    justification_category IN ('blueprint_inadequate', 'contextual_constraint', 'meaningful_advantage')
  ),
  justification_text TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('physique_target', 'functional_goal')),
  target_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
  equipment TEXT NOT NULL, -- JSON array of equipment ids, e.g. '["cable"]'
  reps_range TEXT NOT NULL, -- e.g. "8-12" — same string shape as Blueprint's own package reps
  rir_range TEXT NOT NULL, -- e.g. "1-3"
  proposed_at TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'completed', 'archived')),
  start_date TEXT,
  end_date TEXT,
  notes TEXT,
  -- Blueprint commit in effect when this Program was created (see
  -- BlueprintAdapter.getManifest()). Set once, never overwritten.
  blueprint_commit TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS program_goals (
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  PRIMARY KEY (program_id, goal_id)
);

CREATE TABLE IF NOT EXISTS program_sessions (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  day_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  planned_session_type TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- exercise_id is a Blueprint exercise id. No foreign key: Blueprint is an
-- external, read-only knowledge source this schema does not own.
CREATE TABLE IF NOT EXISTS program_session_exercises (
  id TEXT PRIMARY KEY,
  program_session_id TEXT NOT NULL REFERENCES program_sessions(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  target_sets INTEGER,
  target_reps_min INTEGER,
  target_reps_max INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS workout_sessions (
  session_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  duration_minutes INTEGER,
  session_type TEXT NOT NULL,
  program_id TEXT REFERENCES programs(id) ON DELETE SET NULL,
  program_session_id TEXT REFERENCES program_sessions(id) ON DELETE SET NULL,
  goal_type TEXT CHECK (goal_type IS NULL OR goal_type IN ('aesthetic', 'functional')),
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  goal_priority INTEGER,
  program_phase TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'completed', 'skipped')),
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workout_exercises (
  id TEXT PRIMARY KEY,
  workout_session_id TEXT NOT NULL REFERENCES workout_sessions(session_id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  role TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workout_sets (
  id TEXT PRIMARY KEY,
  workout_exercise_id TEXT NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
  set_number INTEGER NOT NULL,
  weight REAL,
  reps INTEGER,
  completed INTEGER NOT NULL DEFAULT 0,
  rir REAL,
  rpe REAL,
  rest_seconds INTEGER,
  technique TEXT,
  tempo TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_workout_sessions_date ON workout_sessions(date);
CREATE INDEX IF NOT EXISTS idx_workout_exercises_session ON workout_exercises(workout_session_id);
CREATE INDEX IF NOT EXISTS idx_workout_sets_exercise ON workout_sets(workout_exercise_id);
CREATE INDEX IF NOT EXISTS idx_program_sessions_program ON program_sessions(program_id);
CREATE INDEX IF NOT EXISTS idx_program_session_exercises_session ON program_session_exercises(program_session_id);
CREATE INDEX IF NOT EXISTS idx_training_profile_activities_profile ON training_profile_activities(training_profile_id);
CREATE INDEX IF NOT EXISTS idx_goal_events_goal ON goal_events(goal_id);
CREATE INDEX IF NOT EXISTS idx_aesthetic_assessments_goal ON aesthetic_assessments(goal_id);
CREATE INDEX IF NOT EXISTS idx_measurements_goal ON measurements(goal_id);
CREATE INDEX IF NOT EXISTS idx_measurements_date ON measurements(date);
