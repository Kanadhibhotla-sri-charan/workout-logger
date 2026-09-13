// Token Measurement iteration §8 "CLI" tests: exercises
// runTokenReportCli() directly (no subprocess spawn) with an injected
// in-memory database and captured stdout/stderr, per this repo's fast
// in-process testing convention.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db/client.js';
import { TrainingProfileRepo } from '../../src/repositories/trainingProfileRepo.js';
import { UsersRepo } from '../../src/repositories/usersRepo.js';
import { runTokenReportCli, parseArgs, loadPricingFile, CliUsageError } from '../../src/ai-programmer/cli/tokenReportCli.js';

const FULL_EQUIPMENT = ['barbell', 'bench', 'rack', 'cable', 'machine', 'dumbbell', 'ez-bar', 'pull-up bar', 'smith machine', 'block or plate'];
const SUNDAY = '2026-09-13';

let db: Database.Database;
let fetchMock: ReturnType<typeof vi.fn>;

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      write: (text: string) => stdout.push(text),
      writeErr: (text: string) => stderr.push(text),
      db,
    },
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

  fetchMock = vi.fn(() => {
    throw new Error('fetch must never be called by the token-report CLI');
  });
  vi.stubGlobal('fetch', fetchMock);

  process.env.VELONA_API_KEY = 'test-key-not-real';
  process.env.VELONA_MODEL = 'test-model';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VELONA_API_KEY;
  delete process.env.VELONA_MODEL;
});

describe('parseArgs', () => {
  it('parses all documented flags', () => {
    const args = parseArgs(['--mode', 'reconcile_week', '--target-date', SUNDAY, '--reason', 'x', '--swap-unavailable-reason', 'y', '--pricing-file', 'p.json', '--json']);
    expect(args).toEqual({ mode: 'reconcile_week', targetDate: SUNDAY, reason: 'x', swapUnavailableReason: 'y', pricingFile: 'p.json', json: true, help: false });
  });

  it('throws CliUsageError for an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(CliUsageError);
  });

  it('throws CliUsageError when a flag is missing its value', () => {
    expect(() => parseArgs(['--mode'])).toThrow(CliUsageError);
  });
});

