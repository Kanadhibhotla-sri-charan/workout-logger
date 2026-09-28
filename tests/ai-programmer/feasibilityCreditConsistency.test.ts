// Feasibility/Credit Consistency Fix (2026-09-28): feasibility must only
// recommend an authored exercise for a target when that exercise actually
// earns credit for the target under the shared-credit rule adequacy
// validation checks. Built from a REAL programmer context (real Blueprint
// data, real context builder, in-memory database) so these assertions
// cover exactly what production computes — not hand-made fixtures.

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { GoalsRepo } from '../../src/repositories/goalsRepo.js';
import { buildProgrammerContext } from '../../src/ai-programmer/context/programmerContextBuilder.js';
import type { AIProgrammerContext } from '../../src/ai-programmer/context/programmerContextTypes.js';
import { creditedTargetKeys, keyOf } from '../../src/ai-programmer/validation/sharedCredit.js';
import { validateProposalSchema } from '../../src/ai-programmer/validation/programmerOutputValidator.js';

const PURPOSES = ['push', 'pull', 'legs', 'upper'] as const;

function futureDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 61);
  return d.toISOString().slice(0, 10);
}

let db: Database.Database;
const contexts = new Map<(typeof PURPOSES)[number], AIProgrammerContext>();

beforeAll(() => {
  db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'],
    other_activity_schedule: [],
  });
  // The real production goal behind brachialis — makes it goal-oriented
  // (complete-level package), exactly as in the reported Pull failure.
  new GoalsRepo(db).create({ goal_type: 'aesthetic', blueprint_ref: 'arm-side-thickness', priority: 1 });

  const targetDate = futureDate();
  for (const purpose of PURPOSES) contexts.set(purpose, buildProgrammerContext(db, { targetDate, requestedSessionPurpose: purpose }));
});

function guidanceFor(context: AIProgrammerContext, targetId: string) {
  const g = context.programmingBrief.muscles.find((m) => m.targetType === 'physique_target' && m.targetId === targetId);
  expect(g, `${targetId} guidance present`).toBeDefined();
  expect(g!.feasibility, `${targetId} feasibility present`).toBeDefined();
  return g!;
}

function recommendedExercises(context: AIProgrammerContext, targetId: string): string[] {
  return guidanceFor(context, targetId).feasibility!.feasibleCombinations.flat();
}

describe('feasibility/credit consistency — real Blueprint data', () => {
  it('A. brachialis never recommends barbell-ez-bar-curl (Blueprint credits it to biceps only)', () => {
    for (const purpose of PURPOSES) {
      expect(recommendedExercises(contexts.get(purpose)!, 'brachialis-arm-thickness')).not.toContain('barbell-ez-bar-curl');
    }
  });

  it('A. gastrocnemius never recommends seated-calf-raise (Blueprint credits it to soleus only)', () => {
    for (const purpose of PURPOSES) {
      expect(recommendedExercises(contexts.get(purpose)!, 'gastrocnemius')).not.toContain('seated-calf-raise');
    }
  });

  it('A. soleus never recommends standing-calf-raise (Blueprint credits it to gastrocnemius only)', () => {
    for (const purpose of PURPOSES) {
      expect(recommendedExercises(contexts.get(purpose)!, 'soleus')).not.toContain('standing-calf-raise');
    }
  });

  it('B. global invariant: every exercise in every recommended combination earns credit for that target', () => {
    let checked = 0;
    for (const purpose of PURPOSES) {
      const context = contexts.get(purpose)!;
      for (const g of context.programmingBrief.muscles) {
        for (const combination of g.feasibility?.feasibleCombinations ?? []) {
          for (const exerciseId of combination) {
            const credited = creditedTargetKeys({ exerciseId, targetType: g.targetType, targetId: g.targetId }, context.targets);
            expect(credited, `${purpose}: ${exerciseId} recommended for ${g.targetId}`).toContain(keyOf(g.targetType, g.targetId));
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0); // never vacuously true
  });

  it('C. the affected targets remain feasible through genuinely crediting candidates', () => {
    for (const purpose of PURPOSES) {
      const context = contexts.get(purpose)!;
      const brachialis = guidanceFor(context, 'brachialis-arm-thickness').feasibility!;
      expect(brachialis.isFeasible).toBe(true);
      for (const id of brachialis.feasibleCombinations.flat()) expect(['hammer-curl', 'cross-body-hammer-curl']).toContain(id);

      expect(guidanceFor(context, 'gastrocnemius').feasibility!.isFeasible).toBe(true);
      expect(guidanceFor(context, 'soleus').feasibility!.isFeasible).toBe(true);
    }
  });
});

describe('E. Pull regression — duplicate exerciseId schema rejection is unchanged (validation not weakened)', () => {
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pull-2026-09-29');

  for (const name of ['rejected-duplicate-1.json', 'rejected-duplicate-2.json', 'rejected-duplicate-3.json']) {
    it(`${name}: real rejected AI output is still rejected with exactly the duplicate-exerciseId error`, () => {
      const raw = JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
      const result = validateProposalSchema(raw);
      expect(result.ok).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.errors).toEqual(['exercises: duplicate exerciseId "barbell-ez-bar-curl"']);
    });
  }
});
