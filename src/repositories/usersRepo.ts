import type Database from 'better-sqlite3';
import type { User } from '../contracts/types.js';
import { newId, nowIso } from './ids.js';

interface UserRow {
  id: string;
  name: string;
  created_at: string;
}

/**
 * Phase 1/1.5 is single-user with no auth. getOrCreateDefault() gives every
 * caller a stable user to hang a TrainingProfile/Goal off of without this
 * app inventing a login flow it doesn't need yet.
 */
export class UsersRepo {
  constructor(private db: Database.Database) {}

  get(id: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }

  getOrCreateDefault(): User {
    const existing = this.db.prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT 1').get() as UserRow | undefined;
    if (existing) return existing;

    const user: User = { id: newId('user'), name: 'Charan', created_at: nowIso() };
    this.db.prepare('INSERT INTO users (id, name, created_at) VALUES (@id, @name, @created_at)').run(user);
    return user;
  }
}
