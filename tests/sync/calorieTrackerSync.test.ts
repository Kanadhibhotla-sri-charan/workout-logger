// Manual duration + Calorie Tracker sync (2026-10-21). The user types the
// session duration in whole minutes (required to finish, editable later,
// never prefilled); durations from the old page-load clock are 'legacy'.
// Finished sessions are copied into data/workout_sessions.json in the
// Calorie Tracker repo through the GitHub Contents API.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/client.js';
import { createApp } from '../../src/server/app.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { WorkoutSessionsRepo } from '../../src/repositories/workoutSessionsRepo.js';
import { BadmintonSessionDetailsRepo } from '../../src/repositories/badmintonSessionDetailsRepo.js';
import {
  CalorieSyncRunner,
  SYNC_COMMIT_MESSAGE,
  buildWorkoutSessionsFile,
  calorieSyncConfigFromEnv,
  isoWithOffset,
  pushWorkoutSessionsFile,
  startCalorieSync,
  stopCalorieSync,
  type CalorieSyncConfig,
  type WorkoutSessionsFile,
} from '../../src/services/calorieTrackerSync.js';

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 2026-10-21 19:05 IST
  vi.setSystemTime(new Date('2026-10-21T13:35:00Z'));
  db = openDb(':memory:');
  const user = new UsersRepo(db).getOrCreateDefault();
  new TrainingProfileRepo(db).upsert(user.id, {
    timezone: 'Asia/Kolkata',
    week_start_day: 'monday',
    training_days: ['monday', 'tuesday', 'thursday', 'friday'] as any,
    default_session_duration_minutes: 60,
    minimum_session_duration_minutes: 30,
    maximum_session_duration_minutes: 90,
    available_equipment: ['cable', 'dumbbell'],
    other_activity_schedule: [],
  });
});

afterEach(() => {
  stopCalorieSync();
  vi.useRealTimers();
});

const sessions = () => new WorkoutSessionsRepo(db);

