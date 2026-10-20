# Wide exercise pool, injury pause, day notes and deload fixes

**Commits:** `7a94cc2`, `12eafbc` (2026-10-11). Details: decision log
§10–§12 ([link](../AI_GENERATION_REDESIGN_DECISION_LOG.md)).

## What changed
- `AI_EXERCISE_POOL_MODE=wide` (planned generation only): every Blueprint
  primary-target exercise is a candidate; packages supply volume numbers
  only. Per-target rotation shortlist (cap 4) keeps the recent compound
  as anchor and rests accessories used in both of the last two same-type
  sessions. Session identity counted in distinct muscle groups.
- Injury pause (`injury_pauses`): paused areas are never planned and
  exercises crediting them are dropped. "Other" day notes (`day_notes`)
  are read by the model as recovery evidence. Goals panel works in
  explicit week mode.
- Deload fixes (owner-approved): the reactive trigger compares each
  exercise with itself over 3+ sessions and ignores deload weeks; a
  deload is applied once (not 50% of an already-halved number); a
  reactive deload can be ended early from Insights.

## Production
Deployed 2026-10-11 with a pre-deploy DB backup; `AI_EXERCISE_POOL_MODE=wide`
drop-in. `12eafbc` records that deploy.
