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
  | 'AI_CONTEXT_INCOMPLETE';

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
