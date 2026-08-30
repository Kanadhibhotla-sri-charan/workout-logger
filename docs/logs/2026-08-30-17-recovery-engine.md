# 2026-08-30 — Recovery engine: conservative same-day gate, badminton-aware

## Why

Spec §12: declining performance / poor recovery must be inspected
before any automatic reduction. Spec §15: badminton workload must feed
combined training-load/recovery decisions, but never get converted
into a fake hypertrophy-set equivalent. `recoveryEngine.ts` previously
threw `NotApprovedError` for lacking an approved training-readiness
rule.

## What changed

`src/engine/recoveryEngine.ts` (rewritten, real implementation) —
`applyRecoveryConstraint()` returns `'none' | 'reduce' | 'avoid'` from
three deterministic, already-configured signals, never inventing a new
number:

1. **Same-day repeat** — `days_since_target_last_trained === 0` →
   `'avoid'` outright (overrides everything else).
2. **Exposure spike** — this week's exposure_units for the target
   exceeds `RECOVERY_THRESHOLDS.recentHighExposureMultiplier` (already
   in `src/engine/config.ts`, unchanged) times the rolling-window
   average weekly rate → `'reduce'`. Skipped entirely when there's no
   rolling baseline yet (`rolling_exposure_units === 0`) to avoid a
   false positive on a cold start.
3. **Heavy recent badminton** — a `RecentBadmintonSignal` (the raw
   logged `intensity`/`post_session_fatigue` fields, nothing derived)
   with `intensity === 'high'` or `post_session_fatigue >= 4` →
   `'reduce'`. This consumes badminton's actual logged categorical
   data directly — no conversion formula, no set-equivalent, per §15.

Multiple `'reduce'` triggers combine into one result whose `reasoning`
cites every signal that fired (spec §20: no opaque score). This module
only ever returns a same-day *priority adjustment* — it never decides
to reduce a weekly volume target by itself; that composition (§12's
full "inspect, then pick a modification" flow) is `volumeEngine`'s job,
consuming this result as one input among several.

`tests/engine/unapprovedStubs.test.ts` — dropped `recoveryEngine`'s
now-false "throws NotApprovedError" case.

## Tests

`tests/engine/recoveryEngine.test.ts` (9 tests): no signal → `none`;
same-day repeat → `avoid` regardless of other inputs; a real exposure
spike (computed against `RECOVERY_THRESHOLDS.recentHighExposureMultiplier`)
→ `reduce`; no rolling baseline → no false-positive spike; high-intensity
badminton → `reduce`; low-intensity-but-high-fatigue badminton →
`reduce`; light/low-fatigue badminton → `none`; the result carries no
`exposure_units`/`effective_sets` field (badminton is never converted
into one); both a spike and heavy badminton co-occurring both get
cited in `reasoning`.

## Verification (actually run)

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  29 passed (29)
      Tests  211 passed (211)
```

(203 tests before this batch; 211 after adding
`tests/engine/recoveryEngine.test.ts`'s 9 tests, minus 1 removed from
`unapprovedStubs.test.ts` — no regressions.)

## Still open

`volumeEngine`, `frequencyEngine`, `exerciseSelector`, and
`workoutBuilder` remain stubs. `volumeEngine` is next — it will
consume this module's `priority_adjustment` as its "recovery ok?"
input, per spec §12's own composition (recovery is one input to the
volume decision, not a decision by itself).
