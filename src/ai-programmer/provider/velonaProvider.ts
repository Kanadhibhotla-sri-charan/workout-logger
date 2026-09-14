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

import type { AIProgrammerMode, AIProgrammerProvider, AIProgrammerProviderRequest, AIProgrammerProviderResponse } from '../contracts/providerTypes.js';
import {
  AIProviderAuthenticationError,
  AIProviderInvalidResponseError,
  AIProviderRateLimitedError,
  AIProviderTimeoutError,
  AIProviderUnavailableError,
} from '../errors.js';
import type { VelonaConfig } from './config.js';

// Confirmed real response/error shape (docs/DEV_CORRECTION_REAL_VELONA_AI_INTEGRATION_AND_NPM_AUDIT.md
// §2.1, and directly observed from a live unauthenticated probe against
// the real endpoint: a 401 with no Authorization header returns exactly
// `{request_id, status: "error", error: {code: "INVALID_KEY", message,
// docs}}`). `status` distinguishes success/error at the body level —
// checked even when the HTTP status itself is 2xx, since some gateways
// report an application-level error under an otherwise-200 response.
interface VelonaResponseBody {
  request_id?: string;
  status?: 'success' | 'error';
  data?: {
    run_id?: string;
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
    timestamp?: string;
  };
  error?: {
    code?: string;
    message?: string;
    docs?: string;
  };
}

