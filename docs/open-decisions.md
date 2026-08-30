# Open decisions for Phase 2+

Phase 1/1.5/2 deliberately picked pragmatic defaults, built provisional
implementations, or wrote up proposals for these rather than silently
deciding them for good. None of them block what's been built so far —
but each needs a conscious choice from Charan before the next layer (the
actual Training Engine methodology, or production deployment) builds on
top of it.

Status legend: **OPEN** (nothing proposed or implemented yet),
**PROPOSED** (a specific rule is written up for review, no code
implements it), **IMPLEMENTED — PROVISIONAL** (real, tested code exists
on this recommendation — safe to keep running — but it is a conservative
engineering representation, explicitly **not yet approved as final
training/physiology methodology**; a "no" here means revisiting the
implementation, not just the docs, and nothing in this codebase describes
a provisional rule's output as more physiologically precise than it is —
see `docs/TRAINING_EXPOSURE_MODEL.md` §6).

## Infrastructure

1. **Final storage/DB choice.**

   ```text
   Production persistence: OPEN

   Current development storage: SQLite (better-sqlite3)

   Reason: Suitable for local development and single-user Phase 1/1.5/2
   operation — no concurrent writers, no network round-trip needed.

   Production requirement: Persistent storage must survive
   application/container restart. Do not deploy assuming a local SQLite
   file will automatically persist.
   ```

   Keep SQLite for now — do not replace it just because production storage
   is still open. It only works in production on a host with a
   **persistent volume** (see `docs/deployment.md`) — an
   ephemeral-filesystem host (like the free tier the old app used on
   Render) will silently lose data on every restart unless that's set up.
   Decide: SQLite + persistent volume, or move to a managed Postgres (as
   the old app did) for easier backup/multi-host story? Either way, this
   is a deployment-time decision, not one that should change this app's
   code.

2. **Final Blueprint integration method.** [OPEN] Phase 1 vendors a
   generated snapshot (`npm run sync-blueprint`, committed to this repo)
   rather than fetching Blueprint live at request/build time, because
   Blueprint's own generated JSON isn't committed in its repo and this app
   shouldn't need Vite/React toolchain access just to read data.
   Alternatives: a small published npm package from workout-blueprint, a
   live fetch of raw YAML from GitHub at build time, or a submodule.
   Confirm the vendored-snapshot approach, and agree on a cadence for
   re-running the sync (manual, pre-commit hook, scheduled CI job?). Phase
   1.5 made whatever snapshot *is* vendored reproducible per-Program
   (`Program.blueprint_commit`, see `docs/logs/`) — that doesn't resolve
   this decision, it just makes the current approach safer to keep using
   until it's revisited.

3. **Migrate historical `workout_log.csv`?** [OPEN] Calorie Tracker's
   existing CSV has real logged history (hand-entered/LLM-parsed). Decide
   whether to write a one-time import into workout-logger's schema — see
   `docs/MIGRATION_PLAN.md` for the field-mapping plan, ambiguous-name
   handling, and dry-run report design this decision should be made
   against. No import has been performed; this remains a decision, not
   yet an action.

4. **Import Calorie Tracker's workout history at all?** [Mostly decided —
   see below] Related to #3 but distinct: even without a full backfill,
   should workout-logger read (not just export to) Calorie Tracker data
   for context, or should the relationship stay one-directional? The
   answer for *new* data going forward is explicit and not open:
   one-directional, workout-logger → Calorie Tracker only (see
   `docs/CALORIE_TRACKER_INTEGRATION.md` and `docs/architecture.md`'s
   responsibility boundary). What remains open here is only whether to
   special-case a one-time historical read for backfill purposes.

5. **Final goal/program hierarchy.** [OPEN] The `Goal` → `Program` →
   `ProgramSession` → `WorkoutSession` chain is a straightforward tree
   (goals referenced by id from programs, sessions belong to one program).
   Real training often has multiple concurrent goals with shifting
   priority, phases within a program (e.g. accumulation → deload), and
   goals that outlive any single program. Confirm this shape holds, or
   revise before more is built on it. Related and still open, from
   `docs/TRAINING_ENGINE_DESIGN.md` §5-6: how multiple active goals'
   priorities compose into one ranking, and what a goal-history record
   needs to capture (interface sketched, not built).

## Training Exposure (see `docs/TRAINING_EXPOSURE_MODEL.md` for full detail)

6. **Direct vs. indirect contribution strategy.** [IMPLEMENTED —
   PROVISIONAL] How indirect contribution should be handled is a core
   Training Engine methodology decision for the next phase — it is not
   treated as settled just because code exists. Strategy A (conservative
   — count only canonical Blueprint `physique_targets`/`functional_goals`
   membership; indirect/compound secondary contribution is not tracked at
   all) is the current provisional implementation
   (`src/engine/exposureEngine.ts`), because the current Blueprint
   snapshot provides canonical exercise targets but does not provide
   reliable fractional contribution weights for all secondary targets.
   Strategy B (extend Blueprint itself with a canonical
   `secondary_physique_targets` field) remains the legitimate alternative
   and was not chosen here, because it requires a change to a different
   repository outside this app's authority. See
   `docs/TRAINING_EXPOSURE_MODEL.md` §B for the full comparison. **Needs
   Charan's explicit sign-off before being treated as final** — if
   Strategy B is preferred instead, that conversation belongs in
   workout-blueprint's repo, and those relationships must live there, not
   as a hidden mapping table inside Workout Programmer.

