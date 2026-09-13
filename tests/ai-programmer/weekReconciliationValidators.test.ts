// AI-Powered Weekly Reconciliation (spec §13, domain/safety tests):
// structural (validateWeekReconciliationSchema) and domain
// (validateWeekReconciliationDomain) validation for `reconcile_week`
// output. Builds a real AIReconciliationContext from a real database,
// then validates hand-built outputs against it via the real validators —
// never a reimplementation of their rules.

import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { buildReconciliationContext } from '../../src/ai-programmer/context/reconciliationContextBuilder.js';
import type { AIReconciliationContext } from '../../src/ai-programmer/context/reconciliationContextTypes.js';
import { validateWeekReconciliationSchema } from '../../src/ai-programmer/validation/weekReconciliationOutputValidator.js';
import { validateWeekReconciliationDomain } from '../../src/ai-programmer/validation/weekReconciliationDomainValidator.js';
import { AI_WEEK_RECONCILIATION_SCHEMA_VERSION, type AIWeekReconciliationDay, type AIWeekReconciliationOutput } from '../../src/ai-programmer/contracts/weekReconciliationTypes.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13';

let db: Database.Database;
let context: AIReconciliationContext;

const VALID_EXERCISE = {
  exerciseId: 'flat-barbell-bench-press',
  role: 'primary' as const,
  targetType: 'physique_target' as const,
  targetId: 'mid-pec',
  classification: 'specialization' as const,
  sets: 3,
  repsMin: 6,
  repsMax: 12,
  rirMin: 1,
  rirMax: 3,
  rationale: ['Direct mid-pec exposure.'],
  source: 'blueprint' as const,
};

/** Builds a fully valid week output from a real context — every
 * non-locked, non-target day is returned unchanged; the target day is
 * switched to gym with one valid exercise. Callers mutate the result for
 * negative-path tests. */
function validWeekOutput(ctx: AIReconciliationContext, overrides: Partial<AIWeekReconciliationOutput> = {}): AIWeekReconciliationOutput {
  const days: AIWeekReconciliationDay[] = ctx.existingProgram.map((existing) => {
    if (existing.locked) {
      return { date: existing.date, weekday: existing.weekday, activity: existing.activity, changeType: 'unchanged', locked: true, session: null };
    }
    if (existing.date === ctx.request.targetDate) {
      return {
        date: existing.date,
        weekday: existing.weekday,
        activity: 'gym',
        changeType: 'modified',
        locked: false,
        session: { sessionPurpose: 'chest', availableMinutes: 60, estimatedMinutes: 45, exercises: [VALID_EXERCISE], skipped: [] },
      };
    }
    return { date: existing.date, weekday: existing.weekday, activity: existing.activity, changeType: 'unchanged', locked: false, session: null };
  });
  return {
    schemaVersion: AI_WEEK_RECONCILIATION_SCHEMA_VERSION,
    proposalId: 'p-1',
    mode: 'reconcile_week',
    targetDate: ctx.request.targetDate,
    requestedActivity: 'gym',
    days,
    reconciliation: { changedDates: [ctx.request.targetDate], preservedLockedDates: [...ctx.lockedDates], rationale: 'Move the gym session to the requested day.', warnings: [] },
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
  context = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
});

