# 114 — Opus coach: routine skill file and Re-run trigger headers

Date: 2026-11-22 · Status: built, not deployed

## What
- `.claude/skills/opus-coach/SKILL.md`: the coaching brief the lifter
  approved on 2026-11-22 (Claude Doc "Opus Coach — Coaching Brief"), plus
  the app API (context, proposals, runs) and how to read food data from the
  food tracker repo (read-only). The cloud routine clones this repo and
  follows the skill.
- Owner decisions in the brief: Wednesday rest is fixed and only the lifter
  moves a day (by setting that day's toggle); missed sets may be made up;
  plan 75-90 minutes; only the lifter changes goals, and the coach reads goal
  numbers from the app each run.
- Re-run: POST /api/coach/rerun now sends `anthropic-version: 2023-06-01`
  (required by the routine API trigger, POST
  https://api.anthropic.com/v1/claude_code/routines/{trig_id}/fire) and the
  experimental beta header. Test added.

## Secrets
- The routine gets the coach token as a cloud-environment network secret
  (Bearer, allowed host logyourlifts.duckdns.org): the proxy adds it, the
  token never enters the run.
- The Re-run trigger token is created by the owner in the routine's web
  settings and stored on the server as COACH_RERUN_URL / COACH_RERUN_TOKEN.

## Follow-up (2026-11-22, after the first run)
- Deployed 271c26a 15:36 UTC; first successful run planned Mon 23 Nov.
- The run planned mid-chest 4 sets over target with no reason. Owner:
  going over is fine, the missing reason is the problem. The skill now
  says over counts too, and the Check step reviews the weekly table row
  by row before saving. Effective at the next run (the routine reads the
  skill from main); no app deploy needed.
