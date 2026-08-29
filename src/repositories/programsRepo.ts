import type Database from 'better-sqlite3';
import { BlueprintAdapter } from '../blueprint/adapter.js';
import type { ExerciseRole, Program, ProgramSession, ProgramSessionExercise, ProgramStatus, SessionType } from '../contracts/types.js';
import { newId, nowIso } from './ids.js';

interface ProgramRow {
  id: string;
  name: string;
  status: ProgramStatus;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  blueprint_commit: string;
  created_at: string;
}

export interface CreateProgramInput {
  name: string;
  goal_ids: string[];
  status?: ProgramStatus;
  start_date?: string | null;
  end_date?: string | null;
  notes?: string | null;
}

export interface CreateProgramSessionInput {
  program_id: string;
  day_index: number;
  name: string;
  planned_session_type: SessionType;
  exercises: Array<{
    exercise_id: string;
    order: number;
    role: ExerciseRole | string;
    target_sets?: number | null;
    target_reps_min?: number | null;
    target_reps_max?: number | null;
    notes?: string | null;
  }>;
  notes?: string | null;
}

export class ProgramsRepo {
  constructor(private db: Database.Database) {}

  createProgram(input: CreateProgramInput): Program {
    const program: Program = {
      id: newId('program'),
      name: input.name,
      goal_ids: input.goal_ids,
      status: input.status ?? 'draft',
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
      notes: input.notes ?? null,
      // Recorded once, at creation, from whatever Blueprint snapshot this
      // app currently has vendored — never overwritten afterward, so a
      // historical Program stays explainable even after Blueprint's data
      // changes under a later commit. See docs/architecture.md.
      blueprint_commit: BlueprintAdapter.getManifest().sourceCommit,
      created_at: nowIso(),
    };

    const insertProgram = this.db.prepare(
      `INSERT INTO programs (id, name, status, start_date, end_date, notes, blueprint_commit, created_at)
       VALUES (@id, @name, @status, @start_date, @end_date, @notes, @blueprint_commit, @created_at)`
    );
    const insertGoalLink = this.db.prepare('INSERT INTO program_goals (program_id, goal_id) VALUES (?, ?)');

    const tx = this.db.transaction(() => {
      insertProgram.run(program);
      for (const goalId of program.goal_ids) {
        insertGoalLink.run(program.id, goalId);
      }
    });
    tx();

    return program;
  }

  getProgram(id: string): Program | undefined {
    const row = this.db.prepare('SELECT * FROM programs WHERE id = ?').get(id) as ProgramRow | undefined;
    if (!row) return undefined;
    const goalRows = this.db.prepare('SELECT goal_id FROM program_goals WHERE program_id = ?').all(id) as Array<{
      goal_id: string;
    }>;
    return { ...row, goal_ids: goalRows.map((r) => r.goal_id) };
  }

  listPrograms(): Program[] {
    const rows = this.db.prepare('SELECT * FROM programs ORDER BY created_at DESC').all() as ProgramRow[];
    return rows.map((row) => {
      const goalRows = this.db
        .prepare('SELECT goal_id FROM program_goals WHERE program_id = ?')
        .all(row.id) as Array<{ goal_id: string }>;
      return { ...row, goal_ids: goalRows.map((r) => r.goal_id) };
    });
  }

  createProgramSession(input: CreateProgramSessionInput): ProgramSession {
    const session: ProgramSession = {
      id: newId('psession'),
      program_id: input.program_id,
      day_index: input.day_index,
      name: input.name,
      planned_session_type: input.planned_session_type,
      exercises: input.exercises.map((e) => ({
        exercise_id: e.exercise_id,
        order: e.order,
        role: e.role,
        target_sets: e.target_sets ?? null,
        target_reps_min: e.target_reps_min ?? null,
        target_reps_max: e.target_reps_max ?? null,
        notes: e.notes ?? null,
      })),
      notes: input.notes ?? null,
      created_at: nowIso(),
    };

    const insertSession = this.db.prepare(
      `INSERT INTO program_sessions (id, program_id, day_index, name, planned_session_type, notes, created_at)
       VALUES (@id, @program_id, @day_index, @name, @planned_session_type, @notes, @created_at)`
    );
    const insertExercise = this.db.prepare(
      `INSERT INTO program_session_exercises
         (id, program_session_id, exercise_id, order_index, role, target_sets, target_reps_min, target_reps_max, notes)
       VALUES (@id, @program_session_id, @exercise_id, @order_index, @role, @target_sets, @target_reps_min, @target_reps_max, @notes)`
    );

    const tx = this.db.transaction(() => {
      insertSession.run(session);
      for (const ex of session.exercises) {
        insertExercise.run({
          id: newId('pse'),
          program_session_id: session.id,
          exercise_id: ex.exercise_id,
          order_index: ex.order,
          role: ex.role,
          target_sets: ex.target_sets,
          target_reps_min: ex.target_reps_min,
          target_reps_max: ex.target_reps_max,
          notes: ex.notes,
        });
      }
    });
    tx();

    return session;
  }

  getProgramSession(id: string): ProgramSession | undefined {
    const row = this.db.prepare('SELECT * FROM program_sessions WHERE id = ?').get(id) as
      | Omit<ProgramSession, 'exercises'>
      | undefined;
    if (!row) return undefined;
    return { ...row, exercises: this.loadExercises(id) };
  }

  listProgramSessions(programId: string): ProgramSession[] {
    const rows = this.db
      .prepare('SELECT * FROM program_sessions WHERE program_id = ? ORDER BY day_index ASC')
      .all(programId) as Array<Omit<ProgramSession, 'exercises'>>;
    return rows.map((row) => ({ ...row, exercises: this.loadExercises(row.id) }));
  }

  private loadExercises(programSessionId: string): ProgramSessionExercise[] {
    const rows = this.db
      .prepare('SELECT * FROM program_session_exercises WHERE program_session_id = ? ORDER BY order_index ASC')
      .all(programSessionId) as Array<{
      exercise_id: string;
      order_index: number;
      role: string;
      target_sets: number | null;
      target_reps_min: number | null;
      target_reps_max: number | null;
      notes: string | null;
    }>;
    return rows.map((r) => ({
      exercise_id: r.exercise_id,
      order: r.order_index,
      role: r.role,
      target_sets: r.target_sets,
      target_reps_min: r.target_reps_min,
      target_reps_max: r.target_reps_max,
      notes: r.notes,
    }));
  }
}
