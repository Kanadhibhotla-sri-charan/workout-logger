# 2026-09-23 — Fix compatibleSessions collapsing to 0 for a genuinely blank week

Follow-up to log 71's fresh-slate validation, which incidentally confirmed a real, previously-flagged issue (production-impact review, log 69, item 4c) with a concrete example: `deliverable: 0` for both `triceps` and `triceps-long-head` in all 3 live runs against a genuinely blank future week, purely because `context.existingProgram`'s pre-reconciliation snapshot had `sessionPurpose: null` on every day. `weekAdequacy.ok: true` in that run therefore proved nothing — the requirement had collapsed to 0, not been met.

Scope, per explicit instruction: fix only this accounting issue. No change to the parent/sub-target prompt, the model's programming rules, or Blueprint volume philosophy.

## The fix

`src/ai-programmer/validation/weeklyVolumeAudit.ts`, `auditWeeklyVolume`:

- `AuditWeek`'s day/session shape gained an optional `sessionPurpose?: string | null` field.
- `compatibleSessions` now resolves each day's purpose as: the audited `week`'s own day `session.sessionPurpose` when present, falling back to `context.existingProgram`'s (pre-reconciliation) purpose only when the audited week says nothing about that day.

Rationale: the function already has two sources of day-purpose information — the pre-reconciliation snapshot (`context.existingProgram`) and the actual week being audited (`week`, the same object it already reads exercises from for crediting). It was using only the stale one for `compatibleSessions` while using the real one for exercise credit. The audited `week` is the real, current source of truth for what a day is actually being programmed as — a blank pre-reconciliation snapshot is not proof a day can't deliver volume; it's just proof nothing had been decided yet.

This is a minimal, backward-compatible change: `sessionPurpose` is optional on `AuditWeek`, so every existing test fixture that never set it (the entire pre-existing test file, and the single-session repair test's `week()`/`weekOutput()` helpers) keeps behaving byte-for-byte as before — the new lookup finds nothing and falls through to the old `existingProgram`-only behavior automatically. The one real production caller, `completeGoalVolume` (`programmerProposalRepair.ts`), already passes `{ days: current }` where each day's `session.sessionPurpose` is the real, final value from the model's own output — no change needed there at all.

## Tests

`tests/ai-programmer/weeklyVolumeAudit.test.ts`, new describe block `auditWeeklyVolume — compatibleSessions reflects the week actually being audited, not a stale pre-reconciliation snapshot`:

1. A blank future week (`existingProgram` has `sessionPurpose: null` on every day) whose audited `week` itself has two real push-purpose sessions — asserts `compatibleSessions: 2` and `deliverable` equal to the full package reference (24 for triceps), not 0.
2. Every pre-existing test's own shape (a week with no `sessionPurpose` on its days at all) — asserts the fallback to `existingProgram`'s purpose still works exactly as before.

Run: `npx vitest run tests/ai-programmer/weeklyVolumeAudit.test.ts` -> 25/25 passed (23 pre-existing + 2 new), all pre-existing assertions unchanged. `npx vitest run tests/ai-programmer/weeklyVolumeAudit.test.ts tests/ai-programmer/programmerProposalRepair.test.ts` -> 44/44 (confirms `completeGoalVolume`'s own tests, which do set real `sessionPurpose` on their fixture days, are unaffected). `npm run typecheck` and `npm run build` -> clean. Full suite: 232 failed / 1570 passed (was 1568) — identical pre-existing date-rot failures, zero regressions, 2 new passing tests.
