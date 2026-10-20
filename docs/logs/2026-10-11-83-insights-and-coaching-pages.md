# Insights and Coaching pages

**Commits:** `3672ad0`, `af95186` (2026-10-11). Details: decision log
§13 ([link](../AI_GENERATION_REDESIGN_DECISION_LOG.md)).

- Insights (`GET /api/insights`): strength per exercise (best set as
  est. 1RM, deload sessions excluded), weekly volume done vs required,
  consistency, goal check-ins, deload history.
- Coaching: a weekly AI coach review written from those facts (one paid
  call on request), strictly checked; plateau advice to accept or
  dismiss; an accepted swap sets 14-day avoid/prefer rules. Exercise
  preferences and training experience moved under Profile.
- Fixes: a reactive-deload exercise must also end lower to count as
  down; AI generation honours exercise preferences (avoided never
  prescribed).
- `af95186`: reactive deloads that turned out to be false alarms are
  marked as such in Insights and in the coach review's facts.
