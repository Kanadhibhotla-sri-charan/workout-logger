# Open decisions for Phase 2

Phase 1 deliberately picked pragmatic defaults for these rather than
guessing at final answers. None of them are hard to change later — but
they should be a conscious choice, not an accident, before Phase 2 builds
on top.

1. **Final storage/DB choice.** Phase 1 uses SQLite (`better-sqlite3`),
   simplest option for a single user with no concurrent writers. This only
   works in production on a host with a **persistent volume** (see
   `docs/deployment.md`) — an ephemeral-filesystem host (like the free
   tier the old app used on Render) will silently lose data on every
   restart unless that's set up. Decide: SQLite + persistent volume, or
   move to a managed Postgres (as the old app did) for easier
   backup/multi-host story?

2. **Final Blueprint integration method.** Phase 1 vendors a generated
   snapshot (`npm run sync-blueprint`, committed to this repo) rather than
   fetching Blueprint live at request/build time, because Blueprint's own
   generated JSON isn't committed in its repo and this app shouldn't need
   Vite/React toolchain access just to read data. Alternatives: a small
   published npm package from workout-blueprint, a live fetch of raw YAML
   from GitHub at build time, or a submodule. Confirm the vendored-snapshot
   approach, and agree on a cadence for re-running the sync (manual,
   pre-commit hook, scheduled CI job?).

3. **Migrate historical `workout_log.csv`?** Calorie Tracker's existing
   CSV has real logged history (hand-entered/LLM-parsed). Decide whether
   to write a one-time import into workout-logger's schema, and if so, how
   to map its free-text `workout_name`/`equipment` columns onto Blueprint
   exercise ids (likely needs manual review — those columns were never
   constrained to Blueprint's vocabulary).

4. **Import Calorie Tracker's workout history at all?** Related to #3 but
   distinct: even without a full backfill, should workout-logger read (not
   just export to) Calorie Tracker data for context, or should the
   relationship stay one-directional (workout-logger → Calorie Tracker
   only)?

5. **Final goal/program hierarchy.** Phase 1's `Goal` → `Program` →
   `ProgramSession` → `WorkoutSession` chain is a straightforward tree
   (goals referenced by id from programs, sessions belong to one program).
   Real training often has multiple concurrent goals with shifting
   priority, phases within a program (e.g. accumulation → deload), and
   goals that outlive any single program. Confirm this shape holds, or
   revise before more is built on it.

6. **Effective-set methodology.** `TrainingExposure.effective_sets` is a
   defined-but-unimplemented field. Needs a real rule: does every logged
   set count equally toward a target, or scale by proximity to failure
   (RIR/RPE, once those are logged), exercise role (primary vs.
   accessory), or Blueprint's own `coverage_categories`?

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
