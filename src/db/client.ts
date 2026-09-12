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

  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('contract_version') as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('contract_version', CONTRACT_VERSION);
  }
}
