import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/client.js';
import { ProgramsRepo } from '../src/repositories/programsRepo.js';
import { BlueprintAdapter } from '../src/blueprint/adapter.js';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('ProgramsRepo — Blueprint version reproducibility', () => {
  it('records the current Blueprint snapshot commit on a newly created program', () => {
    const repo = new ProgramsRepo(db);
    const program = repo.createProgram({ name: 'Push Pull Legs', goal_ids: [] });

    expect(program.blueprint_commit).toBe(BlueprintAdapter.getManifest().sourceCommit);
    expect(program.blueprint_commit).not.toBe('');
  });

  it('persists blueprint_commit and returns it unchanged on reload', () => {
    const repo = new ProgramsRepo(db);
    const created = repo.createProgram({ name: 'Upper Lower', goal_ids: [] });

    const loaded = repo.getProgram(created.id);

    expect(loaded?.blueprint_commit).toBe(created.blueprint_commit);
  });

  it('keeps blueprint_commit stable across a list read', () => {
    const repo = new ProgramsRepo(db);
    const created = repo.createProgram({ name: 'Full Body', goal_ids: [] });

    const [listed] = repo.listPrograms();

    expect(listed?.blueprint_commit).toBe(created.blueprint_commit);
  });
});
