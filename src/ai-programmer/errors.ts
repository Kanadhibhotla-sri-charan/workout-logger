// AI Programmer Integration — First Vertical Slice (see
// docs/CLAUDE_TASK_AI_PROGRAMMER_FIRST_VERTICAL_SLICE.md §13): every
// failure mode the AI programmer path can produce is one of these typed
// errors, each carrying its own safe HTTP status and a `publicMessage`
// that never leaks provider secrets, raw upstream payloads, or stack
// traces to a client (spec §13: "do not return raw provider responses
// containing sensitive headers or credentials").

import { boundDiagnosticIssues } from './validation/diagnosticsBounds.js';

export type AIProgrammerErrorCode =
  | 'AI_PROGRAMMER_DISABLED'
  | 'AI_PROVIDER_CONFIGURATION_ERROR'
  | 'AI_PROVIDER_AUTHENTICATION_ERROR'
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_PROVIDER_RATE_LIMITED'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_PROVIDER_INVALID_RESPONSE'
  | 'AI_OUTPUT_SCHEMA_INVALID'
  | 'AI_OUTPUT_DOMAIN_INVALID'
  | 'AI_TARGET_NOT_EDITABLE'
  | 'AI_CONTEXT_INCOMPLETE'
  | 'AI_PROPOSAL_NOT_FOUND'
  | 'AI_PROPOSAL_INVALID_STATE'
  | 'AI_PROPOSAL_EXPIRED'
  | 'AI_PROPOSAL_CONFLICT'
  | 'AI_PROPOSAL_STALE'
  | 'AI_PROPOSAL_VALIDATION_FAILED'
  | 'AI_PROPOSAL_COMMIT_FAILED';

/** Base class for every error this integration throws. `statusCode` is
 * the HTTP status the route layer maps it to; `publicMessage` is what a
 * client may see (falls back to `message` when not overridden);
 * `details` is safe, structured diagnostic data (e.g. a list of
 * validation issues) — never a raw provider payload or stack trace. */
export class AIProgrammerError extends Error {
  constructor(
    public readonly code: AIProgrammerErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
    public readonly publicMessage: string = message
  ) {
    super(message);
    this.name = 'AIProgrammerError';
  }
}

export class AIProgrammerDisabledError extends AIProgrammerError {
  constructor() {
    super(
      'AI_PROGRAMMER_DISABLED',
      'AI Programmer generation is disabled (AI_PROGRAMMER_ENABLED is not "true").',
      503
    );
  }
}

export class AIProviderConfigurationError extends AIProgrammerError {
  constructor(message: string) {
    super('AI_PROVIDER_CONFIGURATION_ERROR', message, 500);
  }
}

export class AIProviderAuthenticationError extends AIProgrammerError {
  constructor() {
    super('AI_PROVIDER_AUTHENTICATION_ERROR', 'The AI provider rejected the configured credentials.', 502);
  }
}

export class AIProviderTimeoutError extends AIProgrammerError {
  constructor(timeoutMs: number) {
    super('AI_PROVIDER_TIMEOUT', `The AI provider did not respond within ${timeoutMs}ms.`, 504);
  }
}

export class AIProviderRateLimitedError extends AIProgrammerError {
  constructor(retryAfterSeconds?: number) {
    super('AI_PROVIDER_RATE_LIMITED', 'The AI provider is rate-limiting requests.', 429, { retryAfterSeconds });
  }
}

export class AIProviderUnavailableError extends AIProgrammerError {
  constructor(message = 'The AI provider is currently unavailable.') {
    super('AI_PROVIDER_UNAVAILABLE', message, 502);
  }
}

export class AIProviderInvalidResponseError extends AIProgrammerError {
  constructor(message: string, details?: unknown) {
    super('AI_PROVIDER_INVALID_RESPONSE', message, 502, details);
  }
}

export class AIOutputSchemaInvalidError extends AIProgrammerError {
  constructor(issues: string[]) {
    const bounded = boundDiagnosticIssues(issues);
    super('AI_OUTPUT_SCHEMA_INVALID', `AI output failed structural schema validation: ${bounded.join('; ')}`, 502, { issues: bounded });
  }
}

export class AIOutputDomainInvalidError extends AIProgrammerError {
  constructor(issues: string[]) {
    const bounded = boundDiagnosticIssues(issues);
    super('AI_OUTPUT_DOMAIN_INVALID', `AI output failed domain validation: ${bounded.join('; ')}`, 502, { issues: bounded });
  }
}

