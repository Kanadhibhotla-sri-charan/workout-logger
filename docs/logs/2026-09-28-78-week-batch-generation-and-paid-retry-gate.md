# Week batch generation, completion contention and the paid-retry gate

**Commits (2026-09-28):** `ab8c1dc`, `46bf7f3`, `26459e2`, `1d38287`,
`c8bc353`. Details: decision log §2–§3 ([link](../AI_GENERATION_REDESIGN_DECISION_LOG.md)).

## What changed
- `ab8c1dc`: three real error codes were missing from the UI's message
  table (so the user saw "something went wrong"); added. New "Generate AI
  proposals for the week" button (client-side orchestration, replaced on
  2026-10-01 by log 80).
- `46bf7f3`: the week batch skips non-gym days and gym days with no
  session purpose (those were bound to fail adequacy).
- `26459e2`: deterministic completion schedules the most constrained
  target first, so one target no longer takes the only candidate another
  needs (live Pull case: lat width took chest-supported-row from back
  thickness).
- `1d38287`: a quality failure (truncation/schema/domain/adequacy) is
  remembered per targetDate + contextHash; an identical retry is refused
  with `AI_GENERATION_PREVIOUSLY_FAILED` unless `confirmRetry: true` ("Try
  again anyway"). Provider failures are never remembered.
- `c8bc353`: feasibility and completion only count exercises that
  actually credit the target (fixed brachialis/curl and calf mismatches).
