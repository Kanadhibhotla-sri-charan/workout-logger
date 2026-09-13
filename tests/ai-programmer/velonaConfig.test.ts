// Dev Correction: Real Velona AI Integration (§2.9 "Configuration
// tests"): loadVelonaConfig/isAiProgrammerEnabled read directly from
// process.env and were previously untested. Every test restores the
// exact env vars it touches so this file never leaks state into other
// test files that run in the same worker.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAiProgrammerEnabled, loadVelonaConfig } from '../../src/ai-programmer/provider/config.js';
import { AIProviderConfigurationError } from '../../src/ai-programmer/errors.js';

const VELONA_ENV_KEYS = [
  'AI_PROGRAMMER_ENABLED',
  'VELONA_API_KEY',
  'VELONA_MODEL',
  'VELONA_BASE_URL',
  'VELONA_TIMEOUT_MS',
  'VELONA_MAX_RETRIES',
  'VELONA_TEMPERATURE',
  'VELONA_MAX_TOKENS',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(VELONA_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of VELONA_ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of VELONA_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('isAiProgrammerEnabled', () => {
  it('is false when AI_PROGRAMMER_ENABLED is unset', () => {
    expect(isAiProgrammerEnabled()).toBe(false);
  });

  it('is false for any value other than the exact string "true"', () => {
    process.env.AI_PROGRAMMER_ENABLED = 'TRUE';
    expect(isAiProgrammerEnabled()).toBe(false);
    process.env.AI_PROGRAMMER_ENABLED = '1';
    expect(isAiProgrammerEnabled()).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    process.env.AI_PROGRAMMER_ENABLED = 'true';
    expect(isAiProgrammerEnabled()).toBe(true);
  });
});

describe('loadVelonaConfig — missing configuration fails clearly, never with a guessed default', () => {
  it('throws AIProviderConfigurationError when VELONA_API_KEY is missing', () => {
    process.env.VELONA_MODEL = 'anthropic/claude-sonnet-5';
    expect(() => loadVelonaConfig()).toThrow(AIProviderConfigurationError);
    expect(() => loadVelonaConfig()).toThrow(/VELONA_API_KEY/);
  });

  it('throws AIProviderConfigurationError when VELONA_MODEL is missing', () => {
    process.env.VELONA_API_KEY = 'test-key';
    expect(() => loadVelonaConfig()).toThrow(AIProviderConfigurationError);
    expect(() => loadVelonaConfig()).toThrow(/VELONA_MODEL/);
  });

  it('throws when VELONA_TIMEOUT_MS is not a positive number', () => {
    process.env.VELONA_API_KEY = 'test-key';
    process.env.VELONA_MODEL = 'anthropic/claude-sonnet-5';
    process.env.VELONA_TIMEOUT_MS = '-5';
    expect(() => loadVelonaConfig()).toThrow(/VELONA_TIMEOUT_MS/);
  });

  it('throws when VELONA_MAX_RETRIES is negative', () => {
    process.env.VELONA_API_KEY = 'test-key';
    process.env.VELONA_MODEL = 'anthropic/claude-sonnet-5';
    process.env.VELONA_MAX_RETRIES = '-1';
    expect(() => loadVelonaConfig()).toThrow(/VELONA_MAX_RETRIES/);
  });

  it('throws when VELONA_TEMPERATURE is negative', () => {
    process.env.VELONA_API_KEY = 'test-key';
    process.env.VELONA_MODEL = 'anthropic/claude-sonnet-5';
    process.env.VELONA_TEMPERATURE = '-0.1';
    expect(() => loadVelonaConfig()).toThrow(/VELONA_TEMPERATURE/);
  });

  it('throws when VELONA_MAX_TOKENS is not positive', () => {
    process.env.VELONA_API_KEY = 'test-key';
    process.env.VELONA_MODEL = 'anthropic/claude-sonnet-5';
    process.env.VELONA_MAX_TOKENS = '0';
    expect(() => loadVelonaConfig()).toThrow(/VELONA_MAX_TOKENS/);
  });
});

describe('loadVelonaConfig — model configuration is loaded correctly', () => {
  it('applies documented defaults when only the required vars are set', () => {
    process.env.VELONA_API_KEY = 'test-key';
    process.env.VELONA_MODEL = 'anthropic/claude-sonnet-5';
    const config = loadVelonaConfig();
    expect(config).toEqual({
      apiKey: 'test-key',
      model: 'anthropic/claude-sonnet-5',
      baseUrl: 'https://velona.in/gateway/v1',
      timeoutMs: 60_000,
      maxRetries: 1,
      temperature: 0.2,
      maxTokens: 4096,
    });
  });

  it('every value is overridable via its own env var, never silently ignored', () => {
    process.env.VELONA_API_KEY = 'test-key';
    process.env.VELONA_MODEL = 'anthropic/claude-opus-5';
    process.env.VELONA_BASE_URL = 'https://velona.test/gateway/v1';
    process.env.VELONA_TIMEOUT_MS = '15000';
    process.env.VELONA_MAX_RETRIES = '3';
    process.env.VELONA_TEMPERATURE = '0';
    process.env.VELONA_MAX_TOKENS = '2048';
    const config = loadVelonaConfig();
    expect(config).toEqual({
      apiKey: 'test-key',
      model: 'anthropic/claude-opus-5',
      baseUrl: 'https://velona.test/gateway/v1',
      timeoutMs: 15000,
      maxRetries: 3,
      temperature: 0,
      maxTokens: 2048,
    });
  });
});
