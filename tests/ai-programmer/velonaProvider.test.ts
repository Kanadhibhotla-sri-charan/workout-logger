// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §14.2): the
// required provider test matrix, run with a mocked global `fetch` — no
// real Velona API key is ever used or required.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VelonaProvider } from '../../src/ai-programmer/provider/velonaProvider.js';
import {
  AIProviderAuthenticationError,
  AIProviderInvalidResponseError,
  AIProviderRateLimitedError,
  AIProviderTimeoutError,
  AIProviderUnavailableError,
} from '../../src/ai-programmer/errors.js';
import type { VelonaConfig } from '../../src/ai-programmer/provider/config.js';

const CONFIG: VelonaConfig = {
  apiKey: 'test-key-never-a-real-secret',
  baseUrl: 'https://velona.test/gateway/v1',
  model: 'test-model',
  timeoutMs: 5000,
  maxRetries: 1,
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const BASE_REQUEST = { mode: 'generate_session' as const, systemInstruction: 'system', context: { a: 1 }, outputSchema: { type: 'object' }, requestId: 'req-1' };

describe('VelonaProvider', () => {
  it('successful provider response is normalized correctly', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: { output: '{"ok":true}', model: 'resolved-model', usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
        meta: { latency_ms: 123 },
      })
    );
    const provider = new VelonaProvider(CONFIG);
    const result = await provider.generate(BASE_REQUEST);
    expect(result.provider).toBe('velona');
    expect(result.model).toBe('resolved-model');
    expect(result.requestId).toBe('req-1');
    expect(result.rawText).toBe('{"ok":true}');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it('handles a structured (non-string) data.output by stringifying it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: { ok: true }, model: 'm' } }));
    const provider = new VelonaProvider(CONFIG);
    const result = await provider.generate(BASE_REQUEST);
    expect(JSON.parse(result.rawText)).toEqual({ ok: true });
  });

  it('sends the correct endpoint, authorization header, and request body shape', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{}' } }));
    const provider = new VelonaProvider(CONFIG);
    await provider.generate(BASE_REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://velona.test/gateway/v1/inference/run');
    expect(init.headers.Authorization).toBe('Bearer test-key-never-a-real-secret');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
    expect(body.output).toEqual({ format: 'json' });
    expect(body.turns[0]).toEqual({ role: 'system', content: 'system' });
    expect(body.turns[1].role).toBe('user');
  });

  it('never includes the API key anywhere in a request/response log helper', async () => {
    const { safeLogFields } = await import('../../src/ai-programmer/provider/velonaProvider.js');
    const fields = safeLogFields(CONFIG, 'req-1');
    expect(JSON.stringify(fields)).not.toContain(CONFIG.apiKey);
  });

  it('timeout aborts the request and throws AIProviderTimeoutError (no retry)', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const provider = new VelonaProvider({ ...CONFIG, timeoutMs: 20, maxRetries: 2 });
    await expect(provider.generate(BASE_REQUEST)).rejects.toBeInstanceOf(AIProviderTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // timeout is not retried
  });

  it('authentication failure (401) throws AIProviderAuthenticationError and is never retried', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'invalid key' }));
    const provider = new VelonaProvider({ ...CONFIG, maxRetries: 2 });
    await expect(provider.generate(BASE_REQUEST)).rejects.toBeInstanceOf(AIProviderAuthenticationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rate limiting (429) throws AIProviderRateLimitedError after exhausting bounded retries', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, {}, { 'retry-after': '0' }));
    const provider = new VelonaProvider({ ...CONFIG, maxRetries: 2 });
    await expect(provider.generate(BASE_REQUEST)).rejects.toBeInstanceOf(AIProviderRateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 original + 2 retries
  });

  it('a retryable 5xx response succeeds on a subsequent retry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {})).mockResolvedValueOnce(jsonResponse(200, { data: { output: '{"ok":true}' } }));
    const provider = new VelonaProvider({ ...CONFIG, maxRetries: 1 });
    const result = await provider.generate(BASE_REQUEST);
    expect(result.rawText).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a non-retryable 4xx response (e.g. 400) throws AIProviderInvalidResponseError without retrying', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'bad request' }));
    const provider = new VelonaProvider({ ...CONFIG, maxRetries: 2 });
    await expect(provider.generate(BASE_REQUEST)).rejects.toBeInstanceOf(AIProviderInvalidResponseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('malformed (non-JSON) response body throws AIProviderInvalidResponseError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const provider = new VelonaProvider(CONFIG);
    await expect(provider.generate(BASE_REQUEST)).rejects.toBeInstanceOf(AIProviderInvalidResponseError);
  });

  it('a response missing data.output throws AIProviderInvalidResponseError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    const provider = new VelonaProvider(CONFIG);
    await expect(provider.generate(BASE_REQUEST)).rejects.toBeInstanceOf(AIProviderInvalidResponseError);
  });

  it('a network failure is retried and then normalized to AIProviderUnavailableError', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const provider = new VelonaProvider({ ...CONFIG, maxRetries: 1 });
    await expect(provider.generate(BASE_REQUEST)).rejects.toBeInstanceOf(AIProviderUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('missing usage/billing metadata is handled without throwing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{}' } }));
    const provider = new VelonaProvider(CONFIG);
    const result = await provider.generate(BASE_REQUEST);
    expect(result.usage).toBeUndefined();
  });
});
