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
  priority INTEGER NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
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