7. **Set contribution / uncompleted sets.** [IMPLEMENTED — PROVISIONAL]
   One completed set = one `exposure_unit` toward every target the
   exercise directly lists (full credit each, no fractional split); an
   uncompleted set contributes zero. Implemented
   (`exposureEngine.calculateExerciseExposure`) and testable today, but
   `exposure_units` is a neutral engineering metric, not a claim that one
   completed set equals one effective hypertrophy set — see
   `docs/TRAINING_EXPOSURE_MODEL.md` §C-D, §6.

8. **Week boundary / rolling window.** [Decided as a *mechanism*, not a
   specific value] `TrainingProfile.week_start_day` makes the week
   boundary configurable data rather than a hard-coded Monday; rolling
   windows require an explicit `windowDays` argument with no silent
   default at the engine layer. Nothing left open here mechanically — the
   only remaining question is what default `week_start_day` a new profile
   should start with in the UI (currently `'monday'`, easily changed).

9. **Intensity weighting (RIR/RPE).** [OPEN, and currently unbuildable]
   No rule proposed — and none is buildable yet, since nothing in the
   logger UI collects RIR/RPE from an actual set. See
   `docs/TRAINING_EXPOSURE_MODEL.md` §E. Sequencing: logger UI work has to
   happen before this decision can even be usefully made.

10. **Goal weighting of exposure.** [OPEN — design direction proposed,
    no formula] How a goal's priority and primary/supporting split should
    change the interpretation of raw, goal-agnostic exposure. Direction
    proposed in `docs/TRAINING_EXPOSURE_MODEL.md` §F: compute goal-relative
    coverage as a derived view at read time, don't bake it into the raw
    exposure record. No weighting formula proposed or adopted.

11. **Hypertrophy Volume model.** [OPEN] `HypertrophyVolume` (contract
    type, `src/contracts/types.ts`) is a placeholder — nothing computes
    it. Needs: how exposure becomes hypertrophy volume, whether/how
    fractional weighting is used, how RIR/RPE affects interpretation. See
    `docs/TRAINING_EXPOSURE_MODEL.md` §0, §6 and
    `docs/TRAINING_ENGINE_DESIGN.md` §14. Blocks
    `src/engine/volumeEngine.ts` (`allocateVolume` throws
    `NotApprovedError('hypertrophy-volume-model')`).

12. **Functional Exposure model.** [OPEN] `FunctionalExposure` (contract
    type) is a placeholder — nothing computes it, and it is explicitly NOT
    assumed to share Hypertrophy Volume's arithmetic. See
    `docs/TRAINING_EXPOSURE_MODEL.md` §0.

## Training Engine (see `docs/TRAINING_ENGINE_DESIGN.md` for full detail)

13. **Recovery methodology.** [OPEN — direction proposed] Inputs are
    specified (`src/engine/recoveryEngine.ts`); a conservative direction
    is proposed ("recent high exposure + short interval → reduce priority,
    never actively avoid") but no actual thresholds. See
    `docs/TRAINING_ENGINE_DESIGN.md` §9. Blocks `recoveryEngine
    .applyRecoveryConstraint`.

14. **Frequency allocation model.** [OPEN] How desired weekly exposure
    gets distributed across a user's actual available training days. See
    `docs/TRAINING_ENGINE_DESIGN.md` §15. Blocks `frequencyEngine
    .allocateFrequency`.

15. **Exercise selection ranking.** [OPEN — proposed order, no weights]
    Equipment/time feasibility filtering is decided and implemented
    (`constraintEngine.ts`); ranking among the feasible candidates is not.
    A proposed tie-break order (target tier → redundancy avoidance →
    recent-repetition avoidance → everything else undecided) is written up
    in `docs/TRAINING_ENGINE_DESIGN.md` §13, explicitly not adopted.
    Blocks `exerciseSelector.selectExercise`.

16. **Time-per-exercise estimation.** [OPEN, and currently
    unbuildable] The time-budget arithmetic itself is decided and
    implemented (`constraintEngine.fitsWithinBudget`); estimating how long
    a given exercise/set actually takes is not, and Blueprint has no
    per-set duration data to build one from. Blocks
    `workoutBuilder.buildWorkout`, which needs this before it can do
    anything. See `docs/TRAINING_ENGINE_DESIGN.md` §11.

17. **Progression methodology.** [OPEN] Rep-range, load-increment,
    performance-threshold, RIR/RPE-interpretation, and deload rules for
    deciding when/how to progress between sessions of the same
    `ProgramSession`. Blueprint's `programmingEngine` gives static
    rep-range/RIR guidance per exercise but has no notion of a specific
    user's history. See `docs/TRAINING_ENGINE_DESIGN.md` §17. Blocks
    `progressionEngine.computeProgression`.

None of the above blocks what's been built so far: the contracts,
adapter, storage, and the six real (non-stubbed) engine modules are built
to accommodate any reasonable answer to these without a breaking schema
change (nullable/open fields throughout, `CONTRACT_VERSION` bumped
already twice for additive changes). The six stubbed engine modules
(`volumeEngine`, `frequencyEngine`, `recoveryEngine`, `exerciseSelector`,
`workoutBuilder`, `progressionEngine`) exist specifically so their
interfaces are stable and ready the moment their blocking decision above
is resolved — see `docs/TRAINING_ENGINE_DESIGN.md` §2.
