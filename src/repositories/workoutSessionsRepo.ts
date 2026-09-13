import type Database from 'better-sqlite3';
import { resolveExercise } from '../engine/exerciseUniverse.js';
import type {
  ExercisePerformance,
  ExerciseRole,
  GoalContext,
  Set,
  SessionType,
  WorkoutSession,
  WorkoutSessionSourceType,
  WorkoutSessionStatus,
} from '../contracts/types.js';
import { newId, nowIso } from './ids.js';

/** Neither a known Blueprint exercise (§4.1) nor an approved
 * outside-Blueprint exercise (§4.2) — see src/engine/exerciseUniverse.ts. */
export class UnknownExerciseError extends Error {
  constructor(public exerciseId: string) {
    super(`"${exerciseId}" is not a known Blueprint exercise id, and not an approved outside-Blueprint exercise`);
    this.name = 'UnknownExerciseError';
  }
}

/** @deprecated renamed to UnknownExerciseError — exercises can now also
 * come from an approved outside-Blueprint proposal, not only Blueprint. */
export { UnknownExerciseError as UnknownBlueprintExerciseError };

interface WorkoutSessionRow {
  session_id: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  session_type: string;
  program_id: string | null;
  program_session_id: string | null;
  goal_type: 'aesthetic' | 'functional' | null;
  goal_id: string | null;
  goal_priority: number | null;
  program_phase: string | null;
  status: WorkoutSessionStatus;
  notes: string | null;
  created_at: string;
  source_type: WorkoutSessionSourceType;
  supersedes_program_session_id: string | null;
}

function rowToSession(row: WorkoutSessionRow): WorkoutSession {
  const goal_context: GoalContext | null =
    row.goal_type && row.goal_id
      ? {
          goal_type: row.goal_type,
          goal_id: row.goal_id,
          priority: row.goal_priority ?? 0,
          program_phase: row.program_phase,
        }
      : null;
  return {
    session_id: row.session_id,
    date: row.date,
    start_time: row.start_time,
    end_time: row.end_time,
    duration_minutes: row.duration_minutes,
    session_type: row.session_type,
    program_id: row.program_id,
    program_session_id: row.program_session_id,
    goal_context,
    status: row.status,
    notes: row.notes,
    created_at: row.created_at,
    source_type: row.source_type,
    supersedes_program_session_id: row.supersedes_program_session_id,
  };
}

export interface CreateWorkoutSessionInput {
  date: string;
  start_time?: string | null;
  end_time?: string | null;
  duration_minutes?: number | null;
  session_type: SessionType;
  program_id?: string | null;
  program_session_id?: string | null;
  goal_context?: GoalContext | null;
  status?: WorkoutSessionStatus;
  notes?: string | null;
  /** Final AI-Deterministic Precedence and Scheduling Fixes §1: which
   * generator created this session — defaults to 'deterministic' (the
   * pre-existing, only-ever-deterministic behavior every caller before
   * this fix relied on). `aiProposalLifecycle.ts`'s commit is the only
   * caller that passes `'ai'`; a "log something else outside the
   * generated plan" flow should pass `'manual'`. */
  source_type?: WorkoutSessionSourceType;
  /** Set only when this session's content REPLACES a deterministic
   * `program_sessions` prescription that already existed for this date
   * — never set for a plain 'deterministic'-sourced session (which IS
   * that prescription, not a replacement of it). */
  supersedes_program_session_id?: string | null;
}

export interface AddExercisePerformanceInput {
  exercise_id: string;
  order: number;
  role: ExerciseRole | string;
  sets: Array<Partial<Set> & { set_number: number }>;
  /** Optional PLANNED prescription for this exercise — see
   * ExercisePerformance's own doc comment. Omitted (all undefined ->
   * stored as NULL) for a plain logged/performed exercise, which has no
   * prescription. Never conflated with `sets[].reps`/`rir`, which stay
   * PERFORMED values regardless of whether a prescription is given. */
  target_sets?: number | null;
  target_reps_min?: number | null;
  target_reps_max?: number | null;
  target_rir_min?: number | null;
  target_rir_max?: number | null;
  target_rest_seconds?: number | null;
}

export interface UpdateWorkoutSessionInput {
  end_time?: string | null;
  duration_minutes?: number | null;
  status?: WorkoutSessionStatus;
  notes?: string | null;
}

const DEFAULT_SET: Omit<Set, 'set_number'> = {
  weight: null,
  reps: null,
  completed: false,
  rir: null,
  rpe: null,
  rest_seconds: null,
  technique: null,
  tempo: null,
  notes: null,
};

export class WorkoutSessionsRepo {
  constructor(private db: Database.Database) {}

