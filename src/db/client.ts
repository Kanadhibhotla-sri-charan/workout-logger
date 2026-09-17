import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION } from '../contracts/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export function openDb(dbPath: string = process.env.DB_PATH ?? join(process.cwd(), 'data', 'workout-logger.sqlite')): Database.Database {
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

/** Final Current-Week Reconciliation Fix §5/§24: adds a column to an
 * EXISTING table only if it doesn't already exist — `CREATE TABLE IF NOT
 * EXISTS` alone never adds a column to a table an earlier version of
 * this schema already created, so this is what actually makes it safe
 * to run this migration against an already-used production database
 * with real workout history in it. Never drops or rewrites a column;
 * never touches existing rows' other data. */
function addColumnIfMissing(db: Database.Database, table: string, column: string, columnDefSql: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDefSql}`);
  }
}

function migrate(db: Database.Database): void {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Final Current-Week Reconciliation Fix §5: persisted current-week
  // plan state, reusing the existing `programs`/`program_sessions`
  // tables (see src/repositories/weeklyProgramRepo.ts) rather than a
  // new table. All additive/nullable — safe on an existing database.
  addColumnIfMissing(db, 'programs', 'active_goals_json', 'TEXT');
  addColumnIfMissing(db, 'programs', 'target_allocations_json', 'TEXT');
  addColumnIfMissing(db, 'program_sessions', 'snapshot_json', 'TEXT');

  // AI Programmer Phase 2 correction: workout_exercises gains an
  // optional PLANNED prescription (target_sets/target_reps_min/
  // target_reps_max/target_rir_min/target_rir_max/target_rest_seconds),
  // distinct from workout_sets' own PERFORMED weight/reps/rir/rpe
  // columns — see schema.sql's comment on workout_exercises. All
  // nullable/additive, safe on an existing database with real logged
  // history (every pre-existing row simply has NULL prescription
  // columns, meaning "no prescription recorded for this performance").
  addColumnIfMissing(db, 'workout_exercises', 'target_sets', 'INTEGER');
  addColumnIfMissing(db, 'workout_exercises', 'target_reps_min', 'INTEGER');
  addColumnIfMissing(db, 'workout_exercises', 'target_reps_max', 'INTEGER');
  addColumnIfMissing(db, 'workout_exercises', 'target_rir_min', 'REAL');
  addColumnIfMissing(db, 'workout_exercises', 'target_rir_max', 'REAL');
  addColumnIfMissing(db, 'workout_exercises', 'target_rest_seconds', 'INTEGER');

  // Final AI-Deterministic Precedence and Scheduling Fixes §1: real
  // session provenance, so the shared precedence rule (see
  // programming.ts's renderWeekDays) can tell a deterministic day's own
  // started session apart from a real session that SUPERSEDES it (AI or
  // manual). Additive/nullable-safe on an existing database — the
  // DEFAULT makes every pre-existing row (and every INSERT that omits
  // the column) 'deterministic', exactly matching this codebase's own
  // prior, only-ever-deterministic behavior before this fix.
  addColumnIfMissing(db, 'workout_sessions', 'source_type', "TEXT NOT NULL DEFAULT 'deterministic'");
  addColumnIfMissing(db, 'workout_sessions', 'supersedes_program_session_id', 'TEXT REFERENCES program_sessions(id) ON DELETE SET NULL');

  // Coaching Depth Batch 3 (Periodization System): extends the existing
  // coaching_program_state row (never a second table) with reactive-deload
  // evidence fields — see schema.sql's own comment on this table for why
  // periodization_state/deload_reason are deliberately NOT columns here
  // (both are computed, like week_index already is). All additive/
  // nullable-or-defaulted, safe on an existing database.
  addColumnIfMissing(db, 'coaching_program_state', 'block_number', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'coaching_program_state', 'reactive_trigger_status', "TEXT NOT NULL DEFAULT 'not_evaluated'");
  addColumnIfMissing(db, 'coaching_program_state', 'reactive_triggered_at', 'TEXT');
  addColumnIfMissing(db, 'coaching_program_state', 'reactive_deload_start_date', 'TEXT');
  addColumnIfMissing(db, 'coaching_program_state', 'reactive_deload_end_date', 'TEXT');
  addColumnIfMissing(db, 'coaching_program_state', 'cooldown_until', 'TEXT');
  addColumnIfMissing(db, 'coaching_program_state', 'last_evaluated_at', 'TEXT');
  addColumnIfMissing(db, 'coaching_program_state', 'specialization_target_id', 'TEXT');
  addColumnIfMissing(db, 'coaching_program_state', 'specialization_goal_id', 'TEXT REFERENCES goals(id) ON DELETE SET NULL');

  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('contract_version') as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('contract_version', CONTRACT_VERSION);
  }
}
