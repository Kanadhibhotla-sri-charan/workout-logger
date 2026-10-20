# Explicit week generation and the malformed-date crash fix

**Commits (2026-10-01):** `d39837a`, `5cc0348`, `5332ef1`. Decisions
D1–D7, concurrency and failure handling: decision log §6–§7
([link](../AI_GENERATION_REDESIGN_DECISION_LOG.md)); walkthrough: `docs/HANDOFF_LAST_3_COMMITS.md`.

## What changed
- `d39837a`: a malformed `?date=` (a scraper requesting the unexpanded
  `${session.date}` template) threw before the route's try block and
  exited the production process eight times on 2026-09-30/10-01. Both
  routes now answer 400.
- `5cc0348`: with `AI_WEEK_GENERATION_MODE=explicit`, `GET /week` and
  `/today` are pure reads; `POST /api/ai-programmer/generate-week` creates
  per-day pending proposals for the remaining gym days through the
  planned pipeline, with a durable per-week run guard, heartbeat and
  stale-run recovery, and provider backoff.
- `5332ef1`: "Generate this week's AI sessions" on the program page,
  driven by the backend's generation state, with per-day status.

## Production
Enabled via the drop-in `week-generation.conf`.
