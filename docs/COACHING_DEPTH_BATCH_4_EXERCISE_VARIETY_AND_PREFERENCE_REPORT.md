# Implementation Report — Coaching Depth Batch 4 (Exercise Variety & Preference)

Spec: `docs/COACHING_DEPTH_BATCH_4_EXERCISE_VARIETY_AND_PREFERENCE_SPEC.md` — combines roadmap Phase 6a (exercise rotation), Phase 6b (pairing/supersets), and Phase 9 (preference/avoidance), per `docs/COACHING_DEPTH_REMAINING_BATCHES.md`.

## 1. Files changed

**Schema/migration:**
- `src/db/schema.sql` — new `exercise_preferences` table: one row per `(user_id, exercise_id)`, `preference` ∈ `preferred`/`disliked`/`avoided` (CHECK-constrained), optional `temporary_until`/`reason`.
- `src/db/client.ts` — comment noting the table needs no `addColumnIfMissing` calls (brand new, `CREATE TABLE IF NOT EXISTS` is sufficient on both a new and existing database).

**Repository:**
- `src/repositories/exercisePreferencesRepo.ts` (new) — `ExercisePreferencesRepo`: `set`/`remove`/`get`/`listAll`/`listActive`/`effectiveFor`/`effectiveMapFor`. `'neutral'` is never stored, only ever the absence of a live row or an expired `temporary_until` — computed at read time against a real reference date, never wall-clock time read inside the repo (matches this codebase's existing compute-don't-store discipline, e.g. Batch 3's `periodizationState`).

**Selection engine:**
- `src/engine/config.ts` — added `EXERCISE_ROTATION` (`maxConsecutiveUsesBeforeRotationConsidered`, `recentUseWindowExposures`) and `EXERCISE_PAIRING` (`maxCombinedFatigueRank`).
- `src/engine/exerciseSelector.ts` — added `ExercisePreferenceLevel` type, `AllCandidatesAvoidedError`, `sameExerciseFamily()` (uses Blueprint's real `overlaps_with` field, id-to-id, mostly populated — chosen over the free-text `complements` field after direct inspection of `src/blueprint/snapshot/exercises.json` showed `complements` values are descriptive phrases, not exercise ids, and therefore unusable as a lookup). New **Gate 2b** (hard avoidance exclusion, inserted right after Gate 2's goal-relevance filter, before any fallback path) and **Gate 5b** (soft preference ranking, inserted after Gate 5's progression-continuity check, using the existing `narrow()` safe-fallback primitive). Gate 4 (historical/rotation) extended to penalize a same-family exercise, not just an exact id match.
- `src/engine/exercisePairing.ts` (new) — `evaluateSessionPairings()`: antagonist (push/pull) superset pairing for one already-finalized session, using this app's own existing `PUSH_PHYSIQUE_TARGETS`/`PULL_PHYSIQUE_TARGETS` classification (already used by `sessionPurpose.ts`) as the one real antagonist-muscle-group signal — never a fabricated relationship. Gated by combined Blueprint `fatigue_cost` rank; respects avoidance and prefers a non-disliked partner without ever eliminating every candidate.

**Planner integration (`src/engine/workoutBuilder.ts`):**
- `TargetBuildContext` gained an optional `preferences?: ReadonlyMap<BlueprintId, ExercisePreferenceLevel>` field.
- `attemptSelection`'s `selectExercise({...})` call now passes `preference_by_exercise_id: target.preferences`.
- The per-target day-construction `while` loop now wraps `attemptSelection` in a `try`/`catch` for `AllCandidatesAvoidedError` — on catch, the loop breaks for that day rather than crashing generation. A new end-of-run skip category (`scope: 'preference'`, `reason_code: 'all_candidates_avoided'`) reports this distinctly from a Blueprint data gap or an ordinary "not due" decision, so avoidance never gets silently misreported as either.
- `assembleWeeklyPlanInput` resolves this user's active preference rules once (`ExercisePreferencesRepo.listActive`, as of `historyAsOfDate`) and threads the same map into every target's `TargetBuildContext.preferences` — user-level, not target-specific.
- `PlannedWorkItem` gained `paired_with_exercise_id: BlueprintId | null`. `buildWeeklyProgrammingPlan`'s per-day `sessionWork` construction now runs `evaluateSessionPairings()` on that day's final, post-fitting exercise set (pairing only ever operates on already-selected exercises, never influences selection itself) and stamps the result onto each item.

**Explanations:**
- `src/server/friendlyExplanation.ts` — `SkipReasonCode` extended with `'all_candidates_avoided'`; new switch case explains the hard-exclusion fact plainly, distinct from the existing `blueprint_data_integrity` wording (spec: never mean "the target/exercise itself is invalid").

**API (`src/server/routes/programming.ts`):**
- `GET /api/programming/preferences` — every currently-active rule (spec §7 "list active rules").
- `PUT /api/programming/preferences/:exerciseId` — set/replace the rule for one exercise (covers "add/remove preference", "add/remove avoidance", "set/clear temporary exclusion" — all one replace-not-merge operation, matching the repo's own semantics). Validates the exercise id against real Blueprint exercises and approved outside-Blueprint ones.
- `DELETE /api/programming/preferences/:exerciseId` — explicit removal, distinct from letting a temporary rule expire.
- `enrichPlannedWork` now also returns `paired_with_exercise_name` (resolved from `paired_with_exercise_id`) on every `/week` and `/today` planned-work entry.

**Tests (all new, all passing):**
- `tests/engine/coachingDepthBatch4ExerciseVarietyPreference.test.ts` (new, 21 tests) — `ExercisePreferencesRepo` (defaults, round-trip, expiry, replace-not-merge, explicit removal, active-vs-all listing), Gate 2b avoidance (exclusion, hard-throw when every candidate is avoided, avoidance beats progression continuity, no-map behavior unaffected), Gate 5b preference ranking (preferred wins ties, disliked deprioritized never eliminated, never overrides Gate 3's own narrowing), extended Gate 4 family rotation (family-member penalized via `overlaps_with`, current pick still exempt, exact-match behavior preserved), and `exercisePairing` (push/pull pairing formed, no forced pairing when no antagonist exists, unclassified targets never paired, avoided exercises never enter a pair, no double-pairing).
- `tests/routes/programming.test.ts` — 6 new tests for the `/api/programming/preferences` routes (empty list, set-then-list, unknown exercise id rejected, invalid preference value rejected, expired temporary rule excluded, delete-then-list).

## 2. Design decisions

- **Hard avoidance vs soft preference are structurally different gates, not one weighted score.** Gate 2b is a real exclusion (never bypassed by fallback — the spec's "avoided exercises cannot reappear through fallback or pairing" is enforced by construction: an avoided exercise is removed from the candidate pool before any other gate, including the current-exercise/progression-continuity exemption, ever runs). Gate 5b is a ranking nudge using the existing `narrow()` safe-fallback primitive, which by design never empties the candidate pool — a disliked exercise is deprioritized, never excluded.
- **Rotation reuses `overlaps_with`, not `complements`.** Direct inspection of the Blueprint snapshot showed `complements` is free-text ("An anti-rotation movement.") on every one of 123 exercises — unusable as an id-based lookup. `overlaps_with` is mostly populated with real exercise ids and is the one real "these exercises train overlapping territory" signal Blueprint actually encodes.
- **Pairing reuses the existing push/pull physique-target classification, not a new relationship.** The same rationale: rather than inventing a "these two exercises pair well" table with no real backing data, pairing is derived from the antagonist muscle-group classification this codebase already uses elsewhere (`sessionPurpose.ts`), gated by a real Blueprint field (`fatigue_cost`).
- **Rotation depth is derived, never a new persisted table.** An `exercise_rotation_state` table was drafted and then removed — every rotation decision Gate 4 needs (recent exercise ids, recency, family membership) is already available from `TargetBuildContext.recent_exercise_ids`/`exercise_history`, gathered from real `workout_sessions`/`exercise_history`. Persisting a parallel rotation-cooldown table would have created a second source of truth for something fully derivable from data already loaded every generation run.
- **Preferences are user-level, not target-level**, even though `TargetBuildContext.preferences` is a per-target field (chosen to keep the interface uniform with every other per-target field) — `assembleWeeklyPlanInput` resolves the map once and reuses the identical reference for every target.

## 3. Tests run

```
npm run typecheck   → clean
npm run build       → clean
npx vitest run tests/engine/coachingDepthBatch4ExerciseVarietyPreference.test.ts tests/routes/programming.test.ts
                     → 21 + 25 passing (6 new route tests among them)
npm test -- --run (full suite) → 133 test files: 119 passed, 14 failed
                                   1609 tests: 1378 passed, 231 failed
```

The failing-test-name list was diffed against the same established baseline used for every prior batch in this session (`diff /tmp/final_fail_tests.txt <current>` → identical, zero lines of difference) — **zero new failures**. All 14 failing files are the same pre-existing, unrelated date-drift fixture issue documented in `COACHING_DEPTH_BATCH_1_IMPLEMENTATION_REPORT.md` §9 (fixtures hardcode dates that are now in the past relative to the session's current date).

## 4. Known limitations

- **No UI was built.** The spec's UI requirements (§7 "The UI should let users manage preferences clearly...") are exposed only via the new JSON routes (`GET`/`PUT`/`DELETE /api/programming/preferences`) — nothing in `public/` renders a preference-management page yet. This is an explicit scope reduction under this batch's own time constraints, matching Batch 3's precedent for its own UI gap.
- **No dedicated "explain why an exercise was selected/excluded/rotated/left unpaired" route was added.** Every fact spec §7/§10 asks to expose already exists in machine-readable form (`ExerciseSelectionResult.reasoning`/`rejected_candidates`/`avoided_candidates`/`decisive_gate`, `ExercisePairingResult.reasoning`) and pairing is now surfaced through `/week`/`/today` (`paired_with_exercise_id`/`paired_with_exercise_name`), but a standalone explanation endpoint for arbitrary past selections was not built.
- **Cooldown behavior for rotation is governed by the existing recency-based Gate 4 penalty, not a separately configurable cooldown window.** `EXERCISE_ROTATION` config constants (`maxConsecutiveUsesBeforeRotationConsidered`, `recentUseWindowExposures`) are defined for a future tunable cooldown but are not yet read anywhere — Gate 4's existing `recent_exercise_ids` recency check (now family-aware) is what actually drives rotation in this batch.
