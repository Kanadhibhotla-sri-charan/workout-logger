# 2026-08-30 — Docs update: reflect the Next Phase spec's resolved decisions

## Why

`docs/open-decisions.md` and `docs/TRAINING_ENGINE_DESIGN.md` still
described Phase 2's state — six engine modules deliberately throwing
`NotApprovedError`, exposure treated as "provisional Strategy A
pending sign-off," README claiming this app "deliberately does not
include... a full automatic workout generator." None of that has been
true since the workoutBuilder pipeline landed
(`docs/logs/2026-08-30-23-*.md`). Explainability (spec §20) was also
audited as part of this pass: every real engine module already returns
its own `reasoning` field built from the same data the decision used
(exposure contribution, volume decision, recovery signal, frequency
allocation, exercise selection, resource allocation, time-fitting) —
no gap requiring new code, just documentation that hadn't caught up to
say so.

## What changed

- `docs/open-decisions.md` — rewritten. Items 6, 11-17 (indirect
  exposure strategy, hypertrophy volume, recovery methodology,
  frequency allocation, exercise selection ranking, time-per-exercise
  estimation, progression methodology) marked resolved, each pointing
  at the specific `docs/logs/` entry and doc that resolved it. Item 12
  (functional exposure) marked resolved differently than originally
  proposed — by uniform engine treatment across both target types,
  not a separate arithmetic model. Item 10 (goal weighting of
  exposure) marked resolved differently too — priority never
  reweights exposure at all (spec §2.2), it drives resource allocation
  instead. Two new items (18: resource allocation, 19: goal history,
  20: natural-language goal matching) added — spec additions Phase
  2's list never had. Items 1-5 (infrastructure/deployment,
  goal/program hierarchy shape) remain genuinely open, unchanged in
  substance.
- `docs/TRAINING_ENGINE_DESIGN.md` — added a status banner at the top
  pointing to `docs/open-decisions.md` as the current authority;
  corrected the pipeline diagram (§1) and module table (§2) to show
  all thirteen modules real (including the new Resource Allocation
  module Phase 2 never had); corrected the acceptance-criteria
  checklist (§24) item-by-item; corrected the closing sections (§25-27)
  — no longer claims six modules are deliberately blocked.
- `README.md` — dropped the "Phase 1 / 1.5 / 2" title framing and the
  "deliberately does not include... a full automatic workout
  generator" claim (now false); added the real entry point
  (`workoutBuilder.assembleAndBuildWorkout`) and links to
  `docs/VOLUME_ENGINE.md`/`docs/GOAL_MATCHING.md`/
  `docs/SECONDARY_TARGET_MAPPING.md`, which weren't linked before.

No code changed in this commit — verification re-run anyway per
standing practice.

## Verification (actually run)

```
$ npm run verify
tsc --noEmit: clean
vitest run: Test Files 35 passed (35), Tests 297 passed (297)
```

(Unchanged from the previous commit — docs-only change.)

## Still open

The implementation report (spec §26.10: files changed, schema
changes, rules implemented, tests run/passed/failed, genuinely blocked
dependencies) hasn't been written yet — that's next. UI additions
remain explicitly deprioritized by the spec itself ("Do not mark
complete merely because the UI renders").
