// VELONA_PROVIDER_INTEGRATION_SPEC.md: native HTTP integration with
// Velona's inference endpoint. Implements the provider-independent
// AIProgrammerProvider interface (contracts/providerTypes.ts) — the
// application service never imports this file directly except at
// wiring time (service/aiProgrammerService.ts's default factory).
//
// Never reads/writes the database, never loads Blueprint data, never
// decides exercise selection, never uses a provider-side memory
// session — every request carries its full context explicitly (spec
// §2). Bounded retry only for transient failures (network error, HTTP
// 408/429/5xx) — never for authentication failures or malformed
// requests (spec §10).

import type { AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../contracts/providerTypes.js';
import {
  AIProviderAuthenticationError,
  AIProviderInvalidResponseError,
  AIProviderRateLimitedError,
  AIProviderTimeoutError,
  AIProviderUnavailableError,
} from '../errors.js';
import type { VelonaConfig } from './config.js';

interface VelonaResponseBody {
  data?: {
    output?: unknown;
    model?: string;
    finish?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  meta?: {
    latency_ms?: number;
    billed_usd?: number;
  };
  error?: unknown;
}

/** Internal-only wrapper marking an error as safe to retry, carrying
 * the real (already-typed, sanitized) error to surface if retries are
 * exhausted, and an optional explicit backoff delay (e.g. from a
 * `Retry-After` header). Never thrown across this module's public
 * boundary. */
class RetryableProviderError extends Error {
  constructor(public readonly cause: Error, public readonly retryAfterMs?: number) {
    super(cause.message);
  }
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** No secrets, no full context, no raw model output — only the safe
 * metadata VELONA_PROVIDER_INTEGRATION_SPEC.md §12 recommends. Tests
 * assert this never contains the API key. */
export function safeLogFields(config: VelonaConfig, requestId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId, provider: 'velona', model: config.model, baseUrl: config.baseUrl, ...extra };
}

export class VelonaProvider implements AIProgrammerProvider {
  constructor(private readonly config: VelonaConfig) {}

  async generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
    const body = {
      model: this.config.model,
      turns: [
        { role: 'system', content: request.systemInstruction },
        {
          role: 'user',
          content: JSON.stringify({
            request: { mode: request.mode, requestId: request.requestId },
            context: request.context,
            outputSchema: request.outputSchema,
            instruction: 'Return exactly one JSON object conforming to outputSchema. No prose outside the JSON object.',
          }),
        },
      ],
      stream: false,
      config: { temperature: 0, top_p: 1 },
      output: { format: 'json' },
    };

    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await this.attemptOnce(body, request.requestId);
      } catch (err) {
        if (err instanceof RetryableProviderError && attempt <= this.config.maxRetries) {
          await delay(err.retryAfterMs ?? 300 * attempt);
          continue;
        }
        throw err instanceof RetryableProviderError ? err.cause : err;
      }
    }
  }

  private async attemptOnce(body: unknown, requestId: string): Promise<AIProgrammerProviderResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/inference/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AIProviderTimeoutError(this.config.timeoutMs);
      }
      throw new RetryableProviderError(new AIProviderUnavailableError('Velona request failed: network error.'));
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AIProviderAuthenticationError();
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new RetryableProviderError(new AIProviderRateLimitedError(retryAfterMs !== undefined ? retryAfterMs / 1000 : undefined), retryAfterMs);
    }
    if (response.status === 408 || (response.status >= 500 && response.status < 600)) {
      throw new RetryableProviderError(new AIProviderUnavailableError(`Velona returned HTTP ${response.status}.`));
    }
    if (!response.ok) {
      throw new AIProviderInvalidResponseError(`Velona returned HTTP ${response.status}.`);
    }

    let payload: VelonaResponseBody;
    try {
      payload = (await response.json()) as VelonaResponseBody;
    } catch {
      throw new AIProviderInvalidResponseError('Velona response body was not valid JSON.');
    }

    const rawOutput = payload.data?.output;
    if (rawOutput === undefined || rawOutput === null) {
      throw new AIProviderInvalidResponseError('Velona response did not contain data.output.');
    }
    const rawText = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);

    return {
      provider: 'velona',
      model: payload.data?.model ?? this.config.model,
      requestId,
      rawText,
      usage: payload.data?.usage
        ? {
            inputTokens: payload.data.usage.prompt_tokens,
            outputTokens: payload.data.usage.completion_tokens,
            totalTokens: payload.data.usage.total_tokens,
          }
        : undefined,
    };
  }
}
