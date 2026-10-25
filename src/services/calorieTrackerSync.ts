// Calorie Tracker sync (2026-10-21, owner request): copies finished
// sessions into one JSON file in the Calorie Tracker repo
// (food_and_workout_tracker, data/workout_sessions.json) through the GitHub
// Contents API. Calorie Tracker only reads that file; it never contacts
// workout-logger. The file carries completed sessions only — type,
// duration, where the duration came from, and badminton intensity /
// format / games — never exercises, sets, notes, goals or AI data.
//
// Window: the last SYNC_WINDOW_DAYS dates in the user's timezone (IST),
// today included, every date present (`[]` = nothing completed that day),
// so "no workout" is distinguishable from "not synced yet".
//
// Writes: GET the file (for its sha), compare `days` with what is there
// and commit only when it changed (generated_at alone never commits); PUT
// with the sha, and on 409/422 (the Calorie Tracker app commits food logs
// to the same repo through the same API) re-fetch and retry.
//
// Runs after "Finish workout", after an edit to a completed session's
// duration or badminton details, and every 15 minutes as a safety net —
// all through one serialized runner, so two syncs never race each other.
// Disabled (no-op) unless CALORIE_SYNC_TOKEN is set.

import type Database from 'better-sqlite3';
import { addDays } from '../engine/dateMath.js';
import { resolveUserTimezone } from '../lib/userTimezone.js';
import { todayInTimezone } from '../lib/timezone.js';
import type { DurationSource } from '../contracts/types.js';

export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_WINDOW_DAYS = 14;
export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const SYNC_COMMIT_MESSAGE = 'Sync workout sessions';
const MAX_WRITE_ATTEMPTS = 5;

export interface SyncedSession {
  session_id: string;
  session_type: string;
  duration_minutes: number | null;
  duration_source: DurationSource | null;
  badminton: { intensity: 'low' | 'medium' | 'high' | null; format: 'singles' | 'doubles' | null; games_count: number | null } | null;
}

export interface WorkoutSessionsFile {
  schema_version: number;
  generated_at: string;
  days: Record<string, SyncedSession[]>;
}

export interface CalorieSyncConfig {
  token: string;
  repo: string;
  branch: string;
  path: string;
}

/** Sync settings from the environment, or null when sync is off. */
export function calorieSyncConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CalorieSyncConfig | null {
  const token = env.CALORIE_SYNC_TOKEN?.trim();
  if (!token) return null;
  return {
    token,
    repo: env.CALORIE_SYNC_REPO?.trim() || 'Kanadhibhotla-sri-charan/food_and_workout_tracker',
    branch: env.CALORIE_SYNC_BRANCH?.trim() || 'claude/new-session-7bo2dm',
    path: env.CALORIE_SYNC_PATH?.trim() || 'data/workout_sessions.json',
  };
}

/** `now` as an ISO timestamp with the timezone's own offset, e.g.
 * 2026-10-21T19:05:00+05:30. */