describe('runTokenReportCli — both modes accepted, never call fetch', () => {
  it('generate_session: exits 0 and prints a JSON report', async () => {
    const { io, stdout, stderr } = captureIo();
    const code = await runTokenReportCli(['--mode', 'generate_session', '--target-date', SUNDAY, '--json'], io);
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.mode).toBe('generate_session');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reconcile_week: exits 0 and prints a JSON report', async () => {
    const { io, stdout } = captureIo();
    const code = await runTokenReportCli(['--mode', 'reconcile_week', '--target-date', SUNDAY, '--reason', 'gym slot moved', '--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.mode).toBe('reconcile_week');
    expect(parsed.weekStart).toBe('2026-09-07');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('runTokenReportCli — validation', () => {
  it('rejects an invalid mode with a clear stderr message and exit code 1', async () => {
    const { io, stdout, stderr } = captureIo();
    const code = await runTokenReportCli(['--mode', 'not_a_real_mode', '--target-date', SUNDAY], io);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toMatch(/--mode is required and must be one of/);
  });

  it('rejects a missing mode', async () => {
    const { io, stderr } = captureIo();
    const code = await runTokenReportCli(['--target-date', SUNDAY], io);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/--mode is required/);
  });

  it('rejects an invalid calendar date with a clear stderr message and exit code 1', async () => {
    const { io, stdout, stderr } = captureIo();
    const code = await runTokenReportCli(['--mode', 'generate_session', '--target-date', '2026-13-40'], io);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toMatch(/--target-date is required and must be a real calendar date/);
  });

  it('rejects a missing target date', async () => {
    const { io, stderr } = captureIo();
    const code = await runTokenReportCli(['--mode', 'generate_session'], io);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/--target-date is required/);
  });
});

describe('runTokenReportCli — JSON output validity and stdout/stderr separation', () => {
  it('--json prints ONLY valid JSON on stdout, nothing else mixed in', async () => {
    const { io, stdout } = captureIo();
    await runTokenReportCli(['--mode', 'generate_session', '--target-date', SUNDAY, '--json'], io);
    expect(stdout).toHaveLength(1);
    expect(() => JSON.parse(stdout[0]!)).not.toThrow();
  });

  it('without --json, prints a human-readable summary (not raw JSON) on stdout', async () => {
    const { io, stdout } = captureIo();
    await runTokenReportCli(['--mode', 'generate_session', '--target-date', SUNDAY], io);
    const text = stdout.join('');
    expect(text).toMatch(/AI Token Report/);
    expect(() => JSON.parse(text)).toThrow();
  });
});

describe('runTokenReportCli — pricing', () => {
  it('pricing is optional: without --pricing-file, costs are null', async () => {
    const { io, stdout } = captureIo();
    await runTokenReportCli(['--mode', 'generate_session', '--target-date', SUNDAY, '--json'], io);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.costProjection.inputUsdPerMillionTokens).toBeNull();
    expect(parsed.costProjection.typicalTotalCost).toBeNull();
  });

  it('loads a valid pricing file and applies it by configured model name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-report-cli-'));
    const pricingPath = join(dir, 'prices.json');
    writeFileSync(pricingPath, JSON.stringify({ models: { 'test-model': { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 } } }));

    const { io, stdout } = captureIo();
    const code = await runTokenReportCli(['--mode', 'generate_session', '--target-date', SUNDAY, '--pricing-file', pricingPath, '--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.costProjection.pricingSource).toBe(pricingPath);
    expect(parsed.costProjection.inputUsdPerMillionTokens).toBe(3);
    expect(parsed.costProjection.typicalTotalCost).not.toBeNull();
  });

  it('missing model pricing entry yields null costs, never a guessed price', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-report-cli-'));
    const pricingPath = join(dir, 'prices.json');
    writeFileSync(pricingPath, JSON.stringify({ models: { 'some-other-model': { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 } } }));

    const { io, stdout } = captureIo();
    const code = await runTokenReportCli(['--mode', 'generate_session', '--target-date', SUNDAY, '--pricing-file', pricingPath, '--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.costProjection.inputUsdPerMillionTokens).toBeNull();
    expect(parsed.costProjection.typicalTotalCost).toBeNull();
  });

  it('rejects a nonexistent pricing file with exit code 1', async () => {
    const { io, stderr } = captureIo();
    const code = await runTokenReportCli(['--mode', 'generate_session', '--target-date', SUNDAY, '--pricing-file', '/nonexistent/path/prices.json'], io);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/Could not read pricing file/);
  });

  it('rejects a malformed pricing file with exit code 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-report-cli-'));
    const pricingPath = join(dir, 'bad.json');
    writeFileSync(pricingPath, '{not valid json');
    const { io, stderr } = captureIo();
    const code = await runTokenReportCli(['--mode', 'generate_session', '--target-date', SUNDAY, '--pricing-file', pricingPath], io);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/not valid JSON/);
  });

  it('loadPricingFile rejects a file missing the models object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-report-cli-'));
    const pricingPath = join(dir, 'shape.json');
    writeFileSync(pricingPath, JSON.stringify({ notModels: {} }));
    expect(() => loadPricingFile(pricingPath)).toThrow(CliUsageError);
  });
});

describe('runTokenReportCli — no provider/network call occurs', () => {
  it('never invokes fetch across a full run in either mode', async () => {
    const { io } = captureIo();
    await runTokenReportCli(['--mode', 'generate_session', '--target-date', SUNDAY, '--json'], io);
    await runTokenReportCli(['--mode', 'reconcile_week', '--target-date', SUNDAY, '--json'], io);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('runTokenReportCli — --help', () => {
  it('prints usage and exits 0 without touching the database', async () => {
    const { io, stdout } = captureIo();
    const code = await runTokenReportCli(['--help'], io);
    expect(code).toBe(0);
    expect(stdout.join('')).toMatch(/Usage: npm run ai:token-report/);
  });
});