  createSession(input: CreateWorkoutSessionInput): WorkoutSession {
    const session: WorkoutSession = {
      session_id: newId('wsession'),
      date: input.date,
      start_time: input.start_time ?? null,
      end_time: input.end_time ?? null,
      duration_minutes: input.duration_minutes ?? null,
      session_type: input.session_type,
      program_id: input.program_id ?? null,
      program_session_id: input.program_session_id ?? null,
      goal_context: input.goal_context ?? null,
      status: input.status ?? 'planned',
      notes: input.notes ?? null,
      created_at: nowIso(),
      source_type: input.source_type ?? 'deterministic',
      supersedes_program_session_id: input.supersedes_program_session_id ?? null,
    };

    this.db
      .prepare(
        `INSERT INTO workout_sessions
           (session_id, date, start_time, end_time, duration_minutes, session_type,
            program_id, program_session_id, goal_type, goal_id, goal_priority, program_phase,
            status, notes, created_at, source_type, supersedes_program_session_id)
         VALUES
           (@session_id, @date, @start_time, @end_time, @duration_minutes, @session_type,
            @program_id, @program_session_id, @goal_type, @goal_id, @goal_priority, @program_phase,
            @status, @notes, @created_at, @source_type, @supersedes_program_session_id)`
      )
      .run({
        session_id: session.session_id,
        date: session.date,
        start_time: session.start_time,
        end_time: session.end_time,
        duration_minutes: session.duration_minutes,
        session_type: session.session_type,
        program_id: session.program_id,
        program_session_id: session.program_session_id,
        goal_type: session.goal_context?.goal_type ?? null,
        goal_id: session.goal_context?.goal_id ?? null,
        goal_priority: session.goal_context?.priority ?? null,
        program_phase: session.goal_context?.program_phase ?? null,
        source_type: session.source_type,
        supersedes_program_session_id: session.supersedes_program_session_id,
        status: session.status,
        notes: session.notes,
        created_at: session.created_at,
      });

    return session;
  }

  /** AI Activity Alignment / Non-Regenerative Schedule Fixes (Part 2):
   * reassigns which calendar date a session belongs to — used ONLY by
   * src/engine/scheduleOperations.ts's swap operation, to move a still-
   * `planned` AI-committed session along with its day during a schedule
   * swap (the session's own exercises/sets are never touched, only
   * `date`). Never called for a `completed`/`in_progress` session —
   * callers check that before ever reaching here (a locked day's real
   * history must never move). */
  moveDate(id: string, newDate: string): void {
    this.db.prepare('UPDATE workout_sessions SET date = @date WHERE session_id = @session_id').run({ session_id: id, date: newDate });
  }

  updateSession(id: string, input: UpdateWorkoutSessionInput): WorkoutSession | undefined {
    const existing = this.getSession(id);
    if (!existing) return undefined;

    this.db
      .prepare(
        `UPDATE workout_sessions
         SET end_time = @end_time, duration_minutes = @duration_minutes, status = @status, notes = @notes
         WHERE session_id = @session_id`
      )
      .run({
        session_id: id,
        end_time: input.end_time !== undefined ? input.end_time : existing.end_time,
        duration_minutes: input.duration_minutes !== undefined ? input.duration_minutes : existing.duration_minutes,
        status: input.status ?? existing.status,
        notes: input.notes !== undefined ? input.notes : existing.notes,
      });

    return this.getSession(id);
  }

  getSession(id: string): WorkoutSession | undefined {
    const row = this.db.prepare('SELECT * FROM workout_sessions WHERE session_id = ?').get(id) as
      | WorkoutSessionRow
      | undefined;
    return row ? rowToSession(row) : undefined;
  }

  listSessionsByDate(date: string): WorkoutSession[] {
    const rows = this.db.prepare('SELECT * FROM workout_sessions WHERE date = ? ORDER BY start_time ASC').all(date) as WorkoutSessionRow[];
    return rows.map(rowToSession);
  }

  listSessions(): WorkoutSession[] {
    const rows = this.db.prepare('SELECT * FROM workout_sessions ORDER BY date DESC, created_at DESC').all() as WorkoutSessionRow[];
    return rows.map(rowToSession);
  }

  /** Sessions with `date` in [start, end], inclusive — used by
   * src/engine/trainingState.ts to fetch the data window exposure
   * aggregation needs. */
  listSessionsInRange(start: string, end: string): WorkoutSession[] {
    const rows = this.db
      .prepare('SELECT * FROM workout_sessions WHERE date >= ? AND date <= ? ORDER BY date ASC, start_time ASC')
      .all(start, end) as WorkoutSessionRow[];
    return rows.map(rowToSession);
  }

