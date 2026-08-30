# Natural-language goal matching

## Why this document exists

Spec §2.1 requires a hybrid (natural-language + structured) goal
creation flow, with one hard rule: **the system must never silently
activate an inferred goal — the user must explicitly confirm before a
goal becomes active.** Spec §20-21 additionally requires core
programming to need no LLM/API call and to be fully deterministic and
reproducible from stored inputs.

This document describes how `src/engine/goalCreation.ts` satisfies
both: a small, deterministic, dependency-free text-matching function,
paired with a two-step API flow that makes confirmation structurally
unavoidable rather than merely a UI convention.

## What Blueprint actually gives us to match against

Verified directly against the vendored snapshot
(`src/blueprint/snapshot/programming.json`), not assumed:

- **Aesthetic outcomes** (26 total) each carry a
  `common_user_phrasings: string[]` field — example sentences written
  for exactly this purpose, e.g. for `chest-side-projection`:
  ```json
  "common_user_phrasings": [
    "My chest looks flat from the side.",
    "My chest doesn't stick out enough.",
    "My chest has no depth."
  ]
  ```
  This field existed in the raw data but was **not** declared on
  `BlueprintAestheticOutcome` in `src/blueprint/types.ts` — it has now
  been added there (a real, stable field this app was simply not
  exposing yet, not a new Blueprint capability).

- **Functional goals** (7 total) have **no equivalent field** — only
  `id`, `name`, `parent_region`, `definition`, `why_it_matters`. There
  is nothing resembling example user phrasing to match against.

This asymmetry is a genuine Blueprint data-coverage gap (parallel to
the one documented in `docs/SECONDARY_TARGET_MAPPING.md` for exercise
secondary targets), not something this app invents around: functional
goals are matched against `name` + `definition` instead, which is
sparser, more clinical text than the aesthetic phrasings, so functional
matches are structurally lower-confidence. `matchGoalCandidates` does
not pretend otherwise — it just runs the same scoring function against
whatever text each Blueprint type actually provides.

## The matching algorithm (deterministic, no external calls)

1. Normalize text: lowercase, strip punctuation, split on whitespace,
   drop a small fixed stopword list (`my`, `the`, `is`, `have`, …) and
   single-character tokens.
2. For each Blueprint aesthetic outcome, score the input against
   `display_name` and every `common_user_phrasings` entry; for each
   functional goal, score against `name` and `definition`. The score is
   the [Dice coefficient](https://en.wikipedia.org/wiki/S%C3%B8rensen%E2%80%93Dice_coefficient)
   between the two normalized token sets: `2·|A∩B| / (|A|+|B|)`. The
   best-scoring text for a goal becomes that candidate's `matched_on`,
   shown back to the user (spec §20: no opaque scores).
3. Keep candidates scoring at or above `GOAL_MATCH.minScore` (0.2,
   `[DEFAULT]` — see `src/engine/config.ts`), sort descending, cap at
   `GOAL_MATCH.maxCandidates` (5, `[DEFAULT]`).

Same input always produces the same output; nothing here is fuzzy in
the sense of non-reproducible — it is exact, exposed arithmetic over
Blueprint's own text.

`matchGoalCandidates(text: string)` takes no database handle and
performs no writes — it is a pure read against the in-memory Blueprint
snapshot, so calling it can never itself create a goal.

## The confirmation flow

1. `POST /api/goals/match { text }` → `{ candidates: GoalMatchCandidate[] }`.
   Purely informational; persists nothing. An empty array is an
   expected, non-error outcome for vague or unmatched text — the caller
   falls back to the structured (browse Blueprint, pick directly) path,
   which already existed before this change.
2. The user reviews the ranked candidates (each with `display_name`,
   `score`, and `matched_on` for explainability) and explicitly picks
   one, or none.
3. Only an explicit `POST /api/goals` call — naming the chosen
   `blueprint_ref` and, for a natural-language-originated pick,
   `source: 'natural_language'` plus the original `source_text` —
   actually creates the goal, via the same `GoalsRepo.create()` used by
   the structured path (spec §1.2 active-aesthetic-goal cap and all
   other invariants apply identically either way). The route rejects
   `source: 'natural_language'` without a non-empty `source_text`, so a
   natural-language-sourced goal can never be persisted without its
   original statement attached for later review.

Nothing between step 1 and step 3 is automatic. There is no code path
by which text alone becomes an active goal.