describe('validateWeekReconciliationSchema', () => {
  it('accepts a well-formed output', () => {
    const result = validateWeekReconciliationSchema(validWeekOutput(context));
    expect(result.ok).toBe(true);
    expect(result.value?.days).toHaveLength(7);
  });

  it('rejects wrong schemaVersion', () => {
    const result = validateWeekReconciliationSchema({ ...validWeekOutput(context), schemaVersion: 'wrong' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /schemaVersion/.test(e))).toBe(true);
  });

  it('rejects wrong mode', () => {
    const result = validateWeekReconciliationSchema({ ...validWeekOutput(context), mode: 'generate_session' });
    expect(result.ok).toBe(false);
  });

  it('rejects requestedActivity other than "gym"', () => {
    const result = validateWeekReconciliationSchema({ ...validWeekOutput(context), requestedActivity: 'badminton' });
    expect(result.ok).toBe(false);
  });

  it('rejects fewer than 7 days', () => {
    const output = validWeekOutput(context);
    const result = validateWeekReconciliationSchema({ ...output, days: output.days.slice(0, 6) });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /expected exactly 7 entries/.test(e))).toBe(true);
  });

  it('rejects more than 7 days', () => {
    const output = validWeekOutput(context);
    const result = validateWeekReconciliationSchema({ ...output, days: [...output.days, output.days[0]] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /expected exactly 7 entries/.test(e))).toBe(true);
  });

  it('rejects an invalid day activity enum value', () => {
    const output = validWeekOutput(context);
    const bad = { ...output, days: output.days.map((d, i) => (i === 0 ? { ...d, activity: 'not-a-real-activity' } : d)) };
    const result = validateWeekReconciliationSchema(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /\.activity:/.test(e))).toBe(true);
  });

  it('rejects an invalid changeType enum value', () => {
    const output = validWeekOutput(context);
    const bad = { ...output, days: output.days.map((d, i) => (i === 0 ? { ...d, changeType: 'sideways' } : d)) };
    const result = validateWeekReconciliationSchema(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /\.changeType:/.test(e))).toBe(true);
  });

  it('rejects a missing/invalid exercise classification', () => {
    const output = validWeekOutput(context);
    const targetDay = output.days.find((d) => d.date === context.request.targetDate)!;
    const bad = {
      ...output,
      days: output.days.map((d) =>
        d.date === targetDay.date
          ? { ...d, session: { ...d.session!, exercises: [{ ...VALID_EXERCISE, classification: 'not-a-real-classification' }] } }
          : d
      ),
    };
    const result = validateWeekReconciliationSchema(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /classification/.test(e))).toBe(true);
  });

  it('rejects a reconciliation.rationale containing dangerous content', () => {
    const output = validWeekOutput(context);
    const bad = { ...output, reconciliation: { ...output.reconciliation, rationale: '<script>alert(1)</script>' } };
    const result = validateWeekReconciliationSchema(bad);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object payload', () => {
    const result = validateWeekReconciliationSchema('not an object');
    expect(result.ok).toBe(false);
  });

  it('accepts a null session for a rest/unselected day', () => {
    const result = validateWeekReconciliationSchema(validWeekOutput(context));
    expect(result.ok).toBe(true);
    const restDay = result.value?.days.find((d) => d.date !== context.request.targetDate && !d.locked);
    expect(restDay?.session).toBeNull();
  });
});

