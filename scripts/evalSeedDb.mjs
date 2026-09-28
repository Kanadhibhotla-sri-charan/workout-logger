// One-off, never touches the real production database: builds a
// separate, file-backed sqlite DB for scripts/modelEval*.mjs to point
// DB_PATH at, so a model eval has a real, concrete scenario to reason
// over (2 prior historical training days, a real session focus) without
// ever writing synthetic/fake data into the user's real training record.
// Reuses the user's own real recurring template and real active goals
// (read from the real production DB, read-only) so the eval scenario
// stays representative — only the DAY-LEVEL history and week-program
// generation are synthetic, and only in this separate file.
//
// Usage: node scripts/evalSeedDb.mjs <output-db-path> <target-monday>
// Example: node scripts/evalSeedDb.mjs /tmp/eval_seed.sqlite 2026-09-21

import { openDb } from '../dist/db/client.js';
import { UsersRepo } from '../dist/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../dist/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../dist/repositories/goalsRepo.js';
import { WorkoutSessionsRepo } from '../dist/repositories/workoutSessionsRepo.js';
import { ProfileFactorsRepo } from '../dist/repositories/profileFactorsRepo.js';
import { computeFreshWeek } from '../dist/server/routes/programming.js';
import { reconcileWeekProgram } from '../dist/engine/weekProgramReconciliation.js';
import { addDays } from '../dist/engine/dateMath.js';

const OUTPUT_PATH = process.argv[2];
const TARGET_MONDAY = process.argv[3];
if (!OUTPUT_PATH || !TARGET_MONDAY) {
  console.error('Usage: node scripts/evalSeedDb.mjs <output-db-path> <target-monday>');
  process.exit(1);
}

const PRIOR_MONDAY = addDays(TARGET_MONDAY, -7);
const PRIOR_TUESDAY = addDays(PRIOR_MONDAY, 1);

const db = openDb(OUTPUT_PATH);

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];

const user = new UsersRepo(db).getOrCreateDefault();
new TrainingProfileRepo(db).upsert(user.id, {
  timezone: 'Asia/Kolkata',
  week_start_day: 'monday',
  training_days: ['monday', 'tuesday', 'thursday', 'friday'],
  default_session_duration_minutes: 60,
  minimum_session_duration_minutes: 30,
  maximum_session_duration_minutes: 90,
  available_equipment: FULL_EQUIPMENT,
  other_activity_schedule: [
    { day: 'saturday', activity_type: 'badminton' },
    { day: 'sunday', activity_type: 'badminton' },
  ],
});

// One of the user's own real active goals, recreated here rather than
// read from and never written back to production. (The real account has
// both arm-side-thickness AND triceps-back-depth active simultaneously,
// but the app's own goal-category-conflict guard rejects creating both
// together via this API — they compete for the same push-session
// category. Using the one directly implicated in the earlier eval
// finding: triceps inflated 3x/3.5x its authored sets.)
const goalsRepo = new GoalsRepo(db);
goalsRepo.create({ goal_type: 'aesthetic', blueprint_ref: 'triceps-back-depth', priority: 1 });

new ProfileFactorsRepo(db).set(user.id, {
  factorName: 'training_experience',
  value: 'advanced',
  source: 'user_reported',
  userConfirmed: true,
});

const sessionsRepo = new WorkoutSessionsRepo(db);
function completedSession(date, exercises) {
  const session = sessionsRepo.createSession({ date, session_type: 'gym', status: 'completed' });
  let order = 1;
  for (const ex of exercises) {
    sessionsRepo.addExercisePerformance(session.session_id, {
      exercise_id: ex.exercise_id,
      order: order++,
      role: 'primary',
      sets: ex.sets.map((s, i) => ({ set_number: i + 1, weight: s.weight, reps: s.reps, completed: s.completed })),
    });
  }
}

// Two real prior historical days — a push day then a pull day, matching
// the real recurring template's own weekly rhythm, so trend/rotation
// signals (rules 20/21/23) have real substance to reason over.
completedSession(PRIOR_MONDAY, [
  { exercise_id: 'flat-barbell-bench-press', sets: [40, 40, 40].map((w) => ({ weight: w, reps: 10, completed: true })) },
  { exercise_id: 'incline-dumbbell-press', sets: [24, 24, 24].map((w) => ({ weight: w, reps: 10, completed: true })) },
  { exercise_id: 'cable-pushdown', sets: [30, 30].map((w) => ({ weight: w, reps: 12, completed: true })) },
]);
completedSession(PRIOR_TUESDAY, [
  { exercise_id: 'seated-cable-row', sets: [50, 50, 50].map((w) => ({ weight: w, reps: 10, completed: true })) },
  { exercise_id: 'lat-pulldown-wide-pronated', sets: [45, 45, 45].map((w) => ({ weight: w, reps: 10, completed: true })) },
  { exercise_id: 'hammer-curl', sets: [16, 16].map((w) => ({ weight: w, reps: 12, completed: true })) },
]);

// Generate the real deterministic week program for the target week, so
// programmingBrief.session.purpose is a real push/pull/legs/upper value
// (matching the recurring template) instead of null.
const { days, aggregates } = computeFreshWeek(db, TARGET_MONDAY, 60, PRIOR_MONDAY);
reconcileWeekProgram(db, TARGET_MONDAY, days, aggregates);

db.close();
console.log(`[evalSeedDb] seeded ${OUTPUT_PATH} — target week ${TARGET_MONDAY}, history on ${PRIOR_MONDAY} and ${PRIOR_TUESDAY}`);
