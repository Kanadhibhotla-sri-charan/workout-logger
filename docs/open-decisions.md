# Open decisions

Phase 1/1.5/2 deliberately picked pragmatic defaults, built provisional
implementations, or wrote up proposals rather than silently deciding
things for good. The "Next Phase Implementation Specification"
(`docs/logs/2026-08-30-13-*.md` through `2026-08-30-24-*.md`) then
resolved the large majority of what Phase 2 had left open — with exact
numbers in most cases, or by pointing at real Blueprint data
(`globalPrinciples`, `developmentPackages`) this app hadn't been
reading yet. What's left below is genuinely still open: infrastructure/
deployment decisions outside this spec's scope, plus a small number of
narrower methodology questions the Next Phase spec didn't cover.

Status legend: **OPEN** (nothing proposed or implemented yet),
**PROPOSED** (a specific rule is written up for review, no code
implements it), **IMPLEMENTED** (real, tested code exists, grounded
either in an exact spec-given number or in real Blueprint data — not a
placeholder), **IMPLEMENTED — PROVISIONAL** (real, tested code exists,
but on this app's own `[DEFAULT]` operational choice rather than a
spec-mandated or Blueprint-given number — see `src/engine/config.ts`'s
`[SPEC]`/`[DEFAULT]` tagging convention).

## Infrastructure (unchanged — outside the Next Phase spec's scope)

1. **Final storage/DB choice.** [OPEN] SQLite (better-sqlite3) for
   development; production persistence (SQLite + persistent volume vs.
   managed Postgres) remains undecided — a deployment decision, not a
   code decision. See `docs/deployment.md`.

2. **Final Blueprint integration method.** [OPEN] Phase 1 vendors a
   generated snapshot (`npm run sync-blueprint`) rather than fetching
   Blueprint live. Alternatives (published npm package, live YAML
   fetch, submodule) and a sync cadence remain undecided.

3. **Migrate historical `workout_log.csv`?** [OPEN] See
   `docs/MIGRATION_PLAN.md`. No import has been performed.

4. **Import Calorie Tracker's workout history at all?** [Mostly
   decided] New data stays one-directional (workout-logger → Calorie
   Tracker). Only a one-time historical backfill read remains open.

5. **Final goal/program hierarchy.** [Narrowed] The `Goal` → `Program`
   → `ProgramSession` → `WorkoutSession` tree itself is unchanged and
   still open as a shape question. What it used to also flag as
   open — "how multiple active goals' priorities compose into one
   ranking" and "what a goal-history record needs to capture" — are
   now both resolved: `src/engine/resourceAllocation.ts` (spec §17)
   and the `goal_events`/`GoalEventsRepo` append-only history (spec
   §18), respectively. See items 18-19 below for those.

## Resolved by the Next Phase Implementation Specification

6. **Direct vs. indirect (primary/secondary) exposure contribution.**
   [IMPLEMENTED] No longer provisional. The Next Phase spec §7 gives
   exact coefficients — primary = 1.00 exposure_unit/set, secondary =
   0.33/set — with a worked example (`docs/logs/2026-08-30-08-*.md`
   implemented it originally under "Strategy A"; the Next Phase spec's
   explicit numbers superseded and extended that, adding secondary
   contribution via a curated, documented, non-fuzzy mapping —
   `docs/SECONDARY_TARGET_MAPPING.md`). `EXPOSURE_COEFFICIENTS` in
   `src/engine/config.ts`, tagged `[SPEC]`.

7. **Set contribution / uncompleted sets.** [IMPLEMENTED] Unchanged
   from Phase 2: one completed set = full credit toward every target
   an exercise's own canonical data lists; an uncompleted set
   contributes zero. `exposureEngine.calculateExerciseExposure`.

8. **Week boundary / rolling window.** [Decided as a mechanism]
   Unchanged — `TrainingProfile.week_start_day` is configurable data;
   rolling windows require an explicit `windowDays` argument.

9. **Intensity weighting (RIR/RPE).** [Partially resolved] Still not
   used to weight *exposure* — that remains open, and still has the
   same UI-data-collection dependency as before (RIR/RPE do get
   logged per set now — `Set.rir`/`Set.rpe` — but nothing weights
   exposure by them). What IS now resolved: RIR drives
   `progressionEngine`'s load/rep decisions directly, via Blueprint's
   own `globalPrinciples.rir.typical_working_range` — see item 17.

