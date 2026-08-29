# Change log: Add per-change log files

- **Date:** 2026-08-29
- **Requested by:** Charan (owner) — explicit request to add a log file
  for every major change going forward, instead of only summarizing
  changes in chat.

## What changed

- Added `docs/logs/` with one markdown log file per major change made so
  far this session (repo wipe, Phase 1 app scaffold, architecture/
  deployment/open-decisions docs), backfilled from git history so nothing
  already shipped is undocumented.
- Added `docs/logs/README.md` as an index.
- Linked `docs/logs/` from the top-level `README.md`.

## Why

Keep a durable, human-readable record of what changed and why inside the
repo itself, rather than only in chat or in commit messages — commit
messages capture the "what" tersely; these logs also capture verification
performed and the reasoning behind non-obvious choices.

## Verification

- All four markdown docs (`README.md`, `docs/architecture.md`,
  `docs/deployment.md`, `docs/open-decisions.md`) confirmed present and
  already pushed to `origin/main` as of this change.
- `git status` reviewed before staging to confirm only the intended new
  files were added.
