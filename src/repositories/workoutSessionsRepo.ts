import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import type {
  ExercisePerformance,
  ExerciseRole,
  GoalContext,
  Set,
  SessionType,
  WorkoutSession,
  WorkoutSessionStatus,
} from '../contracts/types.js';
import { newId, nowIso } from './ids.js';

export class UnknownBlueprintExerciseError extends Error {
  constructor(public exerciseId: string) {
    super(`"${exerciseId}" is not a known Blueprint exercise id`);
    this.name = 'UnknownBlueprintExerciseError';
  }
}

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
}

export interface AddExercisePerformanceInput {
  exercise_id: string;
  order: number;
  role: ExerciseRole | string;
  sets: Array<Partial<Set> & { set_number: number }>;
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
    };

    this.db
      .prepare(
        `INSERT INTO workout_sessions
           (session_id, date, start_time, end_time, duration_minutes, session_type,
            program_id, program_session_id, goal_type, goal_id, goal_priority, program_phase,
            status, notes, created_at)
         VALUES
           (@session_id, @date, @start_time, @end_time, @duration_minutes, @session_type,
            @program_id, @program_session_id, @goal_type, @goal_id, @goal_priority, @program_phase,
            @status, @notes, @created_at)`
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
        status: session.status,
        notes: session.notes,
        created_at: session.created_at,
      });

    return session;
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

  /** Throws UnknownBlueprintExerciseError if exercise_id does not resolve
   * in Blueprint — this is the enforcement point that keeps every
   * persisted performance anchored to a real, resolvable exercise. */
  addExercisePerformance(workoutSessionId: string, input: AddExercisePerformanceInput): ExercisePerformance {
    if (!BlueprintAdapter.isKnownExercise(input.exercise_id)) {
      throw new UnknownBlueprintExerciseError(input.exercise_id);
    }

    const performanceId = newId('perf');
    const sets: Set[] = input.sets
      .slice()
      .sort((a, b) => a.set_number - b.set_number)
      .map((s) => ({ ...DEFAULT_SET, ...s }));

    const insertExercise = this.db.prepare(
      `INSERT INTO workout_exercises (id, workout_session_id, exercise_id, order_index, role)
       VALUES (@id, @workout_session_id, @exercise_id, @order_index, @role)`
    );
    const insertSet = this.db.prepare(
      `INSERT INTO workout_sets
         (id, workout_exercise_id, set_number, weight, reps, completed, rir, rpe, rest_seconds, technique, tempo, notes)
       VALUES
         (@id, @workout_exercise_id, @set_number, @weight, @reps, @completed, @rir, @rpe, @rest_seconds, @technique, @tempo, @notes)`
    );

    const tx = this.db.transaction(() => {
      insertExercise.run({
        id: performanceId,
        workout_session_id: workoutSessionId,
        exercise_id: input.exercise_id,
        order_index: input.order,
        role: input.role,
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
      sets,
    };
  }

  getExercisePerformances(workoutSessionId: string): ExercisePerformance[] {
    const exerciseRows = this.db
      .prepare('SELECT * FROM workout_exercises WHERE workout_session_id = ? ORDER BY order_index ASC')
      .all(workoutSessionId) as Array<{ id: string; exercise_id: string; order_index: number; role: string }>;

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
        sets: setRows.map((s) => ({ ...s, completed: s.completed === 1 })),
      };
    });
  }
}