describe('validateWeekReconciliationDomain', () => {
  it('accepts a valid, structurally-parsed output', () => {
    const output = validWeekOutput(context);
    const result = validateWeekReconciliationDomain(output, context, db);
    expect(result.ok).toBe(true);
  });

  it('rejects a targetDate mismatch against the request', () => {
    const output = validWeekOutput(context, { targetDate: '2026-09-08' });
    const result = validateWeekReconciliationDomain(output, context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /targetDate/.test(e))).toBe(true);
  });

  it('rejects when the returned dates are not exactly the 7 expected dates in order', () => {
    const output = validWeekOutput(context);
    const shuffled = { ...output, days: [...output.days].reverse() };
    const result = validateWeekReconciliationDomain(shuffled, context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /expected exactly the 7 dates/.test(e))).toBe(true);
  });

  it('rejects modifying a locked day', () => {
    new WorkoutSessionsRepo(db).createSession({ date: '2026-09-08', session_type: 'gym', status: 'completed' });
    const lockedContext = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const output = validWeekOutput(lockedContext);
    const tampered = {
      ...output,
      days: output.days.map((d) => (d.date === '2026-09-08' ? { ...d, changeType: 'modified' as const, activity: 'gym' as const } : d)),
    };
    const result = validateWeekReconciliationDomain(tampered, lockedContext, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /is locked/.test(e))).toBe(true);
  });

  it('rejects when the target day activity is not gym or both', () => {
    const output = validWeekOutput(context);
    const bad = {
      ...output,
      days: output.days.map((d) => (d.date === context.request.targetDate ? { ...d, activity: 'badminton' as const } : d)),
    };
    const result = validateWeekReconciliationDomain(bad, context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /activity must be "gym" or "both"/.test(e))).toBe(true);
  });

  it('accepts "both" as a valid target-day activity', () => {
    const output = validWeekOutput(context);
    const withBoth = {
      ...output,
      days: output.days.map((d) => (d.date === context.request.targetDate ? { ...d, activity: 'both' as const } : d)),
    };
    const result = validateWeekReconciliationDomain(withBoth, context, db);
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown/invented exercise ID', () => {
    const output = validWeekOutput(context);
    const bad = {
      ...output,
      days: output.days.map((d) =>
        d.date === context.request.targetDate
          ? { ...d, session: { ...d.session!, exercises: [{ ...VALID_EXERCISE, exerciseId: 'totally-made-up-exercise' }] } }
          : d
      ),
    };
    const result = validateWeekReconciliationDomain(bad, context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /not a known Blueprint exercise/.test(e))).toBe(true);
  });

  it('rejects an invalid/invented target ID', () => {
    const output = validWeekOutput(context);
    const bad = {
      ...output,
      days: output.days.map((d) =>
        d.date === context.request.targetDate
          ? { ...d, session: { ...d.session!, exercises: [{ ...VALID_EXERCISE, targetId: 'totally-made-up-target' }] } }
          : d
      ),
    };
    const result = validateWeekReconciliationDomain(bad, context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /was not among the targets supplied/.test(e))).toBe(true);
  });

  it('rejects a duplicate exerciseId within the same session (authored-set inflation guard reuse)', () => {
    const output = validWeekOutput(context);
    const bad = {
      ...output,
      days: output.days.map((d) =>
        d.date === context.request.targetDate ? { ...d, session: { ...d.session!, exercises: [VALID_EXERCISE, VALID_EXERCISE] } } : d
      ),
    };
    const result = validateWeekReconciliationDomain(bad, context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /duplicate exerciseId/.test(e))).toBe(true);
  });

  it('rejects a mismatched preservedLockedDates (missing an actually-locked date)', () => {
    new WorkoutSessionsRepo(db).createSession({ date: '2026-09-08', session_type: 'gym', status: 'completed' });
    const lockedContext = buildReconciliationContext(db, { targetDate: SUNDAY, requestedActivity: 'gym' });
    const output = validWeekOutput(lockedContext, { reconciliation: { ...validWeekOutput(lockedContext).reconciliation, preservedLockedDates: [] } });
    const result = validateWeekReconciliationDomain(output, lockedContext, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /preservedLockedDates: missing locked date/.test(e))).toBe(true);
  });

  it('rejects a preservedLockedDates entry that is not actually locked', () => {
    const output = validWeekOutput(context, {
      reconciliation: { ...validWeekOutput(context).reconciliation, preservedLockedDates: [context.request.targetDate] },
    });
    const result = validateWeekReconciliationDomain(output, context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /is not actually a locked date/.test(e))).toBe(true);
  });

  it('rejects a targetDate that has become locked since context build (db re-check)', () => {
    const output = validWeekOutput(context);
    new WorkoutSessionsRepo(db).createSession({ date: context.request.targetDate, session_type: 'gym', status: 'completed' });
    const result = validateWeekReconciliationDomain(output, context, db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /is locked by workout session/.test(e))).toBe(true);
  });

  it('skips the live-lock re-check when db is not supplied', () => {
    const output = validWeekOutput(context);
    const result = validateWeekReconciliationDomain(output, context);
    expect(result.ok).toBe(true);
  });
});
