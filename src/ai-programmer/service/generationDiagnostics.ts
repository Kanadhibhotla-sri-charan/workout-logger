// Rejection observability (2026-09-28): one bounded, structured server-log
// record for every rejected generate_session request, so a production
// failure can be diagnosed from the logs directly (stage, reason, context)
// instead of being reverse-engineered from response sizes. Server-side
// only: never persisted, never returned to a client, and never contains
// raw AI output — only our own typed-error codes and their already-bounded
// diagnostic issues.

import { AIProgrammerError } from '../errors.js';
import { boundDiagnosticIssues } from '../validation/diagnosticsBounds.js';
import { nowIso } from '../../repositories/ids.js';

export type GenerationRejectionStage =
  | 'disabled'
  | 'pending_guard'
  | 'context'
  | 'retry_gate'
  | 'provider'
  | 'provider_output'
  | 'schema'
  | 'domain'
  | 'adequacy'
  | 'other'
  | 'internal';

export interface GenerationRejectionDiagnostic {
  event: 'generate_session_rejected';
  stage: GenerationRejectionStage;
  code: string;
  issues: string[];
  contextHash: string | null;
  targetDate: string;
  sessionPurpose: string | null;
  timestamp: string;
}

/** Each typed error is thrown by exactly one pipeline stage, so the code
 * alone identifies where the request stopped. */
const STAGE_BY_CODE: Readonly<Record<string, GenerationRejectionStage>> = {
  AI_PROGRAMMER_DISABLED: 'disabled',
  AI_PROPOSAL_ALREADY_PENDING: 'pending_guard',
  AI_TARGET_NOT_EDITABLE: 'context',
  AI_CONTEXT_INCOMPLETE: 'context',
  AI_GENERATION_PREVIOUSLY_FAILED: 'retry_gate',
  AI_PROVIDER_CONFIGURATION_ERROR: 'provider',
  AI_PROVIDER_AUTHENTICATION_ERROR: 'provider',
  AI_PROVIDER_TIMEOUT: 'provider',
  AI_PROVIDER_RATE_LIMITED: 'provider',
  AI_PROVIDER_UNAVAILABLE: 'provider',
  AI_PROVIDER_INVALID_RESPONSE: 'provider',
  AI_PROVIDER_OUTPUT_TRUNCATED: 'provider_output',
  AI_OUTPUT_SCHEMA_INVALID: 'schema',
  AI_OUTPUT_DOMAIN_INVALID: 'domain',
  AI_OUTPUT_ADEQUACY_INVALID: 'adequacy',
};

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The error's own already-bounded validation issues when it carries any;
 * otherwise our own constructed error message (never provider/model text
 * beyond what the typed error itself already bounds). */
function issuesOf(err: AIProgrammerError): string[] {
  const details = err.details as { issues?: unknown; previousErrorCode?: unknown; previousIssues?: unknown } | undefined;
  const issues = stringsOf(details?.issues);
  if (issues.length > 0) return boundDiagnosticIssues(issues);
  if (typeof details?.previousErrorCode === 'string') {
    return boundDiagnosticIssues([`previous failure: ${details.previousErrorCode}`, ...stringsOf(details.previousIssues)]);
  }
  return boundDiagnosticIssues([err.message]);
}

export function buildGenerationRejectionDiagnostic(
  err: unknown,
  request: { targetDate: string; contextHash: string | null; sessionPurpose: string | null },
  timestamp: string = nowIso()
): GenerationRejectionDiagnostic {
  if (err instanceof AIProgrammerError) {
    return {
      event: 'generate_session_rejected',
      stage: STAGE_BY_CODE[err.code] ?? 'other',
      code: err.code,
      issues: issuesOf(err),
      contextHash: request.contextHash,
      targetDate: request.targetDate,
      sessionPurpose: request.sessionPurpose,
      timestamp,
    };
  }
  // An unexpected, untyped failure: record only that it happened — its raw
  // message may carry internal detail (SQL text, stack context).
  return {
    event: 'generate_session_rejected',
    stage: 'internal',
    code: 'INTERNAL_ERROR',
    issues: [err instanceof Error ? err.name : 'unknown'],
    contextHash: request.contextHash,
    targetDate: request.targetDate,
    sessionPurpose: request.sessionPurpose,
    timestamp,
  };
}

export function logGenerationRejection(diagnostic: GenerationRejectionDiagnostic): void {
  console.warn('[ai-programmer] generation rejected', JSON.stringify(diagnostic));
}
