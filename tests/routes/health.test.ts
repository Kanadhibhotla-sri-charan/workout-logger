// Production Deployment Phase §5: the health endpoint exists solely for
// deployment verification / uptime checks. Must return HTTP 200 with
// exactly {"status":"ok"} — never database contents, user data, env
// vars, filesystem paths, secrets, or stack traces.

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});

describe('GET /api/health', () => {
  it('returns HTTP 200 with exactly {"status":"ok"}', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('never leaks sensitive information (db paths, env vars, stack traces)', async () => {
    const res = await request(app).get('/api/health').expect(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/sqlite|\.db|process\.env|DB_PATH|Error|stack/i);
  });
});