function describeVelonaError(payload: VelonaResponseBody | undefined, httpStatus: number): string {
  const code = payload?.error?.code;
  const message = payload?.error?.message;
  if (code || message) {
    return `Velona returned HTTP ${httpStatus} (${code ?? 'unknown code'}): ${message ?? 'no message'}.`;
  }
  return `Velona returned HTTP ${httpStatus}.`;
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

/** Fix AI Weekly Reconciliation Review, Finding 2: the exact user-turn
 * JSON string Velona receives — a PURE function of `request` alone (it
 * needs no `VelonaConfig`), reused as-is by `buildVelonaRequestBody`
 * below AND by `tokenDiagnostics.ts` (which has no `VelonaConfig` of its
 * own, since the application service is provider-independent) so the
 * "estimated input tokens" figure is computed from the real text this
 * provider would actually send, for every provider, not just Velona —
 * never a second, independently-drifting reconstruction of this shape. */
export function buildVelonaUserTurnContent(request: AIProgrammerProviderRequest): string {
  return JSON.stringify({
    request: { mode: request.mode, requestId: request.requestId },
    context: request.context,
    outputSchema: request.outputSchema,
    instruction: 'Return exactly one JSON object conforming to outputSchema. No prose outside the JSON object.',
  });
}

export interface VelonaRequestBody {
  model: string;
  turns: Array<{ role: 'system' | 'user'; content: string }>;
  stream: false;
  config: { temperature: number; max_tokens: number };
  output: { format: 'json' };
}

/** Real Dry-Run Token Report spec §3: the individual pieces a caller
 * needs to measure request size WITHOUT re-deriving them (and therefore
 * risking drift from what `body` itself actually contains) —
 * `systemInstruction`/`userTurnContent` are exactly `body.turns[0]
 * .content`/`body.turns[1].content`; `outputSchemaJson` is
 * `JSON.stringify(request.outputSchema)` alone (never re-embedded — it
 * already lives inside `userTurnContent`, so a caller measuring both
 * must not sum them as if they were disjoint). */
export interface VelonaPayloadBuildResult {
  body: VelonaRequestBody;
  systemInstruction: string;
  userTurnContent: string;
  outputSchemaJson: string;
}

// Cross-Week Programming Intelligence Fix — token-limit review:
// `reconcile_week`'s real output is structurally much larger than
// `generate_session`'s (up to 7 days' worth of sessions instead of one,
// each day's exercises carrying their own `rationale[]` array — see
// weekReconciliationTypes.ts). A real, busy week (4 real gym days, each
// with a full development-reference-driven exercise list — this
// repo's own cross-week regression fixture, tests/engine/
// crossWeekPlanningHorizon.test.ts, exercises a real 16-exercise
// session) can plausibly approach the shared 4096-token default on the
// documented chars/4 heuristic alone, leaving no real safety margin.
// Rather than raising the shared default for both modes (inflating
// generate_session's own much smaller real need, and its cost ceiling,
// for no reason), this is a targeted, mode-specific floor — an
// operator's own explicit VELONA_MAX_TOKENS still wins whenever it is
// already configured higher than this floor.
const RECONCILE_WEEK_MIN_MAX_TOKENS = 6144;

/** The actual `max_tokens` value a given request mode should use — the
 * ONE place this decision is made, so `buildVelonaRequestBody` (the
 * real wire body) and tokenReport.ts (diagnostics, which reads the
 * built body back) can never disagree about it. */
export function effectiveMaxTokensForMode(config: VelonaConfig, mode: AIProgrammerMode): number {
  return mode === 'reconcile_week' ? Math.max(config.maxTokens, RECONCILE_WEEK_MIN_MAX_TOKENS) : config.maxTokens;
}

/** Fix AI Weekly Reconciliation Review, Finding 2 / Real Dry-Run Token
 * Report spec §3: the ONE place this exact request body is constructed —
 * used both by the real fetch path (`generate()` below, which reads
 * `.body` off this result) and by dry-run token-report diagnostics
 * (`tokenReport.ts`), so production and diagnostics can never disagree
 * about what was actually (or would actually be) sent. */
export function buildVelonaRequestBody(request: AIProgrammerProviderRequest, config: VelonaConfig): VelonaPayloadBuildResult {
  const userTurnContent = buildVelonaUserTurnContent(request);
  const body: VelonaRequestBody = {
    model: config.model,
    turns: [
      { role: 'system', content: request.systemInstruction },
      { role: 'user', content: userTurnContent },
    ],
    stream: false,
    config: { temperature: config.temperature, max_tokens: effectiveMaxTokensForMode(config, request.mode) },
    output: { format: 'json' },
  };
  return {
    body,
    systemInstruction: request.systemInstruction,
    userTurnContent,
    outputSchemaJson: JSON.stringify(request.outputSchema),
  };
}

export class VelonaProvider implements AIProgrammerProvider {
  constructor(private readonly config: VelonaConfig) {}

  async generate(request: AIProgrammerProviderRequest): Promise<AIProgrammerProviderResponse> {
    const { body, systemInstruction, userTurnContent } = buildVelonaRequestBody(request, this.config);

    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const result = await this.attemptOnce(body, request.requestId);
        // Deployment §2.10: how to inspect logs for provider-call
        // success/failure. safeLogFields never includes the API key or
        // raw context/prompt content.
        console.log('[velona] request succeeded', safeLogFields(this.config, request.requestId, { attempt, resolvedModel: result.model }));
        // Finding 2: measured from the EXACT `body` this attempt sent
        // (never a re-derived approximation) — see `buildVelonaRequestBody`'s
        // own doc comment.
        return {
          ...result,
          requestDiagnostics: {
            systemInstructionChars: systemInstruction.length,
            userTurnChars: userTurnContent.length,
            wirePayloadChars: JSON.stringify(body).length,
            configuredMaxOutputTokens: body.config.max_tokens,
          },
        };
      } catch (err) {
        if (err instanceof RetryableProviderError && attempt <= this.config.maxRetries) {
          console.warn('[velona] request failed, retrying', safeLogFields(this.config, request.requestId, { attempt, reason: err.cause.message }));
          await delay(err.retryAfterMs ?? 300 * attempt);
          continue;
        }
        const final = err instanceof RetryableProviderError ? err.cause : err;
        console.error(
          '[velona] request failed',
          safeLogFields(this.config, request.requestId, { attempt, reason: final instanceof Error ? final.message : String(final) })
        );
        throw final;
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

    // Every branch below that can read a documented `{status, error}`
    // body does so defensively (a non-JSON or empty body still falls
    // back to the plain HTTP-status message) — Velona's real error
    // shape was confirmed live: a 401 with no Authorization header
    // returns exactly `{request_id, status: "error", error: {code:
    // "INVALID_KEY", message, docs}}`.
    let errorPayload: VelonaResponseBody | undefined;
    if (!response.ok) {
      errorPayload = await response
        .clone()
        .json()
        .then((v) => v as VelonaResponseBody)
        .catch(() => undefined);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AIProviderAuthenticationError();
    }
    if (response.status === 402) {
      throw new AIProviderUnavailableError(describeVelonaError(errorPayload, response.status));
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      throw new RetryableProviderError(new AIProviderRateLimitedError(retryAfterMs !== undefined ? retryAfterMs / 1000 : undefined), retryAfterMs);
    }
    if (response.status === 408 || (response.status >= 500 && response.status < 600)) {
      throw new RetryableProviderError(new AIProviderUnavailableError(describeVelonaError(errorPayload, response.status)));
    }
    if (!response.ok) {
      throw new AIProviderInvalidResponseError(describeVelonaError(errorPayload, response.status));
    }

    let payload: VelonaResponseBody;
    try {
      payload = (await response.json()) as VelonaResponseBody;
    } catch {
      throw new AIProviderInvalidResponseError('Velona response body was not valid JSON.');
    }

    // A gateway can report an application-level failure under an
    // otherwise-200 HTTP response — never treated as success just
    // because the transport layer succeeded.
    if (payload.status === 'error') {
      throw new AIProviderInvalidResponseError(describeVelonaError(payload, response.status));
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
