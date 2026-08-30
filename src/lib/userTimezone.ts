import type Database from 'better-sqlite3';
import { TrainingProfileRepo } from '../repositories/trainingProfileRepo.js';
import { UsersRepo } from '../repositories/usersRepo.js';
import { DEFAULT_TIMEZONE, todayInTimezone } from './timezone.js';

/** The default (single, per docs/architecture.md's single-user scope)
 * user's configured timezone, or DEFAULT_TIMEZONE if no TrainingProfile
 * has been created yet. Never the server process's own timezone. */
export function resolveUserTimezone(db: Database.Database): string {
  const user = new UsersRepo(db).getOrCreateDefault();
  const profile = new TrainingProfileRepo(db).get(user.id);
  return profile?.timezone ?? DEFAULT_TIMEZONE;
}

/** "Today" in the user's configured timezone — see src/lib/timezone.ts's
 * contract. Never `new Date().toISOString()`, which is always UTC. */
export function todayForUser(db: Database.Database): string {
  return todayInTimezone(resolveUserTimezone(db));
}
