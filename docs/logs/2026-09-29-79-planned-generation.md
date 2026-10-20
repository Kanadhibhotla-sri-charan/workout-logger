# Planned generation: SessionPlan, plan conformance, planned context

**Commits:** `9128d8d`, `a99886d`, `899f872` (2026-09-28/29). Full
design, evaluation and rollout: decision log §3–§6 ([link](../AI_GENERATION_REDESIGN_DECISION_LOG.md)).

## What changed
- `9128d8d`: bounded structured log record for every rejected
  generation; `planSession(context)`, a pure deterministic plan (per-target
  status, floors, legal maximum, credited candidates, reserved slots), run
  in shadow mode.
- `a99886d`: with `AI_PLANNED_GENERATION_ENABLED=true` the AI receives a
  compact plan context (~16–22k chars instead of ~128k) and a plan-aware
  instruction; one shared post-provider pipeline with plan conformance
  before the unchanged repair/domain/completion/adequacy stages.
- `899f872`: conformance rule 3 only removes an optional target when it
  actually frees capacity and no goal, identity minimum or region is
  lost; shared-credit groups shown as one joint allocation.

## Production
Enabled on 2026-09-29 via the systemd drop-in `planned-generation.conf`
(decision log §9).
