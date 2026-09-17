// Coaching Depth Batch 4 spec §1/§6: explicit exercise preference/
// avoidance rules — one row per (user, exercise), current-state (not an
// event log). "Effective" preference is always computed against a real
// reference date (never wall-clock time read inside this module), so a
// temporary exclusion that has passed its `temporary_until` date reads
// back as `'neutral'` without any separate expiry write — matching this
// codebase's own compute-don't-store discipline for anything derivable.

import type Database from 'better-sqlite3';
import { nowIso } from './ids.js';

export type ExercisePreferenceKind = 'preferred' | 'disliked' | 'avoided';
/** The read-time resolved state — `'neutral'` is never stored, only ever
 * the absence of a row or an expired `temporary_until`. */
export type EffectivePreference = ExercisePreferenceKind | 'neutral';

export interface ExercisePreferenceRecord {
  userId: string;
  exerciseId: string;
  preference: ExercisePreferenceKind;
  /** Real calendar date (inclusive) after which this rule no longer
   * applies — `null` means permanent until explicitly changed/removed. */
  temporaryUntil: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetExercisePreferenceInput {
  exerciseId: string;
  preference: ExercisePreferenceKind;
  temporaryUntil?: string | null;
  reason?: string | null;
}

interface ExercisePreferenceRow {
  user_id: string;
  exercise_id: string;
  preference: ExercisePreferenceKind;
  temporary_until: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ExercisePreferenceRow): ExercisePreferenceRecord {
  return {
    userId: row.user_id,
    exerciseId: row.exercise_id,
    preference: row.preference,
    temporaryUntil: row.temporary_until,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Spec §1: "do not infer explicit avoidance/preference from historical
 * omissions" — every exercise not covered by a live row (or covered only
 * by an expired temporary one) is exactly `'neutral'`, never guessed. */
function isExpired(record: ExercisePreferenceRecord, asOfDate: string): boolean {
  return record.temporaryUntil !== null && asOfDate > record.temporaryUntil;
}

export class ExercisePreferencesRepo {
  constructor(private db: Database.Database) {}

  /** Spec §1: an explicit, deliberate set/replace — never merged with
   * whatever rule (if any) previously existed for this exercise. */
  set(userId: string, input: SetExercisePreferenceInput): ExercisePreferenceRecord {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO exercise_preferences (user_id, exercise_id, preference, temporary_until, reason, created_at, updated_at)
         VALUES (@user_id, @exercise_id, @preference, @temporary_until, @reason, @created_at, @updated_at)
         ON CONFLICT(user_id, exercise_id) DO UPDATE SET
           preference = @preference, temporary_until = @temporary_until, reason = @reason, updated_at = @updated_at`
      )
      .run({
        user_id: userId,
        exercise_id: input.exerciseId,
        preference: input.preference,
        temporary_until: input.temporaryUntil ?? null,
        reason: input.reason ?? null,
        created_at: now,
        updated_at: now,
      });
    return this.get(userId, input.exerciseId)!;
  }

  /** Spec §7: explicit removal — distinct from letting a temporary rule
   * expire on its own. */
  remove(userId: string, exerciseId: string): void {
    this.db.prepare('DELETE FROM exercise_preferences WHERE user_id = ? AND exercise_id = ?').run(userId, exerciseId);
  }

  get(userId: string, exerciseId: string): ExercisePreferenceRecord | null {
    const row = this.db.prepare('SELECT * FROM exercise_preferences WHERE user_id = ? AND exercise_id = ?').get(userId, exerciseId) as ExercisePreferenceRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Every stored row for this user, expired or not — a caller wanting
   * "active rules" (spec §7) should filter with `isExpired`/`effectiveFor`
   * itself against a real reference date, never wall-clock time read
   * inside this repo. */
  listAll(userId: string): ExercisePreferenceRecord[] {
    const rows = this.db.prepare('SELECT * FROM exercise_preferences WHERE user_id = ?').all(userId) as ExercisePreferenceRow[];
    return rows.map(rowToRecord);
  }

  /** Spec §7 "list active rules" — every row NOT expired as of
   * `asOfDate`. */
  listActive(userId: string, asOfDate: string): ExercisePreferenceRecord[] {
    return this.listAll(userId).filter((r) => !isExpired(r, asOfDate));
  }

  /** The one function every selection call site should use — resolves
   * straight to `'neutral'` for any exercise with no live rule, so a
   * caller never has to separately check for `null`/expiry itself. */
  effectiveFor(userId: string, exerciseId: string, asOfDate: string): EffectivePreference {
    const record = this.get(userId, exerciseId);
    if (!record || isExpired(record, asOfDate)) return 'neutral';
    return record.preference;
  }

  /** Bulk form of `effectiveFor` for an entire candidate pool — avoids a
   * caller running N individual queries when building one target's
   * candidate list. */
  effectiveMapFor(userId: string, exerciseIds: readonly string[], asOfDate: string): ReadonlyMap<string, EffectivePreference> {
    const active = new Map(this.listActive(userId, asOfDate).map((r) => [r.exerciseId, r.preference] as const));
    const result = new Map<string, EffectivePreference>();
    for (const id of exerciseIds) result.set(id, active.get(id) ?? 'neutral');
    return result;
  }
}