describe('manual duration', () => {
  it('finishing needs a duration; a typed one is stored as user_entered', async () => {
    const s = sessions().createSession({ date: '2026-10-21', session_type: 'gym', status: 'in_progress' });
    const app = createApp(db);
    const refused = await request(app).patch(`/api/workouts/${s.session_id}`).send({ status: 'completed' }).expect(400);
    expect(refused.body.code).toBe('DURATION_REQUIRED');
    expect(sessions().getSession(s.session_id)!.status).toBe('in_progress');

    const done = (await request(app).patch(`/api/workouts/${s.session_id}`).send({ status: 'completed', duration_minutes: 65, duration_source: 'user_entered' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'completed', duration_minutes: 65, duration_source: 'user_entered' });
  });

  it('rejects durations that are not whole minutes from 1 to 360, and unknown sources', async () => {
    const s = sessions().createSession({ date: '2026-10-21', session_type: 'gym', status: 'in_progress' });
    const app = createApp(db);
    for (const bad of [0, 361, 64.5, '65', -5]) {
      await request(app).patch(`/api/workouts/${s.session_id}`).send({ status: 'completed', duration_minutes: bad, duration_source: 'user_entered' }).expect(400);
    }
    await request(app).patch(`/api/workouts/${s.session_id}`).send({ status: 'completed', duration_minutes: 60, duration_source: 'measured' }).expect(400);
    await request(app).patch(`/api/workouts/${s.session_id}`).send({ status: 'completed', duration_minutes: 360, duration_source: 'user_entered' }).expect(200);
  });

  it('a duration sent without the user_entered marker (an old cached logger page) is legacy', async () => {
    const s = sessions().createSession({ date: '2026-10-21', session_type: 'gym', status: 'in_progress' });
    const done = (await request(createApp(db)).patch(`/api/workouts/${s.session_id}`).send({ status: 'completed', duration_minutes: 3 }).expect(200)).body;
    expect(done.duration_source).toBe('legacy');
  });

  it('a completed session can be corrected (becomes user_entered) but not cleared', async () => {
    const s = sessions().createSession({ date: '2026-10-20', session_type: 'badminton', status: 'in_progress' });
    const app = createApp(db);
    await request(app).patch(`/api/workouts/${s.session_id}`).send({ status: 'completed', duration_minutes: 2 }).expect(200);
    const fixed = (await request(app).patch(`/api/workouts/${s.session_id}`).send({ duration_minutes: 120, duration_source: 'user_entered' }).expect(200)).body;
    expect(fixed).toMatchObject({ duration_minutes: 120, duration_source: 'user_entered' });
    await request(app).patch(`/api/workouts/${s.session_id}`).send({ duration_minutes: null }).expect(400);
    // An unrelated edit keeps the duration and its source.
    const noted = (await request(app).patch(`/api/workouts/${s.session_id}`).send({ notes: 'evening club' }).expect(200)).body;
    expect(noted).toMatchObject({ duration_minutes: 120, duration_source: 'user_entered' });
  });

  it('badminton details stay editable after the session is completed', async () => {
    const s = sessions().createSession({ date: '2026-10-20', session_type: 'badminton', status: 'completed', duration_minutes: 90, duration_source: 'user_entered' });
    const saved = (await request(createApp(db)).put(`/api/workouts/${s.session_id}/badminton-details`).send({ intensity: 'high', format: 'singles', games_count: 4 }).expect(200)).body;
    expect(saved).toMatchObject({ intensity: 'high', format: 'singles', games_count: 4 });
  });

  it('on start-up, durations recorded before this change are marked legacy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wl-dur-'));
    try {
      const file = join(dir, 'db.sqlite');
      let fileDb = openDb(file);
      const s = new WorkoutSessionsRepo(fileDb).createSession({ date: '2026-10-16', session_type: 'gym', status: 'completed', duration_minutes: 187 });
      const blank = new WorkoutSessionsRepo(fileDb).createSession({ date: '2026-10-17', session_type: 'gym', status: 'planned' });
      fileDb.prepare('UPDATE workout_sessions SET duration_source = NULL').run(); // as before the column existed
      fileDb.close();
      fileDb = openDb(file);
      expect(new WorkoutSessionsRepo(fileDb).getSession(s.session_id)!.duration_source).toBe('legacy');
      expect(new WorkoutSessionsRepo(fileDb).getSession(blank.session_id)!.duration_source).toBeNull();
      fileDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the logger asks for minutes, never prefills them, and no longer times from page load', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync('public/logger.html', 'utf8');
    expect(html).toContain("'Duration (minutes)'");
    expect(html).toContain("duration_source: 'user_entered'");
    expect(html).not.toContain('startedAt');
    expect(html).not.toMatch(/duration-input'[^)]*value:/);
  });
});

describe('workout_sessions.json content', () => {
  it('covers the last 14 IST dates, newest first, with [] for empty days and completed sessions only', () => {
    const repo = sessions();
    const gym = repo.createSession({ date: '2026-10-21', session_type: 'gym', status: 'completed', duration_minutes: 64, duration_source: 'user_entered' });
    const bad = repo.createSession({ date: '2026-10-21', session_type: 'badminton', status: 'completed', duration_minutes: 120, duration_source: 'user_entered' });
    new BadmintonSessionDetailsRepo(db).record({ workout_session_id: bad.session_id, intensity: 'medium', format: 'doubles', games_count: 6, notes: 'private' });
    repo.createSession({ date: '2026-10-20', session_type: 'gym', status: 'in_progress' });
    repo.createSession({ date: '2026-10-19', session_type: 'gym', status: 'skipped' });
    const old = repo.createSession({ date: '2026-10-08', session_type: 'gym', status: 'completed', duration_minutes: 61 });
    repo.createSession({ date: '2026-10-07', session_type: 'gym', status: 'completed', duration_minutes: 70, duration_source: 'user_entered' });

    const file = buildWorkoutSessionsFile(db);
    expect(file.schema_version).toBe(1);
    expect(file.generated_at).toBe('2026-10-21T19:05:00+05:30');
    expect(Object.keys(file.days)).toHaveLength(14);
    expect(Object.keys(file.days)[0]).toBe('2026-10-21');
    expect(Object.keys(file.days)[13]).toBe('2026-10-08');
    expect(file.days['2026-10-07']).toBeUndefined();
    expect(file.days['2026-10-21']).toEqual([
      { session_id: gym.session_id, session_type: 'gym', duration_minutes: 64, duration_source: 'user_entered', badminton: null },
      { session_id: bad.session_id, session_type: 'badminton', duration_minutes: 120, duration_source: 'user_entered', badminton: { intensity: 'medium', format: 'doubles', games_count: 6 } },
    ]);
    expect(file.days['2026-10-20']).toEqual([]);
    expect(file.days['2026-10-19']).toEqual([]);
    expect(file.days['2026-10-08']).toEqual([{ session_id: old.session_id, session_type: 'gym', duration_minutes: 61, duration_source: 'legacy', badminton: null }]);
    expect(JSON.stringify(file)).not.toContain('private');
  });

  it('dates follow IST, not UTC', () => {
    vi.setSystemTime(new Date('2026-10-21T20:00:00Z')); // 01:30 IST on the 22nd
    expect(Object.keys(buildWorkoutSessionsFile(db).days)[0]).toBe('2026-10-22');
    expect(isoWithOffset(new Date('2026-10-21T20:00:00Z'), 'UTC')).toBe('2026-10-21T20:00:00+00:00');
  });
});

