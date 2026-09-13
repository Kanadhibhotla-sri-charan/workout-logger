// Stable hashing for AIProgrammerContext — makes provider calls
// auditable and lets a caller detect accidental context drift between
// two requests that should be semantically identical (see
// docs/AI_PROGRAMMER_CONTEXT_BUILDER_IMPLEMENTATION.md §15).

import { createHash } from 'node:crypto';

/** Recursively sorts object keys so two objects with the same data in a
 * different key order hash identically. Arrays keep their own order —
 * order is semantically meaningful there (e.g. goal priority, exercise
 * history most-recent-first). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** A stable SHA-256 hex hash of `value`, independent of key insertion
 * order. Callers exclude volatile fields (contextId, generatedAt)
 * before calling this — see buildProgrammerContext. */
export function hashContext(value: unknown): string {
  const stable = JSON.stringify(sortKeysDeep(value));
  return createHash('sha256').update(stable).digest('hex');
}