export function isoWithOffset(now: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : String(parts.timeZoneName).replace('GMT', '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

interface SessionRow {
  session_id: string;
  date: string;
  session_type: string;
  duration_minutes: number | null;
  duration_source: DurationSource | null;
  intensity: 'low' | 'medium' | 'high' | null;
  format: 'singles' | 'doubles' | null;
  games_count: number | null;
}

/** The file's content as of `now`: completed sessions for each of the
 * last SYNC_WINDOW_DAYS dates, newest date first. */
export function buildWorkoutSessionsFile(db: Database.Database, now: Date = new Date()): WorkoutSessionsFile {
  const timezone = resolveUserTimezone(db);
  const today = todayInTimezone(timezone, now);
  const first = addDays(today, -(SYNC_WINDOW_DAYS - 1));
  const rows = db
    .prepare(
      `SELECT w.session_id, w.date, w.session_type, w.duration_minutes, w.duration_source,
              d.intensity, d.format, d.games_count
         FROM workout_sessions w
         LEFT JOIN badminton_session_details d ON d.workout_session_id = w.session_id
        WHERE w.status = 'completed' AND w.date >= ? AND w.date <= ?
        ORDER BY w.date, w.created_at, w.rowid`
    )
    .all(first, today) as SessionRow[];

  const days: Record<string, SyncedSession[]> = {};
  for (let i = 0; i < SYNC_WINDOW_DAYS; i++) days[addDays(today, -i)] = [];
  for (const r of rows) {
    days[r.date]?.push({
      session_id: r.session_id,
      session_type: r.session_type,
      duration_minutes: r.duration_minutes,
      duration_source: r.duration_minutes === null ? null : (r.duration_source ?? 'legacy'),
      badminton:
        r.session_type === 'badminton' ? { intensity: r.intensity ?? null, format: r.format ?? null, games_count: r.games_count ?? null } : null,
    });
  }
  return { schema_version: SYNC_SCHEMA_VERSION, generated_at: isoWithOffset(now, timezone), days };
}

export type SyncOutcome = { status: 'committed'; commitSha: string | null } | { status: 'unchanged' };

class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

type FetchLike = typeof fetch;

/** Writes `file` to the repo unless its `days` already match what is
 * there. Never logs or returns the token. */
export async function pushWorkoutSessionsFile(file: WorkoutSessionsFile, config: CalorieSyncConfig, fetchImpl: FetchLike = fetch): Promise<SyncOutcome> {
  const url = `https://api.github.com/repos/${config.repo}/contents/${config.path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = {
    Authorization: `Bearer ${config.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'workout-logger-calorie-sync',
  };
  const body = `${JSON.stringify(file, null, 2)}\n`;

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const current = await fetchImpl(`${url}?ref=${encodeURIComponent(config.branch)}`, { headers });
    let sha: string | undefined;
    if (current.status === 200) {
      const json = (await current.json()) as { sha: string; content?: string };
      sha = json.sha;
      if (json.content && sameContent(Buffer.from(json.content, 'base64').toString('utf8'), file)) return { status: 'unchanged' };
    } else if (current.status !== 404) {
      throw new GitHubError(current.status, `GitHub GET ${config.path} failed: HTTP ${current.status}`);
    }

    const put = await fetchImpl(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: SYNC_COMMIT_MESSAGE,
        content: Buffer.from(body, 'utf8').toString('base64'),
        branch: config.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (put.status === 200 || put.status === 201) {
      const json = (await put.json()) as { commit?: { sha?: string } };
      return { status: 'committed', commitSha: json.commit?.sha ?? null };
    }
    // 409/422: the file changed between our GET and PUT (another commit
    // to the repo, e.g. a food log) — re-fetch the sha and try again.
    if ((put.status === 409 || put.status === 422) && attempt < MAX_WRITE_ATTEMPTS) continue;
    throw new GitHubError(put.status, `GitHub PUT ${config.path} failed: HTTP ${put.status}`);
  }
  throw new GitHubError(0, 'unreachable');
}

function sameContent(existingText: string, file: WorkoutSessionsFile): boolean {
  try {
    const existing = JSON.parse(existingText) as Partial<WorkoutSessionsFile>;
    return existing.schema_version === file.schema_version && JSON.stringify(existing.days) === JSON.stringify(file.days);
  } catch {
    return false;
  }
}

/** One serialized runner: a request while a sync is running queues exactly
 * one more run, so the latest data always gets written and two syncs never
 * race. Errors are logged, never thrown into the caller (a failed sync
 * must not fail "Finish workout"); the 15-minute run retries. */
export class CalorieSyncRunner {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database.Database,
    private config: CalorieSyncConfig,
    private fetchImpl: FetchLike = fetch,
    private log: (line: string) => void = (line) => console.log(line)
  ) {}

  request(reason: string): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let why = reason;
      do {
        this.again = false;
        try {
          const outcome = await pushWorkoutSessionsFile(buildWorkoutSessionsFile(this.db), this.config, this.fetchImpl);
          this.log(`[calorie-sync] ${why}: ${outcome.status}${outcome.status === 'committed' && outcome.commitSha ? ` ${outcome.commitSha.slice(0, 7)}` : ''}`);
        } catch (err) {
          this.log(`[calorie-sync] ${why}: failed (${err instanceof Error ? err.message : String(err)})`);
        }
        why = 'queued';
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start(intervalMs: number = SYNC_INTERVAL_MS): void {
    void this.request('startup');
    this.timer = setInterval(() => void this.request('every 15 min'), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

let runner: CalorieSyncRunner | null = null;

/** Turns the sync on for this process (server start only, never in tests). */
export function startCalorieSync(
  db: Database.Database,
  config: CalorieSyncConfig | null = calorieSyncConfigFromEnv(),
  fetchImpl: FetchLike = fetch
): CalorieSyncRunner | null {
  stopCalorieSync();
  if (!config) return null;
  runner = new CalorieSyncRunner(db, config, fetchImpl);
  runner.start();
  return runner;
}

export function stopCalorieSync(): void {
  runner?.stop();
  runner = null;
}

/** Ask for a sync now (after a session is finished or a completed session's
 * duration / badminton details change). No-op when sync is off. */
export function requestCalorieSync(reason: string): void {
  if (runner) void runner.request(reason);
}