  /** Throws UnknownExerciseError if exercise_id resolves neither in
   * Blueprint nor as an approved outside-Blueprint exercise (§4) — this
   * is the enforcement point that keeps every persisted performance
   * anchored to a real, resolvable, approved exercise. */
  addExercisePerformance(workoutSessionId: string, input: AddExercisePerformanceInput): ExercisePerformance {
    if (!resolveExercise(this.db, input.exercise_id)) {
      throw new UnknownExerciseError(input.exercise_id);
    }

    const performanceId = newId('perf');
    const sets: Set[] = input.sets
      .slice()
      .sort((a, b) => a.set_number - b.set_number)
      .map((s) => ({ ...DEFAULT_SET, ...s }));

    const insertExercise = this.db.prepare(
      `INSERT INTO workout_exercises
         (id, workout_session_id, exercise_id, order_index, role,
          target_sets, target_reps_min, target_reps_max, target_rir_min, target_rir_max, target_rest_seconds)
       VALUES
         (@id, @workout_session_id, @exercise_id, @order_index, @role,
          @target_sets, @target_reps_min, @target_reps_max, @target_rir_min, @target_rir_max, @target_rest_seconds)`
    );
    const insertSet = this.db.prepare(
      `INSERT INTO workout_sets
         (id, workout_exercise_id, set_number, weight, reps, completed, rir, rpe, rest_seconds, technique, tempo, notes)
       VALUES
         (@id, @workout_exercise_id, @set_number, @weight, @reps, @completed, @rir, @rpe, @rest_seconds, @technique, @tempo, @notes)`
    );

    const prescription = {
      target_sets: input.target_sets ?? null,
      target_reps_min: input.target_reps_min ?? null,
      target_reps_max: input.target_reps_max ?? null,
      target_rir_min: input.target_rir_min ?? null,
      target_rir_max: input.target_rir_max ?? null,
      target_rest_seconds: input.target_rest_seconds ?? null,
    };

    const tx = this.db.transaction(() => {
      insertExercise.run({
        id: performanceId,
        workout_session_id: workoutSessionId,
        exercise_id: input.exercise_id,
        order_index: input.order,
        role: input.role,
        ...prescription,
      });
      for (const set of sets) {
        insertSet.run({
          id: newId('set'),
          workout_exercise_id: performanceId,
          set_number: set.set_number,
          weight: set.weight,
          reps: set.reps,
          completed: set.completed ? 1 : 0,
          rir: set.rir,
          rpe: set.rpe,
          rest_seconds: set.rest_seconds,
          technique: set.technique,
          tempo: set.tempo,
          notes: set.notes,
        });
      }
    });
    tx();

    return {
      id: performanceId,
      workout_session_id: workoutSessionId,
      exercise_id: input.exercise_id,
      order: input.order,
      role: input.role,
      ...prescription,
      sets,
    };
  }

  /** UI Build Phase §35: every real performance of one exact exercise,
   * across every real session, most-recent-session-first — the History
   * page's exercise filter. A thin, direct join reusing the exact same
   * table shape getExercisePerformances already reads; no new domain
   * logic, no computed metrics (e.g. no 1RM — spec §35 forbids inventing
   * one). */
  listPerformancesForExercise(exerciseId: string): Array<{ session_id: string; date: string; sets: Set[] }> {
    const exerciseRows = this.db
      .prepare(
        `SELECT we.id, we.workout_session_id, ws.date
         FROM workout_exercises we
         JOIN workout_sessions ws ON ws.session_id = we.workout_session_id
         WHERE we.exercise_id = ?
         ORDER BY ws.date DESC, ws.created_at DESC`
      )
      .all(exerciseId) as Array<{ id: string; workout_session_id: string; date: string }>;

    const setsStmt = this.db.prepare('SELECT * FROM workout_sets WHERE workout_exercise_id = ? ORDER BY set_number ASC');

    return exerciseRows.map((row) => {
      const setRows = setsStmt.all(row.id) as Array<{
        set_number: number;
        weight: number | null;
        reps: number | null;
        completed: number;
        rir: number | null;
        rpe: number | null;
        rest_seconds: number | null;
        technique: string | null;
        tempo: string | null;
        notes: string | null;
      }>;
      return {
        session_id: row.workout_session_id,
        date: row.date,
        sets: setRows.map((s) => ({ ...s, completed: s.completed === 1 })),
      };
    });
  }

  getExercisePerformances(workoutSessionId: string): ExercisePerformance[] {
    const exerciseRows = this.db
      .prepare('SELECT * FROM workout_exercises WHERE workout_session_id = ? ORDER BY order_index ASC')
      .all(workoutSessionId) as Array<{
      id: string;
      exercise_id: string;
      order_index: number;
      role: string;
      target_sets: number | null;
      target_reps_min: number | null;
      target_reps_max: number | null;
      target_rir_min: number | null;
      target_rir_max: number | null;
      target_rest_seconds: number | null;
    }>;

    const setsStmt = this.db.prepare('SELECT * FROM workout_sets WHERE workout_exercise_id = ? ORDER BY set_number ASC');

    return exerciseRows.map((row) => {
      const setRows = setsStmt.all(row.id) as Array<{
        set_number: number;
        weight: number | null;
        reps: number | null;
        completed: number;
        rir: number | null;
        rpe: number | null;
        rest_seconds: number | null;
        technique: string | null;
        tempo: string | null;
        notes: string | null;
      }>;
      return {
        id: row.id,
        workout_session_id: workoutSessionId,
        exercise_id: row.exercise_id,
        order: row.order_index,
        role: row.role,
        target_sets: row.target_sets,
        target_reps_min: row.target_reps_min,
        target_reps_max: row.target_reps_max,
        target_rir_min: row.target_rir_min,
        target_rir_max: row.target_rir_max,
        target_rest_seconds: row.target_rest_seconds,
        sets: setRows.map((s) => ({ ...s, completed: s.completed === 1 })),
      };
    });
  }
}
