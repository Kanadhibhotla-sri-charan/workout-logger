// Leg training mode (2026-10-18). 'hypertrophy' = legs are trained for
// size like every other muscle (the original behaviour). 'athletic' = the
// owner's choice: leg muscles get no muscle-growth volume anywhere, and
// the weekly Legs slot becomes an Athletic day (badminton-oriented drills
// and whole-body conditioning; see src/athletic/).

import type Database from 'better-sqlite3';
import { targetIdsForArea } from './injuryPausesRepo.js';
import { UsersRepo } from './usersRepo.js';

export const LEG_TRAINING_MODES = ['hypertrophy', 'athletic'] as const;
export type LegTrainingMode = (typeof LEG_TRAINING_MODES)[number];

export class LegTrainingRepo {
  constructor(private db: Database.Database) {}

  get(): LegTrainingMode {
    const userId = new UsersRepo(this.db).getOrCreateDefault().id;
    const row = this.db.prepare('SELECT leg_training FROM training_profiles WHERE user_id = ?').get(userId) as { leg_training: string | null } | undefined;
    return row?.leg_training === 'athletic' ? 'athletic' : 'hypertrophy';
  }

  /** Returns false when the user has no training profile yet. */
  set(mode: LegTrainingMode): boolean {
    const userId = new UsersRepo(this.db).getOrCreateDefault().id;
    return this.db.prepare('UPDATE training_profiles SET leg_training = ? WHERE user_id = ?').run(mode, userId).changes > 0;
  }

  /** Leg physique targets that get no muscle-growth volume: all of the
   * Legs area's targets in athletic mode, none otherwise. */
  athleticLegTargetIds(): Set<string> {
    return this.get() === 'athletic' ? new Set(targetIdsForArea('legs')) : new Set();
  }
}
