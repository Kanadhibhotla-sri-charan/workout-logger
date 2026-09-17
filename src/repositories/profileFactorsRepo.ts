// Coaching Depth Batch 5 spec §6 (Phase 8, Individual Profile Factors):
// a generic, factor-name-keyed store for validated individual
// characteristics. Mirrors exercisePreferencesRepo.ts's own
// current-state (not event-log), compute-effective-at-read-time
// discipline exactly. This repo itself is generic (any factor_name/value
// pair) — which concrete factor names actually influence programming is
// decided by real callers (see intensityTechniques.ts's use of
// 'training_experience'), never by this repo.

import type Database from 'better-sqlite3';
import { nowIso } from './ids.js';

export interface ProfileFactorRecord {
  userId: string;
  factorName: string;
  value: string;
  source: string | null;
  userConfirmed: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetProfileFactorInput {
  factorName: string;
  value: string;
  source?: string | null;
  /** Spec §6.3/§2.2: defaults to false — a factor is never treated as
   * reliable enough to affect programming unless a real caller
   * explicitly marks it user-confirmed. */
  userConfirmed?: boolean;
  expiresAt?: string | null;
}

interface ProfileFactorRow {
  user_id: string;
  factor_name: string;
  value: string;
  source: string | null;
  user_confirmed: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ProfileFactorRow): ProfileFactorRecord {
  return {
    userId: row.user_id,
    factorName: row.factor_name,
    value: row.value,
    source: row.source,
    userConfirmed: row.user_confirmed === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isExpired(record: ProfileFactorRecord, asOfDate: string): boolean {
  return record.expiresAt !== null && asOfDate > record.expiresAt;
}

export class ProfileFactorsRepo {
  constructor(private db: Database.Database) {}

  /** An explicit, deliberate set/replace — never merged with whatever
   * value (if any) previously existed for this factor, matching
   * ExercisePreferencesRepo.set's own semantics. */
  set(userId: string, input: SetProfileFactorInput): ProfileFactorRecord {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO user_profile_factors (user_id, factor_name, value, source, user_confirmed, expires_at, created_at, updated_at)
         VALUES (@user_id, @factor_name, @value, @source, @user_confirmed, @expires_at, @created_at, @updated_at)
         ON CONFLICT(user_id, factor_name) DO UPDATE SET
           value = @value, source = @source, user_confirmed = @user_confirmed, expires_at = @expires_at, updated_at = @updated_at`
      )
      .run({
        user_id: userId,
        factor_name: input.factorName,
        value: input.value,
        source: input.source ?? null,
        user_confirmed: input.userConfirmed ? 1 : 0,
        expires_at: input.expiresAt ?? null,
        created_at: now,
        updated_at: now,
      });
    return this.get(userId, input.factorName)!;
  }

  remove(userId: string, factorName: string): void {
    this.db.prepare('DELETE FROM user_profile_factors WHERE user_id = ? AND factor_name = ?').run(userId, factorName);
  }

  get(userId: string, factorName: string): ProfileFactorRecord | null {
    const row = this.db.prepare('SELECT * FROM user_profile_factors WHERE user_id = ? AND factor_name = ?').get(userId, factorName) as ProfileFactorRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listAll(userId: string): ProfileFactorRecord[] {
    const rows = this.db.prepare('SELECT * FROM user_profile_factors WHERE user_id = ?').all(userId) as ProfileFactorRow[];
    return rows.map(rowToRecord);
  }

  /** Spec §7 "list active rules"-equivalent for profile factors: every
   * row not expired as of `asOfDate` — regardless of confirmation state,
   * so a caller building a review/edit UI can still see an
   * unconfirmed/stale factor to act on it. Real programming decisions
   * must use `effectiveValue` instead, which additionally requires
   * confirmation. */
  listActive(userId: string, asOfDate: string): ProfileFactorRecord[] {
    return this.listAll(userId).filter((r) => !isExpired(r, asOfDate));
  }

  /** The one function every programming-affecting call site should use.
   * Returns `null` — a genuine absence, never a guessed default — unless
   * a live, explicitly user-confirmed, non-expired record exists (spec
   * §2.2 "conservative defaults" / §6.3 "do not treat inferred or stale
   * information as equivalent to a current user-confirmed restriction"). */
  effectiveValue(userId: string, factorName: string, asOfDate: string): string | null {
    const record = this.get(userId, factorName);
    if (!record || !record.userConfirmed || isExpired(record, asOfDate)) return null;
    return record.value;
  }
}
