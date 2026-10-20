# Body measurements on the Goals page

**Commit:** `642864d` (2026-10-12). Details: decision log §19
([link](../AI_GENERATION_REDESIGN_DECISION_LOG.md)).

- Goals page "Body measurements" form and cards; presets with a
  better-direction (higher/lower) and validation; delete route.
- `GET /measurements/summary`; Insights and the goal-phase review read
  trends direction-aware (neutral metrics skipped); coach facts rule 5c.
- Test: `tests/goals/bodyMeasurements.test.ts`. Deployed 2026-10-12 with
  a pre-deploy backup.
