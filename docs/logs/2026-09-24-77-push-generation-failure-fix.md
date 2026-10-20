# Push generation failure: diagnosis and architectural fix

**Commits:** `b80d2a5`, `84a06a1`, `eec36e1` (2026-09-23), `c1454a2`
(2026-09-24, merged in `f531001`).

## Diagnosis (`b80d2a5`, `84a06a1`)
- Purpose picker lifecycle: it was hidden for rejected/expired proposals;
  now shown for any fresh generation opportunity.
- Real Push requests were traced end to end: repair clamps every exercise
  to its Blueprint per-exposure ceiling before adequacy runs, so a target
  whose floor needs several exercises (triceps 7 sets, obliques 8) fails
  when the model lists only one. The adequacy validator was right; the
  regression test was corrected to assert the traced mechanism.
- `aiApi()` logs the backend's real `{code, message, details}`.

## Fix
- `eec36e1` (prompt): shared-credit rule added to `generate_session`;
  rule 12(6) allows as many exercises as needed to reach a muscle's
  minimum instead of exactly one more.
- `c1454a2` (architecture): adequacy credits sets to every target the
  Blueprint sub-target scope says an exercise trains (`sharedCredit.ts`);
  deterministic feasibility per target (`targetFeasibility.ts`);
  deterministic completion between domain and adequacy validation
  (`programmerAdequacyCompletion.ts`), adding only the minimum feasible
  coverage; repair trims each target's aggregate credited sets to its
  per-exposure cap.

## Verified
Repeated real-provider runs for Push/Pull/Upper/Legs before commit;
245-failure date-rot baseline unchanged (by failing-test-name diff).
