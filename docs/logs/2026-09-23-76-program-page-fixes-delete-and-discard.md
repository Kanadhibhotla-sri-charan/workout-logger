# Program page fixes: stale proposals, previews, delete/discard, focus picker

**Commits (2026-09-23):** `bb113b2`, `b688932`, `103f3da`, `71bac75`,
`d32f8e8`, `77e0f8a`, `77612a3` (each merged separately).

## What changed and why
- `bb113b2`: after a schedule swap moved an AI-committed session, the old
  day still showed the committed proposal ("seeing both programs").
  Proposal/reconciliation discovery now ignores a committed record whose
  session moved or was deleted. Read-time fix, no data migration.
- `b688932`: a day with a real superseding session shows a read-only
  preview of its exercises (from `GET /api/workouts/:id`), so the user
  can see what blocks a new commit.
- `103f3da`: `DELETE /api/workouts/:id` (planned sessions only; 409
  otherwise, so real history is never deleted), and reject routes for
  pending/approved proposals and reconciliations. The program page
  offers "Delete existing workout" / "Discard" when a day is blocked, and
  shows each exercise's AI rationale in the preview.
- `71bac75`: a rejected/expired proposal no longer renders its old
  exercise list. New optional `requestedSessionPurpose`
  (push/pull/legs/upper) with a "What should {Weekday} focus on?" picker,
  validated by the route and enforced by the existing validators.
- `d32f8e8`: "Whole-physique development — undefined." Reconciliation
  commits wrote non-target day snapshots without exercise/target names;
  `toSnapshot()` now resolves them. Production data repair (DB backed up
  first): the two affected `program_sessions` rows got their names
  backfilled; rationale left absent rather than invented.
- `77e0f8a`: `DELETE /api/programming/week/days/:day/plan` removes a
  day's persisted plan (guarded by `isDayLocked`), so every visible
  program has a delete path.
- `77612a3`: day modal visual hierarchy (presentation only): one
  container for day details, boxed proposal section, delete/discard
  buttons as subordinate "ghost" buttons.

## Verified
Each commit: typecheck/build clean, new tests added (proposal discovery
after a move, preview, delete/reject routes, picker, snapshot names,
plan delete), full suite at the same baseline.
