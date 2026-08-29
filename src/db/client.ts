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

function migrate(db: Database.Database): void {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('contract_version') as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('contract_version', CONTRACT_VERSION);
  }
}
