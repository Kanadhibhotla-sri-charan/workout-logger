// AI Programmer Integration — First Vertical Slice
// (docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §14.2): the
// required provider test matrix, run with a mocked global `fetch` — no
// real Velona API key is ever used or required.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VelonaProvider, buildVelonaRequestBody, buildVelonaUserTurnContent, effectiveMaxTokensForMode, isLikelyTruncatedOutput } from '../../src/ai-programmer/provider/velonaProvider.js';
import {
  AIProgrammerError,
  AIProviderAuthenticationError,
  AIProviderInvalidResponseError,
  AIProviderOutputTruncatedError,
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
  temperature: 0.2,
  maxTokens: 4096,
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

  it('sends the correct endpoint, method, authorization header, and request body shape', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{}' } }));
    const provider = new VelonaProvider(CONFIG);
    await provider.generate(BASE_REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://velona.test/gateway/v1/inference/run');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer test-key-never-a-real-secret');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
    expect(body.output).toEqual({ format: 'json' });
    expect(body.turns[0]).toEqual({ role: 'system', content: 'system' });
    expect(body.turns[1].role).toBe('user');
  });

  it('sends the configured temperature and max_tokens in config (per the documented Velona contract)', async () => {
    // maxTokens deliberately set above BOTH mode floors (see
    // effectiveMaxTokensForMode's own tests below) so this test still
    // proves pure pass-through of the operator's own configured value.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{}' } }));
    const provider = new VelonaProvider({ ...CONFIG, temperature: 0.2, maxTokens: 20000 });
    await provider.generate(BASE_REQUEST);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body);
    expect(body.config).toEqual({ temperature: 0.2, max_tokens: 20000 });
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

  it('authentication failure with the real documented Velona error body (401, INVALID_KEY) is still AIProviderAuthenticationError', async () => {
    // Confirmed live against the real endpoint with no Authorization header.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        request_id: 'req_unknown',
        status: 'error',
        error: { code: 'INVALID_KEY', message: 'Missing Authorization header', docs: 'https://velona.in/docs/errors#INVALID_KEY' },
      })
    );
    const provider = new VelonaProvider(CONFIG);
    await expect(provider.generate(BASE_REQUEST)).rejects.toBeInstanceOf(AIProviderAuthenticationError);
  });

  it('insufficient credits (402) throws AIProviderUnavailableError with the upstream code/message surfaced, without retrying', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(402, { request_id: 'req_x', status: 'error', error: { code: 'INSUFFICIENT_CREDITS', message: 'Account balance is too low.' } })
    );
    const provider = new VelonaProvider({ ...CONFIG, maxRetries: 2 });
    const err = await provider.generate(BASE_REQUEST).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderUnavailableError);
    expect((err as AIProgrammerError).message).toContain('INSUFFICIENT_CREDITS');
    expect((err as AIProgrammerError).message).toContain('Account balance is too low.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a documented error body surfaces its code/message on a non-retryable 4xx', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { request_id: 'req_y', status: 'error', error: { code: 'VALIDATION_FAILED', message: 'model is not a valid identifier.' } })
    );
    const provider = new VelonaProvider(CONFIG);
    const err = await provider.generate(BASE_REQUEST).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderInvalidResponseError);
    expect((err as AIProgrammerError).message).toContain('VALIDATION_FAILED');
  });

  it('an application-level error reported under an HTTP 200 body is never treated as success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { request_id: 'req_z', status: 'error', error: { code: 'MODEL_UNAVAILABLE', message: 'The requested model is temporarily unavailable.' } })
    );
    const provider = new VelonaProvider(CONFIG);
    const err = await provider.generate(BASE_REQUEST).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderInvalidResponseError);
    expect((err as AIProgrammerError).message).toContain('MODEL_UNAVAILABLE');
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

  // Coaching Depth follow-up fix regression coverage (test scenario A):
  // a response reporting a recognized truncation finish reason with
  // null output/content must be a distinct AIProviderOutputTruncatedError
  // — never crash, never fall through to JSON parsing/schema validation
  // against null content, and never be mistaken for a generic
  // "response did not contain data.output" failure.
  it('a null-output response with finish "length" throws AIProviderOutputTruncatedError, not the generic invalid-response error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { output: null, model: 'm', finish: 'length', usage: { completion_tokens: 4096 } } })
    );
    const provider = new VelonaProvider(CONFIG);
    const err = await provider.generate(BASE_REQUEST).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderOutputTruncatedError);
    expect(err).not.toBeInstanceOf(AIProviderInvalidResponseError);
    expect((err as AIProgrammerError).code).toBe('AI_PROVIDER_OUTPUT_TRUNCATED');
    // CONFIG.maxTokens (4096) is below generate_session's own floor, so
    // the value actually sent (and reported as configuredMaxOutputTokens)
    // is the effective, floored value — see effectiveMaxTokensForMode.
    const effectiveMaxTokens = effectiveMaxTokensForMode(CONFIG, BASE_REQUEST.mode);
    expect((err as AIProgrammerError).details).toMatchObject({ finishReason: 'length', completionTokens: 4096, configuredMaxOutputTokens: effectiveMaxTokens });
  });

  it('a null-output response with completion_tokens at the configured cap (no recognized finish string) also throws AIProviderOutputTruncatedError', async () => {
    const effectiveMaxTokens = effectiveMaxTokensForMode(CONFIG, BASE_REQUEST.mode);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: null, usage: { completion_tokens: effectiveMaxTokens } } }));
    const provider = new VelonaProvider(CONFIG);
    await expect(provider.generate(BASE_REQUEST)).rejects.toBeInstanceOf(AIProviderOutputTruncatedError);
  });

  it('a null-output response with finish "stop" and no usage well under the cap remains the generic invalid-response error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: null, finish: 'stop' } }));
    const provider = new VelonaProvider(CONFIG);
    const err = await provider.generate(BASE_REQUEST).catch((e) => e);
    expect(err).toBeInstanceOf(AIProviderInvalidResponseError);
    expect(err).not.toBeInstanceOf(AIProviderOutputTruncatedError);
  });

  it('a successful response carries the provider finishReason through verbatim', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{"ok":true}', finish: 'stop' } }));
    const provider = new VelonaProvider(CONFIG);
    const result = await provider.generate(BASE_REQUEST);
    expect(result.finishReason).toBe('stop');
  });

  describe('isLikelyTruncatedOutput', () => {
    it('recognizes known truncation finish reasons regardless of case', () => {
      expect(isLikelyTruncatedOutput('length', undefined, undefined)).toBe(true);
      expect(isLikelyTruncatedOutput('LENGTH', undefined, undefined)).toBe(true);
      expect(isLikelyTruncatedOutput('max_tokens', 10, 4096)).toBe(true);
    });

    it('treats completion tokens at or above the configured cap as truncation even with an unrecognized/absent finish reason', () => {
      expect(isLikelyTruncatedOutput(undefined, 4096, 4096)).toBe(true);
      expect(isLikelyTruncatedOutput('stop', 4097, 4096)).toBe(true);
    });

    it('is false when neither signal indicates truncation', () => {
      expect(isLikelyTruncatedOutput('stop', 500, 4096)).toBe(false);
      expect(isLikelyTruncatedOutput(undefined, undefined, undefined)).toBe(false);
      expect(isLikelyTruncatedOutput('content_filter', 10, 4096)).toBe(false);
    });
  });

  describe('effectiveMaxTokensForMode (Coaching Depth follow-up fix)', () => {
    it('floors generate_session at 16384 when the operator config is lower', () => {
      expect(effectiveMaxTokensForMode({ ...CONFIG, maxTokens: 4096 }, 'generate_session')).toBe(16384);
    });

    it('still honors an operator config already above the floor', () => {
      expect(effectiveMaxTokensForMode({ ...CONFIG, maxTokens: 20000 }, 'generate_session')).toBe(20000);
    });

    it('leaves reconcile_week\'s own existing 6144 floor unchanged', () => {
      expect(effectiveMaxTokensForMode({ ...CONFIG, maxTokens: 4096 }, 'reconcile_week')).toBe(6144);
    });
  });

  it('a network failure is retried and then normalized to AIProviderUnavailableError', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const provider = new VelonaProvider({ ...CONFIG, maxRetries: 1 });
    await expect(provider.generate(BASE_REQUEST)).rejects.toBeInstanceOf(AIProviderUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('logs provider-call success and failure without ever including the API key', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{}' } }));
      const provider = new VelonaProvider(CONFIG);
      await provider.generate(BASE_REQUEST);
      expect(logSpy).toHaveBeenCalled();

      fetchMock.mockResolvedValueOnce(jsonResponse(401, { status: 'error', error: { code: 'INVALID_KEY', message: 'bad key' } }));
      await provider.generate(BASE_REQUEST).catch(() => undefined);
      expect(errorSpy).toHaveBeenCalled();

      const allLoggedText = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].map((call) => JSON.stringify(call)).join('\n');
      expect(allLoggedText).not.toContain(CONFIG.apiKey);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('missing usage/billing metadata is handled without throwing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{}' } }));
    const provider = new VelonaProvider(CONFIG);
    const result = await provider.generate(BASE_REQUEST);
    expect(result.usage).toBeUndefined();
  });

  // Fix AI Weekly Reconciliation Review, Finding 2: buildVelonaRequestBody
  // is the ONE shared function that builds both the real fetch body and
  // the diagnostics attached to the response — these tests prove the two
  // can never disagree, by comparing the exact bytes fetch received
  // against both buildVelonaRequestBody's own direct output and the
  // response's own requestDiagnostics.

  it('the exact body sent to fetch equals buildVelonaRequestBody(request, config).body, byte for byte', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{}' } }));
    const provider = new VelonaProvider(CONFIG);
    await provider.generate(BASE_REQUEST);

    const [, init] = fetchMock.mock.calls[0]!;
    const expected = buildVelonaRequestBody(BASE_REQUEST, CONFIG);
    expect(init.body).toBe(JSON.stringify(expected.body));
  });

  it('buildVelonaRequestBody also returns the individual pieces (systemInstruction/userTurnContent/outputSchemaJson) needed for dry-run measurement, matching body exactly', () => {
    const result = buildVelonaRequestBody(BASE_REQUEST, CONFIG);
    expect(result.systemInstruction).toBe(result.body.turns[0]!.content);
    expect(result.userTurnContent).toBe(result.body.turns[1]!.content);
    expect(result.outputSchemaJson).toBe(JSON.stringify(BASE_REQUEST.outputSchema));
  });

  it('buildVelonaUserTurnContent needs no VelonaConfig and matches the exact user-turn content actually sent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{}' } }));
    const provider = new VelonaProvider(CONFIG);
    await provider.generate(BASE_REQUEST);

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse(init.body);
    expect(sentBody.turns[1].content).toBe(buildVelonaUserTurnContent(BASE_REQUEST));
  });

  it('the user-turn content wraps context AND outputSchema together — outputSchema is never a separate top-level field', async () => {
    const content = buildVelonaUserTurnContent(BASE_REQUEST);
    const parsed = JSON.parse(content);
    expect(parsed.context).toEqual(BASE_REQUEST.context);
    expect(parsed.outputSchema).toEqual(BASE_REQUEST.outputSchema);
    expect(parsed.request).toEqual({ mode: BASE_REQUEST.mode, requestId: BASE_REQUEST.requestId });
    expect(typeof parsed.instruction).toBe('string');
    expect(parsed.instruction.length).toBeGreaterThan(0);
  });

  it('a successful response carries requestDiagnostics measuring the exact wire body just sent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{}' } }));
    const provider = new VelonaProvider(CONFIG);
    const result = await provider.generate(BASE_REQUEST);

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBodyString = init.body as string;
    const sentBody = JSON.parse(sentBodyString);

    expect(result.requestDiagnostics).toBeDefined();
    expect(result.requestDiagnostics!.systemInstructionChars).toBe(BASE_REQUEST.systemInstruction.length);
    expect(result.requestDiagnostics!.userTurnChars).toBe((sentBody.turns[1].content as string).length);
    expect(result.requestDiagnostics!.wirePayloadChars).toBe(sentBodyString.length);
    // CONFIG.maxTokens (4096) is below generate_session's own floor, so
    // the effective value actually sent is the floor, not the raw config.
    expect(result.requestDiagnostics!.configuredMaxOutputTokens).toBe(effectiveMaxTokensForMode(CONFIG, BASE_REQUEST.mode));
  });

  it('requestDiagnostics.wirePayloadChars reflects a changed max_tokens/temperature config', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { output: '{}' } }));
    const provider = new VelonaProvider({ ...CONFIG, maxTokens: 20000, temperature: 0.7 });
    const result = await provider.generate(BASE_REQUEST);
    expect(result.requestDiagnostics!.configuredMaxOutputTokens).toBe(20000);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(result.requestDiagnostics!.wirePayloadChars).toBe((init.body as string).length);
  });
});