10. **Goal weighting of exposure.** [Resolved differently than
    proposed] The originally-proposed direction (bake goal priority
    into a derived "goal-relative coverage" view of raw exposure) was
    not adopted. Instead, goal priority never multiplies or reweights
    exposure/volume numbers at all — spec §2.2 is explicit that
    priority "does not directly determine volume." Priority's real
    effect is on **resource allocation** (item 18) and on which target
    a `TargetBuildContext` wins when goals share a target
    (`assembleAndBuildWorkout`'s dedup: highest-priority goal to touch
    a target wins). See `docs/VOLUME_ENGINE.md`.

11. **Hypertrophy Volume model.** [IMPLEMENTED] `volumeEngine
    .decideVolume` — starting volume builds up to Blueprint's own
    `weekly_volume.starting_point_sets` low end regardless of priority
    (spec §9); maintain is the default (spec §10); a stagnant target
    only ever increases after the caller explicitly confirms the §11
    introspection checklist was walked, and never automatically;
    decline/poor-recovery never auto-reduces (spec §12) — see
    `docs/VOLUME_ENGINE.md` and `docs/logs/2026-08-30-18-*.md`. The
    `HypertrophyVolume` contract type (`effective_sets`) remains
    unused; `TrainingExposure.primary_sets` is what's actually compared
    against Blueprint's ranges instead — a deliberate, documented
    choice (see `docs/VOLUME_ENGINE.md`), not an oversight.

12. **Functional Exposure model.** [Resolved by uniform treatment, not
    a separate model] Rather than building `FunctionalExposure`'s own
    arithmetic, the Next Phase spec's engines (`exposureEngine`,
    `volumeEngine`, `frequencyEngine`, `exerciseSelector`) all operate
    identically over `target_type: 'physique_target' | 'functional_goal'`
    — the same primary/secondary exposure split, the same volume
    process, the same frequency/selection logic. The one place
    treatment differs: `workoutBuilder`'s rep/RIR lookup
    (`developmentPackages.lookupExercisePrescription`) only has data
    for physique targets, so a functional-goal target is currently
    always skipped at that step with the gap named explicitly (spec
    §25) rather than invented. The `FunctionalExposure` contract type
    remains unused.

13. **Recovery methodology.** [IMPLEMENTED] `recoveryEngine
    .applyRecoveryConstraint` — same-day repeat → avoid; an exposure
    spike vs. rolling baseline (`RECOVERY_THRESHOLDS
    .recentHighExposureMultiplier`, `[DEFAULT]`) or heavy recent
    badminton (raw logged intensity/fatigue, never converted to a
    set-equivalent) → reduce. See `docs/logs/2026-08-30-17-*.md`.

14. **Frequency allocation model.** [IMPLEMENTED] `frequencyEngine
    .allocateFrequency` — session count from Blueprint's own
    `globalPrinciples.frequency.typical_starting_range_per_week`,
    clamped to actual day availability; sessions spread evenly
    (`[DEFAULT]` spacing choice — Blueprint doesn't prescribe exact
    spacing); Monday swapped out for a lower-body physique target. See
    `docs/logs/2026-08-30-19-*.md`.

15. **Exercise selection ranking.** [IMPLEMENTED] `exerciseSelector
    .selectExercise` — Blueprint muscle-role (primary/secondary),
    redundancy (recent-use penalty, not exclusion), and a keep-if-tied
    bias toward the current exercise, deterministic tie-break. See
    `docs/logs/2026-08-30-20-*.md`.

16. **Time-per-exercise estimation.** [IMPLEMENTED — PROVISIONAL]
    Blueprint still has no per-set duration data, so this remains this
    app's own estimate rather than a Blueprint-given number:
    `TIME_ESTIMATION` (`src/engine/config.ts`, `[DEFAULT]`:
    secondsPerWorkingSet, restSecondsBetweenSets,
    setupMinutesPerExercise) feeds `constraintEngine.fitToTimeBudget`.
    Revisit this number specifically if real session-duration data
    ever becomes available to calibrate against.

