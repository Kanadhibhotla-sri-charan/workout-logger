-- Smart Workout Logger Database Schema
-- Push/Pull/Legs Split with Detailed Muscle Taxonomy & Diet & Cardio Tracking

-- ============================================
-- MUSCLE GROUPS 
-- ============================================
CREATE TABLE IF NOT EXISTS muscle_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, 
    category TEXT NOT NULL CHECK(category IN ('PUSH', 'PULL', 'LEGS'))
);

-- ============================================
-- MUSCLES
-- ============================================
CREATE TABLE IF NOT EXISTS muscles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, 
    muscle_group_id INTEGER NOT NULL,
    FOREIGN KEY (muscle_group_id) REFERENCES muscle_groups(id)
);

-- ============================================
-- EXERCISES
-- ============================================
CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, 
    aliases TEXT, 
    primary_muscle_id INTEGER NOT NULL,
    secondary_muscles TEXT, 
    exercise_type TEXT CHECK(exercise_type IN ('compound', 'isolation')),
    FOREIGN KEY (primary_muscle_id) REFERENCES muscles(id)
);

-- ============================================
-- WORKOUT LOGS
-- ============================================
CREATE TABLE IF NOT EXISTS workout_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_date DATE NOT NULL,
    day_type TEXT CHECK(day_type IN ('PUSH', 'PULL', 'LEGS', 'CARDIO', 'HYBRID')),
    exercises_raw TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- WORKOUT EXERCISES
-- ============================================
CREATE TABLE IF NOT EXISTS workout_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_log_id INTEGER NOT NULL,
    exercise_id INTEGER NOT NULL,
    sets TEXT,
    reps TEXT,
    weight TEXT,
    FOREIGN KEY (workout_log_id) REFERENCES workout_logs(id) ON DELETE CASCADE,
    FOREIGN KEY (exercise_id) REFERENCES exercises(id)
);

-- ============================================
-- CARDIO LOGS
-- ============================================
CREATE TABLE IF NOT EXISTS cardio_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_log_id INTEGER NOT NULL,
    activity_name TEXT NOT NULL,
    duration TEXT,
    distance TEXT,
    speed TEXT,
    calories INTEGER,
    FOREIGN KEY (workout_log_id) REFERENCES workout_logs(id) ON DELETE CASCADE
);

-- ============================================
-- MUSCLE ACTIVATIONS
-- ============================================
CREATE TABLE IF NOT EXISTS muscle_activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_exercise_id INTEGER NOT NULL,
    muscle_id INTEGER NOT NULL,
    activation_type TEXT NOT NULL CHECK(activation_type IN ('primary', 'secondary')),
    FOREIGN KEY (workout_exercise_id) REFERENCES workout_exercises(id) ON DELETE CASCADE,
    FOREIGN KEY (muscle_id) REFERENCES muscles(id)
);

-- ============================================
-- DIET LOGS
-- ============================================
CREATE TABLE IF NOT EXISTS diet_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date DATE NOT NULL,
    meal_type TEXT, 
    food_raw TEXT,
    calories INTEGER,
    protein INTEGER,
    carbs INTEGER,
    fats INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_workout_date ON workout_logs(workout_date);
CREATE INDEX IF NOT EXISTS idx_workout_exercises_log ON workout_exercises(workout_log_id);
CREATE INDEX IF NOT EXISTS idx_muscle_activations_muscle ON muscle_activations(muscle_id);
CREATE INDEX IF NOT EXISTS idx_muscle_activations_exercise ON muscle_activations(workout_exercise_id);
CREATE INDEX IF NOT EXISTS idx_diet_date ON diet_logs(log_date);
CREATE INDEX IF NOT EXISTS idx_cardio_log ON cardio_logs(workout_log_id);

-- ============================================
-- SEED DATA: Muscle Groups
-- ============================================
INSERT OR IGNORE INTO muscle_groups (name, category) VALUES
    ('Chest', 'PUSH'), ('Shoulders', 'PUSH'), ('Triceps', 'PUSH'),
    ('Back', 'PULL'), ('Biceps', 'PULL'),
    ('Quads', 'LEGS'), ('Hamstrings', 'LEGS'), ('Glutes', 'LEGS'), ('Calves', 'LEGS');

-- ============================================
-- SEED DATA: Muscles
-- ============================================
-- CHEST
INSERT OR IGNORE INTO muscles (name, muscle_group_id) VALUES
    ('Upper Pecs', (SELECT id FROM muscle_groups WHERE name='Chest')),
    ('Mid Pecs', (SELECT id FROM muscle_groups WHERE name='Chest')),
    ('Lower Pecs', (SELECT id FROM muscle_groups WHERE name='Chest'));
-- SHOULDERS
INSERT OR IGNORE INTO muscles (name, muscle_group_id) VALUES
    ('Front Delts', (SELECT id FROM muscle_groups WHERE name='Shoulders')),
    ('Lateral Delts', (SELECT id FROM muscle_groups WHERE name='Shoulders')),
    ('Rear Delts', (SELECT id FROM muscle_groups WHERE name='Shoulders'));
-- TRICEPS
INSERT OR IGNORE INTO muscles (name, muscle_group_id) VALUES
    ('Long Head', (SELECT id FROM muscle_groups WHERE name='Triceps')),
    ('Lateral Head', (SELECT id FROM muscle_groups WHERE name='Triceps')),
    ('Medial Head', (SELECT id FROM muscle_groups WHERE name='Triceps'));
