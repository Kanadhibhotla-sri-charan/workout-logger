// Environment-based configuration for the AI Programmer integration —
// VELONA_PROVIDER_INTEGRATION_SPEC.md §3 / CLAUDE_TASK §9: never
// hard-code an API key or model name in source, read everything from
// the environment, and keep the feature fully disabled by default.

import { AIProviderConfigurationError } from '../errors.js';

export function isAiProgrammerEnabled(): boolean {
  return process.env.AI_PROGRAMMER_ENABLED === 'true';
}

export interface VelonaConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
  maxTokens: number;
}

// Confirmed real (docs/DEV_CORRECTION_REAL_VELONA_AI_INTEGRATION_AND_NPM_AUDIT.md
// §2.1): the production gateway base URL, and the request config values
// Velona's own documented example uses. Both remain overridable via the
// environment, never silently swapped for a guess.
const DEFAULT_BASE_URL = 'https://velona.in/gateway/v1';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 4096;

/** Reads VelonaProvider's configuration from the environment. Throws
 * AIProviderConfigurationError (never silently falls back to a guessed
 * default) when a value with no safe default — the API key or the
 * model — is missing, per spec: "the provider should fail... with a
 * clear configuration error if the model is missing." */
export function loadVelonaConfig(): VelonaConfig {
  const apiKey = process.env.VELONA_API_KEY;
  if (!apiKey) {
    throw new AIProviderConfigurationError('VELONA_API_KEY is not set.');
  }
  const model = process.env.VELONA_MODEL;
  if (!model) {
    throw new AIProviderConfigurationError('VELONA_MODEL is not set — a production model must be explicitly configured, never hard-coded.');
  }
  const baseUrl = process.env.VELONA_BASE_URL || DEFAULT_BASE_URL;
  const timeoutMs = process.env.VELONA_TIMEOUT_MS ? Number(process.env.VELONA_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const maxRetries = process.env.VELONA_MAX_RETRIES ? Number(process.env.VELONA_MAX_RETRIES) : DEFAULT_MAX_RETRIES;
  const temperature = process.env.VELONA_TEMPERATURE ? Number(process.env.VELONA_TEMPERATURE) : DEFAULT_TEMPERATURE;
  const maxTokens = process.env.VELONA_MAX_TOKENS ? Number(process.env.VELONA_MAX_TOKENS) : DEFAULT_MAX_TOKENS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AIProviderConfigurationError(`VELONA_TIMEOUT_MS must be a positive number; received "${process.env.VELONA_TIMEOUT_MS}"`);
  }
  if (!Number.isFinite(maxRetries) || maxRetries < 0) {
    throw new AIProviderConfigurationError(`VELONA_MAX_RETRIES must be a non-negative number; received "${process.env.VELONA_MAX_RETRIES}"`);
  }
  if (!Number.isFinite(temperature) || temperature < 0) {
    throw new AIProviderConfigurationError(`VELONA_TEMPERATURE must be a non-negative number; received "${process.env.VELONA_TEMPERATURE}"`);
  }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new AIProviderConfigurationError(`VELONA_MAX_TOKENS must be a positive number; received "${process.env.VELONA_MAX_TOKENS}"`);
  }
  return { apiKey, baseUrl, model, timeoutMs, maxRetries, temperature, maxTokens };
}