export class AITargetNotEditableError extends AIProgrammerError {
  constructor(targetDate: string, reason: string) {
    super('AI_TARGET_NOT_EDITABLE', `${targetDate} is not editable: ${reason}`, 409, { targetDate, reason });
  }
}

export class AIContextIncompleteError extends AIProgrammerError {
  constructor(missing: string[]) {
    super('AI_CONTEXT_INCOMPLETE', `Cannot build AI programmer context: ${missing.join('; ')}`, 500, { missing });
  }
}

// AI Programmer Phase 2
// (docs/CLAUDE_TASK_AI_PROGRAMMER_PHASE_2_PROPOSAL_APPROVAL_COMMIT.md
// §14): proposal storage/review/commit errors, following the exact same
// typed-error convention as the errors above.

export class AIProposalNotFoundError extends AIProgrammerError {
  constructor(proposalId: string) {
    super('AI_PROPOSAL_NOT_FOUND', `No AI proposal found with id "${proposalId}".`, 404);
  }
}

/** A status-transition request (approve/commit) that this proposal's
 * CURRENT status does not allow — e.g. approving a rejected/committed
 * proposal, or committing a pending (never-approved) one. */
export class AIProposalInvalidStateError extends AIProgrammerError {
  constructor(proposalId: string, currentStatus: string, action: string) {
    super(
      'AI_PROPOSAL_INVALID_STATE',
      `Proposal "${proposalId}" cannot be ${action} while in status "${currentStatus}".`,
      409,
      { proposalId, currentStatus, action }
    );
  }
}

export class AIProposalExpiredError extends AIProgrammerError {
  constructor(proposalId: string, expiresAt: string) {
    super('AI_PROPOSAL_EXPIRED', `Proposal "${proposalId}" expired at ${expiresAt} and can no longer be approved or committed.`, 410, {
      proposalId,
      expiresAt,
    });
  }
}

/** A target-date conflict discovered at commit time: an existing
 * completed/in-progress/planned workout session already occupies this
 * proposal's target date (spec §11: reject planned-session conflicts by
 * default). Distinct from `AIProposalInvalidStateError`, which is about
 * the PROPOSAL's own status, not an external scheduling conflict. */
export class AIProposalConflictError extends AIProgrammerError {
  constructor(proposalId: string, targetDate: string, conflictingSessionId: string, conflictingStatus: string) {
    super(
      'AI_PROPOSAL_CONFLICT',
      `Proposal "${proposalId}" cannot be committed: a workout session (${conflictingSessionId}, status "${conflictingStatus}") already exists for ${targetDate}.`,
      409,
      { proposalId, targetDate, conflictingSessionId, conflictingStatus }
    );
  }
}

/** The proposal no longer matches current Blueprint/profile/context
 * state — e.g. the Blueprint commit changed, an authored prescription
 * changed, an exercise is no longer valid, or the target date's weekday
 * no longer matches. Never silently regenerated or altered — the
 * caller must request a fresh proposal instead (spec §13). */
export class AIProposalStaleError extends AIProgrammerError {
  constructor(proposalId: string, issues: string[]) {
    const bounded = boundDiagnosticIssues(issues);
    super('AI_PROPOSAL_STALE', `Proposal "${proposalId}" no longer matches current Blueprint/training state: ${bounded.join('; ')}`, 422, {
      proposalId,
      issues: bounded,
    });
  }
}

/** The proposal's stored JSON failed re-validation at commit time
 * (structural or domain) for a reason other than staleness — e.g.
 * malformed stored JSON. */
export class AIProposalValidationFailedError extends AIProgrammerError {
  constructor(proposalId: string, issues: string[]) {
    const bounded = boundDiagnosticIssues(issues);
    super(
      'AI_PROPOSAL_VALIDATION_FAILED',
      `Proposal "${proposalId}" failed revalidation at commit time: ${bounded.join('; ')}`,
      422,
      { proposalId, issues: bounded }
    );
  }
}

/** Every precondition passed, but the actual database write (creating
 * the planned session, or marking the proposal committed) failed. Never
 * leaks the underlying SQL error message/stack trace to the client. */
export class AIProposalCommitFailedError extends AIProgrammerError {
  constructor(proposalId: string) {
    super('AI_PROPOSAL_COMMIT_FAILED', `Proposal "${proposalId}" could not be committed due to an internal error.`, 500, { proposalId });
  }
}