-- BACK
INSERT OR IGNORE INTO muscles (name, muscle_group_id) VALUES
    ('Outer Lats', (SELECT id FROM muscle_groups WHERE name='Back')),
    ('Inner Lats', (SELECT id FROM muscle_groups WHERE name='Back')), -- Actually Thickness/Lower Trap/Rhomboid area
    ('Rhomboids', (SELECT id FROM muscle_groups WHERE name='Back')),
    ('Traps', (SELECT id FROM muscle_groups WHERE name='Back')),
    ('Lower Back', (SELECT id FROM muscle_groups WHERE name='Back'));
-- BICEPS
INSERT OR IGNORE INTO muscles (name, muscle_group_id) VALUES
    ('Long Head Bicep', (SELECT id FROM muscle_groups WHERE name='Biceps')),
    ('Short Head Bicep', (SELECT id FROM muscle_groups WHERE name='Biceps')),
    ('Brachialis', (SELECT id FROM muscle_groups WHERE name='Biceps'));
-- LEGS
INSERT OR IGNORE INTO muscles (name, muscle_group_id) VALUES
    ('Rectus Femoris', (SELECT id FROM muscle_groups WHERE name='Quads')),
    ('Vastus Lateralis', (SELECT id FROM muscle_groups WHERE name='Quads')),
    ('Vastus Medialis', (SELECT id FROM muscle_groups WHERE name='Quads')),
    ('Hamstrings', (SELECT id FROM muscle_groups WHERE name='Hamstrings')),
    ('Glutes', (SELECT id FROM muscle_groups WHERE name='Glutes')),
    ('Calves', (SELECT id FROM muscle_groups WHERE name='Calves'));

-- ============================================
-- SEED DATA: EXERCISES (The Missing Part!)
-- ============================================

-- PUSH EXERCISES
INSERT OR IGNORE INTO exercises (name, aliases, primary_muscle_id, secondary_muscles, exercise_type) VALUES
    ('Bench Press', '["flat bench", "barbell bench"]', (SELECT id FROM muscles WHERE name='Mid Pecs'), '[]', 'compound'),
    ('Incline Dumbbell Press', '["incline db", "incline press"]', (SELECT id FROM muscles WHERE name='Upper Pecs'), '[]', 'compound'),
    ('Overhead Press', '["ohp", "military press", "shoulder press"]', (SELECT id FROM muscles WHERE name='Front Delts'), '[]', 'compound'),
    ('Lateral Raises', '["lat raises", "side raises"]', (SELECT id FROM muscles WHERE name='Lateral Delts'), '[]', 'isolation'),
    ('Tricep Pushdowns', '["rope pushdowns", "pushdowns"]', (SELECT id FROM muscles WHERE name='Lateral Head'), '[]', 'isolation'),
    ('Reverse Pec Deck', '["reverse fly", "rear delt fly"]', (SELECT id FROM muscles WHERE name='Rear Delts'), '[]', 'isolation');

-- PULL EXERCISES
INSERT OR IGNORE INTO exercises (name, aliases, primary_muscle_id, secondary_muscles, exercise_type) VALUES
    ('Deadlift', '["conventional deadlift"]', (SELECT id FROM muscles WHERE name='Lower Back'), '[]', 'compound'),
    ('Pull Up', '["pullups", "pull-up"]', (SELECT id FROM muscles WHERE name='Outer Lats'), '[]', 'compound'),
    ('Assisted Pull Up', '["assisted pullups", "machine pullup"]', (SELECT id FROM muscles WHERE name='Outer Lats'), '[]', 'compound'),
    ('Lat Pulldown', '["lat pulldowns"]', (SELECT id FROM muscles WHERE name='Outer Lats'), '[]', 'compound'),
    ('Barbell Row', '["bent over row", "bb row"]', (SELECT id FROM muscles WHERE name='Inner Lats'), '[]', 'compound'),
    ('Seated Cable Row', '["machine seated row", "cable row", "seated row"]', (SELECT id FROM muscles WHERE name='Rhomboids'), '[]', 'compound'),
    ('Dumbbell Row', '["db row", "one arm row"]', (SELECT id FROM muscles WHERE name='Outer Lats'), '[]', 'compound'),
    ('Preacher Curl', '["machine curl", "preacher"]', (SELECT id FROM muscles WHERE name='Short Head Bicep'), '[]', 'isolation'),
    ('Incline Dumbbell Curl', '["incline curl"]', (SELECT id FROM muscles WHERE name='Long Head Bicep'), '[]', 'isolation'),
    ('Hammer Curl', '["rope curl"]', (SELECT id FROM muscles WHERE name='Brachialis'), '[]', 'isolation'),
    ('Face Pull', '["facepulls"]', (SELECT id FROM muscles WHERE name='Rear Delts'), '[]', 'isolation');

-- LEG EXERCISES
INSERT OR IGNORE INTO exercises (name, aliases, primary_muscle_id, secondary_muscles, exercise_type) VALUES
    ('Squat', '["back squat", "low bar squat"]', (SELECT id FROM muscles WHERE name='Rectus Femoris'), '[]', 'compound'),
    ('Leg Press', '["machine leg press"]', (SELECT id FROM muscles WHERE name='Rectus Femoris'), '[]', 'compound'),
    ('Leg Extension', '["quad extension"]', (SELECT id FROM muscles WHERE name='Vastus Medialis'), '[]', 'isolation'),
    ('RDL', '["romanian deadlift"]', (SELECT id FROM muscles WHERE name='Hamstrings'), '[]', 'compound'),
    ('Leg Curl', '["hamstring curl", "seated leg curl"]', (SELECT id FROM muscles WHERE name='Hamstrings'), '[]', 'isolation'),
    ('Calf Raise', '["standing calf raise"]', (SELECT id FROM muscles WHERE name='Calves'), '[]', 'isolation');
