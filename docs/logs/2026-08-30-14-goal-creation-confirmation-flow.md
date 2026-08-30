# 2026-08-30 — Natural-language + structured goal creation, with mandatory explicit confirmation

## Why

Spec §2.1: goal creation must be hybrid (natural-language text or
structured browse-and-pick), but **never silently activate an inferred
goal** — the user must explicitly confirm before anything is persisted.
Spec §20-21: core programming needs no LLM/API call and must be fully
deterministic.

## What changed

- `src/blueprint/types.ts` — `BlueprintAestheticOutcome` gained
  `common_user_phrasings: string[]`. This field was already present in
  the vendored snapshot (verified directly:
  `src/blueprint/snapshot/programming.json`, all 26 aesthetic outcomes
  have a non-empty array) but wasn't declared on the type, so nothing
  in the app could use it yet.
- `src/engine/goalCreation.ts` (new, pure — no DB access) —
  `matchGoalCandidates(text: string): GoalMatchCandidate[]`. Normalizes
  text (lowercase, strip punctuation, drop a small stopword list),
  scores it against each Blueprint aesthetic outcome's
  `common_user_phrasings`/`display_name` and each functional goal's
  `name`/`definition` via Dice coefficient over token sets, returns
  ranked, score-and-source-attributed candidates. Deterministic: same
  input always produces the same output, no network or LLM call
  anywhere in the path.
- `src/engine/config.ts` — new `GOAL_MATCH` config (`minScore: 0.2`,
  `maxCandidates: 5`, both `[DEFAULT]` — text-matching operational
  defaults, not training methodology numbers, but centralized per
  spec §22 anyway).
- `src/server/routes/goals.ts` — new `POST /api/goals/match { text }`
  (read-only, returns candidates, persists nothing). `POST /api/goals`
  extended to accept `review_cadence_days`, `source`, `source_text`;
  rejects `source: 'natural_language'` unless `source_text` is a
  non-empty string, so a natural-language-originated goal can never be
  persisted without its original statement attached.
- `docs/GOAL_MATCHING.md` (new) — documents the Blueprint data
  asymmetry (aesthetic outcomes have ready phrasings, functional goals
  don't), the exact scoring algorithm, and the two-step confirmation
  flow: matching is informational only; only an explicit `POST
  /api/goals` call with a chosen `blueprint_ref` creates anything.

## Why confirmation is structural, not just a UI convention

`matchGoalCandidates` takes no database handle — it is architecturally
incapable of persisting a goal, not just conventionally discouraged
from doing so. The only path to a persisted `Goal` row is
`GoalsRepo.create()`, which already required an explicit
`blueprint_ref` before this change; the goal-matching endpoint just
helps the user find candidate values for that same required field, and
now carries the `source`/`source_text` provenance so a
natural-language-derived goal is later distinguishable from a
structured pick.

## Tests

`tests/engine/goalCreation.test.ts` (10 tests): a real
`common_user_phrasings` entry ranks its own outcome first;
returned candidates all meet `GOAL_MATCH.minScore`; candidate count is
capped; unrelated/empty text returns `[]` (not an error); a functional
goal is matchable via name text; matching alone never creates a goal
(list stays empty); an explicit `create()` call with `source:
'natural_language'` persists `source`/`source_text` correctly; the
pre-existing structured path still defaults `source` to `'structured'`
with `source_text: null`.

## Verification (actually run)

```
$ npm run verify
tsc --noEmit: clean
vitest run: Test Files 26 passed (26), Tests 187 passed (187)
```

(177 tests before this batch; 187 after adding
`tests/engine/goalCreation.test.ts`'s 10 tests — no regressions.)

## Still open

- No UI for the goal-creation flow yet (text box → candidate list →
  confirm) — tracked separately, explicitly deprioritized by the spec
  itself.
- `matchGoalCandidates` is deliberately simple (token-overlap scoring).
  It is not a substitute for the user reading and picking — a low- or
  zero-candidate result for an oddly-phrased goal is expected, and the
  structured browse-and-pick path remains fully available as the
  fallback.
