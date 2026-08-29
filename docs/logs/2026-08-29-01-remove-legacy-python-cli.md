# Change log: Remove legacy Python CLI workout logger

- **Date:** 2026-08-29
- **Commit:** `acc478a749dba8da04173a78fa7b3f7ece2040ef`
- **Requested by:** Charan (owner), via explicit "wipe this repo completely
  and start from scratch" instruction.

## What changed

Removed the entire pre-existing repo tree: a Python/Flask CLI + web tool
("Smart Workout Logger & Analyzer") with Gemini-based AI parsing, a SQLite
database file, and its Render.com deployment guide.

Files removed (43 total): `README.md`, `DEPLOY.md`, `fix_exercises.py`,
`requirements.txt`, `run.bat`, `run_web.bat`, `sql/schema.sql`, the full
`src/` tree (`main.py`, `models/`, `services/`, `web/`, cached `.pyc`
files), `tests/`, and `workout_logger.db`.

## Why

The repo was pivoting to a new, unrelated app ("Workout Programmer") and
the old content had no further use. Done as a normal `git rm` + commit
rather than a history rewrite/force-push, so it stays revertable — the old
app's full history is still reachable at earlier commits on `main`.

## Verification

- `git status` clean after commit; nothing untracked left behind.
- No destructive git operations used (no `reset --hard`, no force-push);
  pushed with a normal `git push -u origin main`.
