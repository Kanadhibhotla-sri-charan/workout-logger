# Open decisions for Phase 2

Phase 1 deliberately picked pragmatic defaults for these rather than
guessing at final answers. None of them are hard to change later — but
they should be a conscious choice, not an accident, before Phase 2 builds
on top.

1. **Final storage/DB choice.**

   ```text
   Production persistence: OPEN

   Current development storage: SQLite (better-sqlite3)

   Reason: Suitable for local development and single-user Phase 1/1.5
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
   is a deployment-time decision, not one that should change Phase 1/1.5's
   code.

2. **Final Blueprint integration method.** Phase 1 vendors a generated
   snapshot (`npm run sync-blueprint`, committed to this repo) rather than
   fetching Blueprint live at request/build time, because Blueprint's own
   generated JSON isn't committed in its repo and this app shouldn't need
   Vite/React toolchain access just to read data. Alternatives: a small
   published npm package from workout-blueprint, a live fetch of raw YAML
   from GitHub at build time, or a submodule. Confirm the vendored-snapshot
   approach, and agree on a cadence for re-running the sync (manual,
   pre-commit hook, scheduled CI job?). Phase 1.5 made whatever snapshot
   *is* vendored reproducible per-Program (`Program.blueprint_commit`,
   see `docs/logs/`) — that doesn't resolve this decision, it just makes
   the current approach safer to keep using until it's revisited.

3. **Migrate historical `workout_log.csv`?** Calorie Tracker's existing
   CSV has real logged history (hand-entered/LLM-parsed). Decide whether
   to write a one-time import into workout-logger's schema — see
   `docs/MIGRATION_PLAN.md` for the field-mapping plan, ambiguous-name
   handling, and dry-run report design this decision should be made
   against. No import has been performed; this remains a decision, not
   yet an action.

4. **Import Calorie Tracker's workout history at all?** Related to #3 but
   distinct: even without a full backfill, should workout-logger read (not
   just export to) Calorie Tracker data for context, or should the
   relationship stay one-directional? Phase 1.5's answer for *new* data
   going forward is explicit and not open: one-directional,
   workout-logger → Calorie Tracker only (see
   `docs/CALORIE_TRACKER_INTEGRATION.md` and `docs/architecture.md`'s
   responsibility boundary). What remains open here is only whether to
   special-case a one-time historical read for backfill purposes.

5. **Final goal/program hierarchy.** Phase 1's `Goal` → `Program` →
   `ProgramSession` → `WorkoutSession` chain is a straightforward tree
   (goals referenced by id from programs, sessions belong to one program).
   Real training often has multiple concurrent goals with shifting
   priority, phases within a program (e.g. accumulation → deload), and
   goals that outlive any single program. Confirm this shape holds, or
   revise before more is built on it.

6. **Effective-set methodology.** `TrainingExposure.effective_sets` is a
   defined-but-unimplemented field. See `docs/TRAINING_EXPOSURE_MODEL.md`
   for the full design boundary (direct vs. indirect exposure, set
   contribution, uncompleted sets, intensity weighting, goal weighting,
   aggregation) — Blueprint has no per-target weighting data of any kind,
   so this needs an explicitly approved rule, not an invented default.

7. **Volume-range interpretation.** Blueprint's `programmingEngine`
   defines weekly volume/frequency guidance per exercise profile. Phase 2
   needs to decide how workout-logger aggregates a user's actual logged
   volume against that guidance — per exercise, per physique target, per
   muscle group (Blueprint's package-level grouping)?

8. **Recovery/fatigue methodology.** Blueprint tracks per-exercise
   `fatigue_cost`/`stability_demand`/`skill_demand` as static labels. Real
   fatigue is a function of a user's actual recent training load, not just
   an exercise's inherent cost. No fatigue-tracking logic exists in Phase
   1 — needs a methodology before Phase 2 attempts any auto-programming.

9. **Progression methodology.** How should Phase 2 decide when/how to
   progress load, reps, or sets between sessions of the same
   `ProgramSession`? Blueprint's `programmingEngine` gives static rep-range/
   RIR guidance per exercise but has no notion of a specific user's
   history — that logic doesn't exist anywhere yet and needs a rule set.

None of the above blocked Phase 1: the contracts, adapter, and storage are
built to accommodate any reasonable answer to these without a breaking
schema change (all use nullable/open fields, and `CONTRACT_VERSION` is
already in place for when one is needed).
