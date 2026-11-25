# Opus coach: how it works and where everything lives

Start here when changing anything about the daily coach. Detailed history
is in docs/logs 112 to 116 (and later).

## What it is
- A Claude Code cloud **routine** (Opus 5.5) plans each gym day at
  **08:00 IST (02:30 UTC)**. It replaced the in-app Qwen programmer
  (qwen3-next-80b-a3b-instruct via Velona) on 2026-11-22.
- The Qwen pipeline ("Generate with AI") stays as a **frozen fallback**. The
  only changes allowed there are for reading the day toggle and its add-on picks.
- The owner approves every session in the app (Program page, coach section).

## The brief = the rules
- `.claude/skills/opus-coach/SKILL.md` is the coach's whole brief: priorities,
  day types, leg add-ons, hard limits, the run steps and the save format.
- Coaching rules live **only in the brief, never in code**. The owner's view:
  Opus beats coded checks. The save endpoint refuses only two things: an
  exercise that isn't in the library, and training an injury-paused area. It
  allows up to 3 retries.
- The routine reads the skill from `main` on every run. **A brief change takes
  effect at the next run without a server deploy.**
- An older copy of the brief exists as a Claude Doc (owner review copy,
  https://claude.ai/artifact/GsigHEndCjyef14dyvBdY4). It isn't kept in sync;
  the repo file is the source of truth.

## Routine
- Trigger id `trig_01X7nxrZ1fS6aTryq51iZtZZ`, cron `30 2 * * *` UTC, model
  Opus 5.5. Repos: workout-logger and the food tracker repo (it reads food).
- Cloud environment "workout-coach": limited network, allowed host
  logyourlifts.duckdns.org. Its network secret is the header
  `Bearer <COACH_API_TOKEN>`, and the prefix "Bearer" is required.
- The run sessions are cloud sessions. They are visible at
  claude.ai/code/routines in a browser, not in the mobile app's Code tab.

## App side (src/coach/, src/server/routes/coach.ts)
| Endpoint | Who | What |
|---|---|---|
| GET /api/coach/context?date= | routine (Bearer token) | raw data: profile, week, goals, weekly targets, 42 days of sessions, proposals, day notes, measurements, decisions, library |
| POST /api/coach/proposals | routine | save the day's plan + decision log entries |
| POST /api/coach/runs | routine | record "no_run_needed" / "failed" |
| GET /api/coach/day?date= | app | toggle, add-on parts, last run, proposal |
| PUT /api/coach/day-request | app | `{date, mode: 'full'\|'add_ons'\|null, parts?}` |

- Token: `COACH_API_TOKEN` in `~/.config/workout-logger/coach.env` on the VM
  (drop-in coach.conf). Without it the endpoints return 503. "Re-run coach"
  uses `COACH_RERUN_URL` / `COACH_RERUN_TOKEN` from the same file.
- nginx basic auth protects everything except /api/health and
  /api/coach/{context,proposals,runs}, which the app checks by token.

## Data the coach reads (context fields worth knowing)
- `dayRequest`: `full` = session only, `add_ons` = session + leg add-ons,
  `null` = coach decides.
- `dayAddOnParts`: the parts the owner ticked (resilience, conditioning,
  mobility, flexibility). Empty unless the day is add_ons.
- Sessions: planned vs logged sets. From 2026-11-24 each set has `loggedAt`
  (the time it was first saved), each exercise has `firstLoggedAt` and an
  optional `note`, and each session has `performedOrder`.
  - Before 24 Nov the stored order is the planned order. Those sessions
    were actually done big muscles first and arms last.
- `proposals`: the coach's and Qwen's plans, with the owner's discard reasons.
- `decisions`: the coach's own decision log, with success checks and check dates.

## Owner rules (don't relitigate)
- Gym on Mon, Tue, Thu and Fri. Wednesday rest is fixed. Badminton on Sat and
  Sun. Only the owner moves a day, by setting a toggle on that day.
- Growth of the goal muscles comes first (triceps, especially the long head,
  and brachialis). Weekly numbers are targets. Any row more than 2 sets over
  or under needs a reason.
- The leg work and add-ons exist for **badminton-fit legs**: preventing
  injury and getting physically better at badminton. They are not for leg
  size. The add-on has 4 parts. Calf raise, Copenhagen plank and hip
  abduction are extras and never stand in for a part.
- Plans run 75 to 90 minutes. Equipment and time are not checked; the owner
  swaps exercises in the gym.
- Prod deploys and prod data changes need the owner's explicit go-ahead.
  Secrets never go through chat.

## Deploy (Oracle VM, after the owner says "deploy")
```bash
ssh -i <key> ubuntu@68.233.97.63
cd ~/workout-logger
SHA=$(git rev-parse --short origin/main) # after git fetch
sqlite3 data/workout-logger.sqlite ".backup deployment-backups/pre-$SHA-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
sqlite3 deployment-backups/<that file> "PRAGMA integrity_check;"   # must say ok
git fetch && git checkout -B main origin/main
npm ci && npm run build
sudo systemctl restart workout-logger
curl -s localhost:3000/api/health
```
The migrations in src/db/client.ts run on start. They only add columns,
which is safe on the live database. Mark the deploy in the log's Status line.

## Current state
- Live on the VM: 79a01f3 (deployed 2026-11-25 05:06 UTC). It includes set times,
  exercise notes and add-on part ticks (logs 115, 116).
- To check what's live: `git log --oneline -1` in ~/workout-logger on the VM.

## Open items
- Shadow week from 23 Nov 2026. Report on Fri 27 Nov: run reliability,
  planned vs logged, sets vs targets, reason quality. Recommended: judge
  Opus alone, without the owner pressing Qwen daily (2026-11-24 offline
  test: Qwen with the same brief was far worse; see log 115 / memory).
- The target load and cue are not shown in the logger after a session is
  committed. Not done yet.