const CONFIG: CalorieSyncConfig = { token: 'tok_secret', repo: 'owner/repo', branch: 'live', path: 'data/workout_sessions.json' };
const sample = (days: WorkoutSessionsFile['days'], at = '2026-10-21T19:05:00+05:30'): WorkoutSessionsFile => ({ schema_version: 1, generated_at: at, days });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const encoded = (file: WorkoutSessionsFile) => Buffer.from(JSON.stringify(file, null, 2)).toString('base64');

describe('GitHub write', () => {
  it('creates the file when missing, on the configured branch, with the fixed message and the token as a header', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = vi.fn(async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return init?.method === 'PUT' ? json(201, { commit: { sha: 'abc1234def' } }) : json(404, { message: 'Not Found' });
    });
    const out = await pushWorkoutSessionsFile(sample({ '2026-10-21': [] }), CONFIG, fake as any);
    expect(out).toEqual({ status: 'committed', commitSha: 'abc1234def' });
    expect(calls[0].url).toBe('https://api.github.com/repos/owner/repo/contents/data/workout_sessions.json?ref=live');
    const put = JSON.parse(String(calls[1].init!.body));
    expect(put).toMatchObject({ message: SYNC_COMMIT_MESSAGE, branch: 'live' });
    expect(put.sha).toBeUndefined();
    expect(JSON.parse(Buffer.from(put.content, 'base64').toString())).toEqual(sample({ '2026-10-21': [] }));
    expect((calls[1].init!.headers as Record<string, string>).Authorization).toBe('Bearer tok_secret');
  });

  it('does not commit when only generated_at would change', async () => {
    const fake = vi.fn(async () => json(200, { sha: 's1', content: encoded(sample({ '2026-10-21': [] }, '2026-10-21T18:50:00+05:30')) }));
    expect(await pushWorkoutSessionsFile(sample({ '2026-10-21': [] }), CONFIG, fake as any)).toEqual({ status: 'unchanged' });
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('on 409/422 re-fetches the sha and retries', async () => {
    const shas: Array<string | undefined> = [];
    let gets = 0;
    let puts = 0;
    const fake = vi.fn(async (_url: any, init?: RequestInit) => {
      if (init?.method !== 'PUT') return json(200, { sha: `sha${++gets}`, content: encoded(sample({ '2026-10-21': [] })) });
      shas.push(JSON.parse(String(init.body)).sha);
      return ++puts === 1 ? json(409, {}) : puts === 2 ? json(422, {}) : json(200, { commit: { sha: 'c3' } });
    });
    const out = await pushWorkoutSessionsFile(sample({ '2026-10-21': [{ session_id: 'x', session_type: 'gym', duration_minutes: 60, duration_source: 'user_entered', badminton: null }] }), CONFIG, fake as any);
    expect(out.status).toBe('committed');
    expect(shas).toEqual(['sha1', 'sha2', 'sha3']);
  });

  it('gives up after repeated conflicts and on other errors, without leaking the token', async () => {
    const conflict = vi.fn(async (_u: any, init?: RequestInit) => (init?.method === 'PUT' ? json(409, {}) : json(404, {})));
    await expect(pushWorkoutSessionsFile(sample({}), CONFIG, conflict as any)).rejects.toThrow(/HTTP 409/);
    expect(conflict).toHaveBeenCalledTimes(10);
    const unauthorized = vi.fn(async () => json(401, { message: 'Bad credentials' }));
    const err = await pushWorkoutSessionsFile(sample({}), CONFIG, unauthorized as any).catch((e) => e as Error);
    expect(err.message).toMatch(/HTTP 401/);
    expect(err.message).not.toContain('tok_secret');
  });
});

