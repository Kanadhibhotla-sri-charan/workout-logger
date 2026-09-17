// Coaching Depth Batch 1 spec §10 "Integration" required tests.

import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { buildCoachingFoundationContext } from '../../src/coaching/foundationContext.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import { buildReconciliationContext } from '../../src/ai-programmer/context/reconciliationContextBuilder.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
// A safely-future Monday so buildProgrammerContext/buildReconciliationContext
// never reject it as "in the past" purely from the passage of real
// calendar time (a known, pre-existing limitation of hardcoded test
// dates across this test suite — see this phase's own completion report).
const FUTURE_MONDAY = '2026-12-14';

let db: Database.Database;
let programId: string;

beforeEach(() => {
  db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  programId = user.id;
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
});

describe('buildCoachingFoundationContext — contains all three components', () => {
  it('returns programState, targetProfiles, scheduledFrequency, historicalSummaries', () => {
    const context = buildCoachingFoundationContext(db, {
      programId,
      referenceDate: FUTURE_MONDAY,
      weekBoundary: 'monday',
      weekStart: FUTURE_MONDAY,
      targetIds: ['rectus-abdominis', 'gastrocnemius'],
      persistedWeekSessions: [],
    });
    expect(context.programState).toBeDefined();
    expect(context.programState.blockKind).toBe('base');
    expect(context.targetProfiles['rectus-abdominis']).toBeDefined();
    expect(context.targetProfiles['gastrocnemius']).toBeDefined();
    expect(context.scheduledFrequency).toEqual({ 'rectus-abdominis': 0, gastrocnemius: 0 });
    expect(context.historicalSummaries['rectus-abdominis']).toBeDefined();
    expect(context.historicalSummaries['gastrocnemius']).toBeDefined();
  });
});

describe('buildCoachingFoundationContext — identical inputs produce identical context', () => {
  it('two calls with the same db state and inputs produce a deep-equal result', () => {
    const input = {
      programId,
      referenceDate: FUTURE_MONDAY,
      weekBoundary: 'monday' as const,
      weekStart: FUTURE_MONDAY,
      targetIds: ['rectus-abdominis'],
      persistedWeekSessions: [],
    };
    const first = buildCoachingFoundationContext(db, input);
    const second = buildCoachingFoundationContext(db, input);
    expect(second).toEqual(first);
  });
});

describe('buildCoachingFoundationContext — serializes successfully', () => {
  it('JSON.stringify succeeds and round-trips', () => {
    const context = buildCoachingFoundationContext(db, {
      programId,
      referenceDate: FUTURE_MONDAY,
      weekBoundary: 'monday',
      weekStart: FUTURE_MONDAY,
      targetIds: ['rectus-abdominis'],
      persistedWeekSessions: [],
    });
    const serialized = JSON.stringify(context);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized)).toEqual(context);
  });
});

describe('buildCoachingFoundationContext — scheduled frequency from a real persisted plan', () => {
  it('counts days from the persisted week snapshot\'s plannedWork, converted via weekStart + day_index', () => {
    const context = buildCoachingFoundationContext(db, {
      programId,
      referenceDate: FUTURE_MONDAY,
      weekBoundary: 'monday',
      weekStart: FUTURE_MONDAY,
      targetIds: ['rectus-abdominis'],
      persistedWeekSessions: [
        { day_index: 0, snapshot: { plannedWork: [{ target_id: 'rectus-abdominis' }] } }, // Monday
        { day_index: 3, snapshot: { plannedWork: [{ target_id: 'rectus-abdominis' }, { target_id: 'gastrocnemius' }] } }, // Thursday
        { day_index: 6, snapshot: { plannedWork: [{ target_id: 'gastrocnemius' }] } }, // Sunday — not rectus-abdominis
      ],
    });
    expect(context.scheduledFrequency['rectus-abdominis']).toBe(2);
  });

  it('defensively handles a malformed/unexpected snapshot shape without throwing', () => {
    const context = buildCoachingFoundationContext(db, {
      programId,
      referenceDate: FUTURE_MONDAY,
      weekBoundary: 'monday',
      weekStart: FUTURE_MONDAY,
      targetIds: ['rectus-abdominis'],
      persistedWeekSessions: [
        { day_index: 0, snapshot: null },
        { day_index: 1, snapshot: 'not an object' as unknown },
        { day_index: 2, snapshot: { plannedWork: 'not an array' } },
      ],
    });
    expect(context.scheduledFrequency['rectus-abdominis']).toBe(0);
  });
});

describe('regeneration preserves program state', () => {
  it('building the coaching foundation context for two different weeks of the same program never resets blockId', () => {
    const week1 = buildCoachingFoundationContext(db, {
      programId,
      referenceDate: FUTURE_MONDAY,
      weekBoundary: 'monday',
      weekStart: FUTURE_MONDAY,
      targetIds: ['rectus-abdominis'],
      persistedWeekSessions: [],
    });
    const nextMonday = '2026-12-21';
    const week2 = buildCoachingFoundationContext(db, {
      programId,
      referenceDate: nextMonday,
      weekBoundary: 'monday',
      weekStart: nextMonday,
      targetIds: ['rectus-abdominis'],
      persistedWeekSessions: [],
    });
    expect(week2.programState.blockId).toBe(week1.programState.blockId);
    expect(week2.programState.weekIndex).toBe(week1.programState.weekIndex + 1);
  });
});

describe('AI receives read-only foundation data', () => {
  it('buildProgrammerContext includes a real coachingFoundation field scoped to its own targets', () => {
    const context = buildProgrammerContext(db, { targetDate: FUTURE_MONDAY });
    expect(context.coachingFoundation).toBeDefined();
    expect(context.coachingFoundation.programState.blockKind).toBe('base');
    const contextTargetIds = context.targets.map((t) => t.targetId);
    for (const targetId of contextTargetIds) {
      expect(context.coachingFoundation.targetProfiles[targetId]).toBeDefined();
      expect(context.coachingFoundation.historicalSummaries[targetId]).toBeDefined();
    }
    // Read-only informational data — the type itself has no mutation
    // method, and this is plain JSON handed to the provider, never an
    // object the AI's response is merged back into.
    expect(() => JSON.stringify(context.coachingFoundation)).not.toThrow();
  });

  it('buildReconciliationContext includes the identical coachingFoundation shape', () => {
    const context = buildReconciliationContext(db, { targetDate: FUTURE_MONDAY, requestedActivity: 'gym' });
    expect(context.coachingFoundation).toBeDefined();
    expect(context.coachingFoundation.programState.blockKind).toBe('base');
    const contextTargetIds = context.targets.map((t) => t.targetId);
    for (const targetId of contextTargetIds) {
      expect(context.coachingFoundation.targetProfiles[targetId]).toBeDefined();
    }
  });

  it('both generate_session and reconcile_week contexts for the SAME week share the same stable program block', () => {
    const generateContext = buildProgrammerContext(db, { targetDate: FUTURE_MONDAY });
    const reconcileContext = buildReconciliationContext(db, { targetDate: FUTURE_MONDAY, requestedActivity: 'gym' });
    expect(reconcileContext.coachingFoundation.programState.blockId).toBe(generateContext.coachingFoundation.programState.blockId);
  });
});