17. **Progression methodology.** [IMPLEMENTED] `progressionEngine
    .computeProgression` implements Blueprint's own double-progression
    model literally (`globalPrinciples.progression`), judged against
    Blueprint's own `rir.typical_working_range` — not an invented rule.
    `reduce` only ever fires after a genuine multi-session decline
    pattern (`RECOVERY_THRESHOLDS.consecutiveDecliningSessions`), never
    from one bad session. See `docs/logs/2026-08-30-16-*.md`. Not yet
    wired into `workoutBuilder`'s per-set load prescription (a
    logging-time decision, separate from pre-workout generation).

## New from the Next Phase spec (not in Phase 2's list at all)

18. **Resource allocation across competing goals.** [IMPLEMENTED]
    `resourceAllocation.allocateResource` (spec §17) — strict priority
    order, each goal capped at its own desired amount so a well-
    progressing #1 goal is protected without hoarding, letting leftover
    reach lower-ranked (including stagnant) goals without a second
    pass. See `docs/logs/2026-08-30-21-*.md`.

19. **Goal history.** [IMPLEMENTED] `goal_events`
    (append-only) + `GoalEventsRepo`, recording `created`, `activated`,
    `deactivated`, `priority_changed` today (`exercise_changed`,
    `programming_modified` are defined but nothing writes them yet —
    no engine currently changes a goal's programming automatically).
    Proven by test to survive a deactivate/reactivate cycle intact —
    see `docs/logs/2026-08-30-24-*.md`.

20. **Natural-language goal matching.** [IMPLEMENTED] `goalCreation
    .matchGoalCandidates` (spec §2.1) — deterministic Dice-coefficient
    text matching against Blueprint's `common_user_phrasings`
    (aesthetic outcomes) or `name`/`definition` (functional goals, a
    genuinely weaker signal — Blueprint has no phrasings field for
    them). See `docs/GOAL_MATCHING.md`.

## New from the AI Programmer development-reference repair (see `docs/AI_PROGRAMMER_DEVELOPMENT_REFERENCE_REPAIR_REPORT.md`)

21. **AI proposal programming-adequacy thresholds.** [IMPLEMENTED —
    PROVISIONAL] `programmerAdequacyValidator.ts`'s five tunable
    constants (`MEANINGFUL_COVERAGE_MIN_SETS=2`,
    `MIN_EXPECTED_COVERAGE_TARGETS=2`, `MAX_SINGLE_TARGET_SHARE=0.6`,
    `MAX_TOTAL_SETS_BUDGET_MULTIPLIER=2`,
    `UNDER_PRESCRIPTION_TOLERANCE=0.5`) are this app's own `[DEFAULT]`
    operational choices, not Blueprint-given or spec-mandated numbers —
    same tagging convention as item 16. Not yet calibrated against a
    real corpus of AI-generated proposals (only two live attempts exist
    so far, both rejected). Revisit once more real generations exist.

## New from the Cross-Week Programming Intelligence Fix (see `docs/logs/2026-09-14-54-*.md`)

22. **Cross-week planning horizon bound.** [IMPLEMENTED] The horizon is
    exactly one real week in each direction (never further) —
    `workoutBuilder.ts`'s `WeeklyPlanInput.nextWeekOrderedGymDays`/
    `nextWeekSessionPurposes`/`carryoverByTarget`. Not a tunable number;
    a hard architectural bound.

23. **AI provider timeout/token tunables.** [IMPLEMENTED — PROVISIONAL]
    Two new `[DEFAULT]` operational choices, each sized from an explicit
    worst-case analysis rather than a spec-given number, revisit if real
    production timing/output data ever contradicts them:
    - `ops/nginx/workout-logger.conf`'s `proxy_read_timeout 150s` —
      sized to safely exceed the app's own worst-case Velona round trip,
      `(VELONA_MAX_RETRIES + 1) * VELONA_TIMEOUT_MS` plus retry delay
      (~120.3s with the documented defaults).
    - `velonaProvider.ts`'s `RECONCILE_WEEK_MIN_MAX_TOKENS = 6144` — a
      `reconcile_week`-only floor on top of the shared `VELONA_MAX_TOKENS`
      config (`generate_session` is unaffected), sized from the real
      7-day output schema (`weekReconciliationTypes.ts`) against an
      empirically-observed busy real session (16 exercises — see
      `tests/engine/crossWeekPlanningHorizon.test.ts`).

## New from the program-generation history-lookback audit (production incident investigation, 2026-09-14)

24. **History-window policy across the programming pipeline.** [OPEN —
    recorded, not redesigned] A full read-only audit (cited exact
    functions/files, not documentation) found four genuinely different
    history windows in active use, none of them coordinated by a single
    policy:
    1. Normal completed-history visibility (`last_trained_date`,
       `exercise_history`, exercise-rotation/Gate-5 continuity, recovery
       spike detection) uses a **fixed 14-day rolling window**
       (`trainingState.ts`'s `buildTrainingState`,
       `rollingWindowDays ?? 14`) — identical for initial generation,
       regeneration, AI reorganize, and reconcile-after-training (all
       four funnel through the same one function, confirmed by grep: it
       has exactly one call site).
    2. **Current-week volume exposure** (`current_weekly_primary_sets`,
       the actual input to `decideVolume`/`desiredWeekly`) uses only the
       **current calendar week** (`exposureEngine.ts`'s
       `aggregateWeeklyExposure`) — a *different, shorter* window than
       #1, and the one genuinely volume-determining number in the whole
       pipeline.
    3. AI context (`generate-session`/`reconcile-week`) receives the
       same 14-day window as #1, then **further truncates to the 3 most
       recent uses per exercise** (`programmerContextBuilder.ts`'s
       `buildTargetContexts`) — a restriction that applies only to what
       the model sees, never to the deterministic engine's own
       reasoning.
    4. Cross-week carryover (the Cross-Week Programming Intelligence
       Fix) reads only the **immediately preceding week's own persisted
       aggregate** (`addDays(weekStart, -7)`) — a hard one-week bound
       entirely independent of the 14-day rolling constant, and never a
       raw re-read of that week's session history.
    Two observations worth revisiting later, not acted on now: the
    current-week-only volume window (#2) can be as short as 0-6 days
    right after a fresh Monday; the 14-day window (#1) can make Gate-5
    continuity blind to exposure that's still practically relevant (a
    completed session 15-17 days back was directly observed going in
    and out of visibility while building this session's own regression
    fixtures). No lookback number changes as part of the aggregate-
    integrity fix (item 25) — this item exists purely so a future pass
    has the real, cited-from-code baseline rather than re-deriving it.

25. **`programs.target_allocations_json` aggregate-integrity fix.**
    [IMPLEMENTED] `reconcileWeekProgram` (`weekProgramReconciliation.ts`)
    used to persist `target_allocations_json` straight from
    `buildWeeklyProgrammingPlan`'s own blind, in-memory `sessions[]` —
    built with zero awareness of which days the SAME call's own
    locked-day-preservation loop actually kept untouched. Once any real
    day in a week became locked (a completed/in-progress workout
    exists), that in-memory "aggregate" described a discarded
    hypothetical plan, not the real displayed one — production showed a
    fully-locked week reporting `deliveredDirectSets: 0` for the large
    majority of targets despite their real persisted sessions clearly
    containing that work, which the cross-week carryover fix then read
    as genuine backlog. Fixed by re-deriving `targetAllocations` a
    second time, via the same `rebuildTargetAllocationsFromFinalSessions`
    function (now exported), against the week's real final persisted
    sessions (re-read after the reconciliation loop finishes) rather
    than the discarded hypothetical run — `requiredDirectSets`/`layer`
    per target are still taken from the fresh computation (a property of
    the target/goal, not of which day delivers it); display-only
    enrichment fields (`target_name`/`goal_id`/`goal_label`) are carried
    over by key since they don't depend on delivery either. See
    `docs/CROSS_WEEK_AGGREGATE_INTEGRITY_FIX_REPORT.md`.

None of the still-open items above block anything currently built —
every real engine module accommodates any reasonable future answer
without a breaking schema change (`CONTRACT_VERSION` at 1.4.0,
nullable/open fields throughout). What remains genuinely open is
infrastructure/deployment (items 1-4), the goal/program hierarchy
shape question (item 5), exposure-level RIR/RPE weighting (item 9,
narrowed), the uncoordinated multi-window history-lookback policy
(item 24, recorded not redesigned), and calibrating the still-
provisional numbers (time-per-exercise estimation, item 16; AI proposal
adequacy thresholds, item 21; AI provider timeout/token tunables, item
23) against real data as it becomes available.
