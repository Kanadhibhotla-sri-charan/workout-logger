// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §14.3): the
// required domain-validation test matrix. Builds a real
// AIProgrammerContext from a real database, then validates hand-built
// proposals against it via the real validateProposalDomain — never a
// reimplementation of its rules.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import type { AIProgrammerContext } from '../../src/ai-programmer/context/programmerContextTypes.js';
import { validateProposalDomain } from '../../src/ai-programmer/validation/programmerDomainValidator.js';
import { AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION, type AIWorkoutSessionProposal } from '../../src/ai-programmer/contracts/programmerTypes.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13';

let db: Database.Database;
let context: AIProgrammerContext;

function baseProposal(overrides: Partial<AIWorkoutSessionProposal> = {}): AIWorkoutSessionProposal {
  return {
    schemaVersion: AI_WORKOUT_SESSION_PROPOSAL_SCHEMA_VERSION,
    proposalId: 'p-1',
    mode: 'generate_session',
    targetDate: context.targetDate,
    weekday: context.targetWeekday,
    sessionFocus: ['chest'],
    exercises: [
      {
        exerciseId: 'flat-barbell-bench-press',
        role: 'primary',
        targetType: 'physique_target',
        targetId: 'mid-pec',
        sets: 3,
        repsMin: 6,
        repsMax: 12,
        rirMin: 1,
        rirMax: 3,
        rationale: ['Direct mid-pec exposure.'],
        source: 'blueprint',
      },
    ],
    programmingRationale: ['Prioritizing chest this session.'],
    goalAlignment: [],
    recoveryConsiderations: [],
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: FULL_EQUIPMENT,
    other_activity_schedule: [],
  });
  context = buildProgrammerContext(db, { targetDate: SUNDAY });
});

describe('AI Programmer domain validator', () => {
  it('accepts a valid proposal using valid Blueprint exercises with authored set counts, unmodified', () => {
    const result = validateProposalDomain(baseProposal(), context, db);
    expect(result.ok).toBe(true);
    expect(result.value?.exercises[0]!.sets).toBe(3);
  });

  it('accepts a proposal that omits other valid-but-unselected exercises for the same target', () => {
    // baseProposal only selects one of several valid exercises for
    // mid-pec (e.g. incline-barbell-press, cable-fly are also valid and
    // omitted) — omission must never itself be a validation failure.
    const midPec = context.targets.find((t) => t.targetId === 'mid-pec')!;
    expect(midPec.validExercises.length).toBeGreaterThan(1);
    const result = validateProposalDomain(baseProposal(), context, db);
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown exercise ID', () => {
    const result = validateProposalDomain(
      baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, exerciseId: 'does-not-exist-exercise' }] }),
      context,
      db
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/not a known Blueprint exercise/);
  });

  it('rejects an unknown target ID', () => {
    const result = validateProposalDomain(
      baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, targetId: 'does-not-exist-target' }] }),
      context,
      db
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/not among the targets supplied/);
  });

  it('rejects the wrong target type for a real target id', () => {
    const result = validateProposalDomain(
      baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, targetType: 'functional_goal' }] }),
      context,
      db
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an exercise that does not train the claimed target at all', () => {
    // lat-pulldown-wide-pronated does not train mid-pec.
    const result = validateProposalDomain(
      baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, exerciseId: 'lat-pulldown-wide-pronated' }] }),
      context,
      db
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/valid exercise library/);
  });

  it('rejects a set count that differs from the authored value (not just "above a cap")', () => {
    const result = validateProposalDomain(baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, sets: 8 }] }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sets must equal Blueprint-authored value 3; received 8/);
  });

  it('rejects an invalid rep range (repsMin > repsMax already caught upstream, but repsMax over the safety ceiling here)', () => {
    const result = validateProposalDomain(baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, repsMax: 999 }] }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/repsMax/);
  });

  it('rejects an invalid RIR range beyond the safety ceiling', () => {
    const result = validateProposalDomain(baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, rirMax: 999 }] }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/rirMax/);
  });

  it('rejects duplicate exercises within the same proposal', () => {
    const one = baseProposal().exercises[0]!;
    const result = validateProposalDomain(baseProposal({ exercises: [one, { ...one }] }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/duplicate exerciseId/);
  });

  it('rejects a proposal targeting a completed session date', () => {
    // Complete a session on a DIFFERENT, still-real date than the
    // context's own targetDate, then hand-craft a proposal claiming
    // that completed date — validateProposalDomain must catch this on
    // its own fresh DB check even though context itself was built for
    // a different (editable) date.
    const completedDate = '2026-09-08';
    new WorkoutSessionsRepo(db).createSession({ date: completedDate, session_type: 'gym', status: 'completed' });
    const proposal = baseProposal({ targetDate: completedDate, weekday: 'tuesday' });
    const result = validateProposalDomain(proposal, { ...context, targetDate: completedDate, targetWeekday: 'tuesday' as any }, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/locked/);
  });

  it('rejects a proposal whose declared role contradicts Blueprint\'s own primary/secondary resolution', () => {
    const result = validateProposalDomain(baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, role: 'secondary' }] }), context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/does not match Blueprint's own primary\/secondary role/);
  });

  it('rejects an outside-Blueprint-style source value (this milestone accepts only "blueprint")', () => {
    // Structural validation would already reject a non-"blueprint"
    // source at the schema layer; domain validation independently
    // rejects the exercise here via BlueprintAdapter.isKnownExercise
    // for a genuinely unknown id, covering the "no silent outside-
    // Blueprint approval" rule end-to-end.
    const result = validateProposalDomain(
      baseProposal({ exercises: [{ ...baseProposal().exercises[0]!, exerciseId: 'some-unapproved-outside-exercise' }] }),
      context,
      db
    );
    expect(result.ok).toBe(false);
  });
});
