import type Database from 'better-sqlite3';
import type { BadmintonFormat, BadmintonIntensity, BadmintonSessionDetails } from '../contracts/types.js';
import { WorkoutSessionsRepo } from './workoutSessionsRepo.js';

export class UnknownWorkoutSessionError extends Error {
  constructor(public workoutSessionId: string) {
    super(`"${workoutSessionId}" is not a known workout session id`);
    this.name = 'UnknownWorkoutSessionError';
  }
}

/** Spec §15: badminton_session_details only makes sense attached to a
 * WorkoutSession whose session_type is 'badminton' — a session of any
 * other type has no business carrying badminton-specific detail. */
export class NotABadmintonSessionError extends Error {
  constructor(public workoutSessionId: string, public actualSessionType: string) {
    super(`workout session "${workoutSessionId}" has session_type "${actualSessionType}", not "badminton"`);
    this.name = 'NotABadmintonSessionError';
  }
}

export class InvalidBadmintonSessionDetailsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBadmintonSessionDetailsError';
  }
}

const VALID_INTENSITIES: BadmintonIntensity[] = ['low', 'medium', 'high'];
const VALID_FORMATS: BadmintonFormat[] = ['singles', 'doubles'];

function isRating1to5(value: unknown): value is 1 | 2 | 3 | 4 | 5 {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5;
}

export interface RecordBadmintonSessionDetailsInput {
  workout_session_id: string;
  intensity?: BadmintonIntensity | null;
  format?: BadmintonFormat | null;
  games_count?: number | null;
  session_quality?: 1 | 2 | 3 | 4 | 5 | null;
  post_session_fatigue?: 1 | 2 | 3 | 4 | 5 | null;
  notes?: string | null;
}

/** Spec §15: badminton is a first-class training modality — duration,
 * intensity, singles/doubles, games, quality, and fatigue must be
 * captured as their own data, never converted into fake
 * hypertrophy-set-equivalents. This repo is a thin 1:1 attachment onto
 * an existing WorkoutSession (session-level date/duration/notes already
 * live there — see WorkoutSessionsRepo); it only owns the
 * badminton-specific fields. `record()` upserts, since a session's
 * detail is naturally filled in and then sometimes corrected after the
 * fact, not append-only like goal_events. */
export class BadmintonSessionDetailsRepo {
  constructor(private db: Database.Database) {}

  record(input: RecordBadmintonSessionDetailsInput): BadmintonSessionDetails {
    const session = new WorkoutSessionsRepo(this.db).getSession(input.workout_session_id);
    if (!session) {
      throw new UnknownWorkoutSessionError(input.workout_session_id);
    }
    if (session.session_type !== 'badminton') {
      throw new NotABadmintonSessionError(input.workout_session_id, session.session_type);
    }
    if (input.intensity != null && !VALID_INTENSITIES.includes(input.intensity)) {
      throw new InvalidBadmintonSessionDetailsError(`intensity must be one of ${VALID_INTENSITIES.join(', ')} or null`);
    }
    if (input.format != null && !VALID_FORMATS.includes(input.format)) {
      throw new InvalidBadmintonSessionDetailsError(`format must be one of ${VALID_FORMATS.join(', ')} or null`);
    }
    if (input.games_count != null && (!Number.isInteger(input.games_count) || input.games_count < 0)) {
      throw new InvalidBadmintonSessionDetailsError('games_count must be a non-negative integer or null');
    }
    if (input.session_quality != null && !isRating1to5(input.session_quality)) {
      throw new InvalidBadmintonSessionDetailsError('session_quality must be an integer between 1 and 5, or null');
    }
    if (input.post_session_fatigue != null && !isRating1to5(input.post_session_fatigue)) {
      throw new InvalidBadmintonSessionDetailsError('post_session_fatigue must be an integer between 1 and 5, or null');
    }

    const details: BadmintonSessionDetails = {
      workout_session_id: input.workout_session_id,
      intensity: input.intensity ?? null,
      format: input.format ?? null,
      games_count: input.games_count ?? null,
      session_quality: input.session_quality ?? null,
      post_session_fatigue: input.post_session_fatigue ?? null,
      notes: input.notes ?? null,
    };

    this.db
      .prepare(
        `INSERT INTO badminton_session_details
           (workout_session_id, intensity, format, games_count, session_quality, post_session_fatigue, notes)
         VALUES (@workout_session_id, @intensity, @format, @games_count, @session_quality, @post_session_fatigue, @notes)
         ON CONFLICT(workout_session_id) DO UPDATE SET
           intensity = excluded.intensity,
           format = excluded.format,
           games_count = excluded.games_count,
           session_quality = excluded.session_quality,
           post_session_fatigue = excluded.post_session_fatigue,
           notes = excluded.notes`
      )
      .run(details);

    return details;
  }

  get(workoutSessionId: string): BadmintonSessionDetails | undefined {
    return this.db
      .prepare('SELECT * FROM badminton_session_details WHERE workout_session_id = ?')
      .get(workoutSessionId) as BadmintonSessionDetails | undefined;
  }
}