describe('when the sync runs', () => {
  it('is off without a token; repo, branch and path have defaults', () => {
    expect(calorieSyncConfigFromEnv({})).toBeNull();
    expect(calorieSyncConfigFromEnv({ CALORIE_SYNC_TOKEN: ' t ' })).toEqual({
      token: 't',
      repo: 'Kanadhibhotla-sri-charan/food_and_workout_tracker',
      branch: 'claude/new-session-7bo2dm',
      path: 'data/workout_sessions.json',
    });
    expect(calorieSyncConfigFromEnv({ CALORIE_SYNC_TOKEN: 't', CALORIE_SYNC_BRANCH: 'main' })!.branch).toBe('main');
  });

  it('a request during a running sync queues exactly one more run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gets = 0;
    const fake = vi.fn(async (_u: any, init?: RequestInit) => {
      if (init?.method === 'PUT') return json(201, { commit: { sha: 'c' } });
      gets += 1;
      if (gets === 1) await gate;
      return json(404, {});
    });
    const lines: string[] = [];
    const runner = new CalorieSyncRunner(db, CONFIG, fake as any, (l) => lines.push(l));
    const first = runner.request('workout finished');
    void runner.request('duration edited');
    void runner.request('badminton details edited');
    release();
    await first;
    expect(gets).toBe(2);
    expect(lines).toEqual(['[calorie-sync] workout finished: committed c', '[calorie-sync] queued: committed c']);
  });

  it('runs at start-up, after Finish workout, after a duration edit and after a badminton edit on a completed session', async () => {
    const reasons: string[] = [];
    const fake = vi.fn(async (_u: any, init?: RequestInit) => (init?.method === 'PUT' ? json(201, { commit: { sha: 'c' } }) : json(404, {})));
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void reasons.push(line));
    try {
      const runner = startCalorieSync(db, CONFIG, fake as any)!;
      await vi.waitFor(() => expect(reasons).toContain('[calorie-sync] startup: committed c'));
      const app = createApp(db);
      const s = sessions().createSession({ date: '2026-10-21', session_type: 'badminton', status: 'in_progress' });
      await request(app).put(`/api/workouts/${s.session_id}/badminton-details`).send({ intensity: 'low' }).expect(200);
      await request(app).patch(`/api/workouts/${s.session_id}`).send({ status: 'completed', duration_minutes: 90, duration_source: 'user_entered' }).expect(200);
      await vi.waitFor(() => expect(reasons.some((r) => r.startsWith('[calorie-sync] workout finished'))).toBe(true));
      await request(app).patch(`/api/workouts/${s.session_id}`).send({ duration_minutes: 100, duration_source: 'user_entered' }).expect(200);
      await vi.waitFor(() => expect(reasons.some((r) => r.startsWith('[calorie-sync] duration edited') || r === '[calorie-sync] queued: committed c')).toBe(true));
      await request(app).put(`/api/workouts/${s.session_id}/badminton-details`).send({ intensity: 'high' }).expect(200);
      await vi.waitFor(() => expect(reasons.some((r) => r.startsWith('[calorie-sync] badminton details edited') || r.startsWith('[calorie-sync] queued'))).toBe(true));
      // The in-progress badminton edit (before finishing) did not trigger a sync.
      expect(reasons.filter((r) => r.startsWith('[calorie-sync] badminton details edited')).length).toBeLessThanOrEqual(1);
      runner.stop();
    } finally {
      log.mockRestore();
    }
  });
});
