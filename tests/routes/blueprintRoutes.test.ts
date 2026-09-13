// AI Programmer Proposal Review UI: the client needs to resolve an AI
// proposal's raw physique_target id to its real Blueprint display name
// (the same lookup src/server/routes/programming.ts's resolveTargetName
// already does server-side) — GET /api/blueprint/targets exposes that,
// mirroring the existing /api/blueprint/exercises route exactly.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { BlueprintAdapter } from '../../src/blueprint/adapter.js';

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

describe('GET /api/blueprint/targets', () => {
  it('returns every real Blueprint physique target with its real name', async () => {
    const res = await request(app).get('/api/blueprint/targets').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(BlueprintAdapter.getTargets().length);

    const midPec = BlueprintAdapter.getTarget('mid-pec');
    expect(midPec).toBeDefined();
    const entry = res.body.find((t: { id: string }) => t.id === 'mid-pec');
    expect(entry).toBeDefined();
    expect(entry.name).toBe(midPec!.name);
  });

  it('exposes only id/name/parent_region — no internal Blueprint fields beyond what the client needs', async () => {
    const res = await request(app).get('/api/blueprint/targets').expect(200);
    const entry = res.body[0];
    expect(Object.keys(entry).sort()).toEqual(['id', 'name', 'parent_region']);
  });

  it('never leaks internal errors or file paths', async () => {
    const res = await request(app).get('/api/blueprint/targets').expect(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/\.json|\/home\/|process\.env|stack/i);
  });
});
