// Same-context retry gate: remembers, in process memory only, which
// (targetDate, contextHash) pairs most recently failed an AI-output
// quality check, so generate_session can refuse to pay for an identical
// provider call again unless the caller explicitly asks to retry.
//
// Deliberately NOT stored in ai_program_proposals or any other table: a
// failed generation is not a proposal and has no valid proposal content.
// Losing this memory on restart is safe — the worst case is one extra
// paid attempt, never a wrong result.
//
// Keyed per database connection (WeakMap) rather than module-global, so
// the memory's lifetime matches the connection: one for the running
// server, a fresh one for each test's in-memory database.

import type Database from 'better-sqlite3';
import { AIProgrammerError } from '../errors.js';
import { boundDiagnosticIssues } from '../validation/diagnosticsBounds.js';
import { nowIso } from '../../repositories/ids.js';

/** Only failures of the AI's own output. Provider/transient failures
 * (timeouts, rate limits, unavailability, auth/config) are never
 * remembered — they say nothing about whether the same context would
 * produce a valid proposal. */
export const GATED_GENERATION_FAILURE_CODES = [
  'AI_PROVIDER_OUTPUT_TRUNCATED',
  'AI_OUTPUT_SCHEMA_INVALID',
  'AI_OUTPUT_DOMAIN_INVALID',
  'AI_OUTPUT_ADEQUACY_INVALID',
] as const;

export type GatedGenerationFailureCode = (typeof GATED_GENERATION_FAILURE_CODES)[number];

export interface GenerationFailureRecord {
  code: GatedGenerationFailureCode;
  issues: string[];
  failedAt: string;
}

export const MAX_REMEMBERED_FAILURES_PER_DATABASE = 100;

const failuresByDatabase = new WeakMap<Database.Database, Map<string, GenerationFailureRecord>>();

function keyOf(targetDate: string, contextHash: string): string {
  return `${targetDate}|${contextHash}`;
}

function failuresFor(db: Database.Database): Map<string, GenerationFailureRecord> {
  let failures = failuresByDatabase.get(db);
  if (!failures) {
    failures = new Map();
    failuresByDatabase.set(db, failures);
  }
  return failures;
}

export function isGatedGenerationFailure(err: unknown): err is AIProgrammerError & { code: GatedGenerationFailureCode } {
  return err instanceof AIProgrammerError && (GATED_GENERATION_FAILURE_CODES as readonly string[]).includes(err.code);
}

function boundedIssuesOf(err: AIProgrammerError): string[] {
  const issues = (err.details as { issues?: unknown } | undefined)?.issues;
  const strings = Array.isArray(issues) ? issues.filter((i): i is string => typeof i === 'string') : [];
  return boundDiagnosticIssues(strings.length > 0 ? strings : [err.publicMessage]);
}

export function recordGenerationFailure(
  db: Database.Database,
  targetDate: string,
  contextHash: string,
  err: AIProgrammerError & { code: GatedGenerationFailureCode }
): void {
  const failures = failuresFor(db);
  const key = keyOf(targetDate, contextHash);
  failures.delete(key); // re-insert so a repeated failure counts as the newest entry
  failures.set(key, { code: err.code, issues: boundedIssuesOf(err), failedAt: nowIso() });
  while (failures.size > MAX_REMEMBERED_FAILURES_PER_DATABASE) {
    const oldest = failures.keys().next().value as string;
    failures.delete(oldest);
  }
}

export function findGenerationFailure(db: Database.Database, targetDate: string, contextHash: string): GenerationFailureRecord | undefined {
  return failuresByDatabase.get(db)?.get(keyOf(targetDate, contextHash));
}

export function clearGenerationFailure(db: Database.Database, targetDate: string, contextHash: string): void {
  failuresByDatabase.get(db)?.delete(keyOf(targetDate, contextHash));
}
