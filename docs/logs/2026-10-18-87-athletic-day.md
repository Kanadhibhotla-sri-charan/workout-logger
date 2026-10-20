# Athletic day: legs trained for badminton fitness

**Commits (2026-10-18):** `1bfb336`, `2f49282`, `937abf2`. Details:
decision log §20, §20.1, §20.2 ([link](../AI_GENERATION_REDESIGN_DECISION_LOG.md)).

- `1bfb336`: Blueprint synced to `89dd2d6` (20 drills with a
  `training_mode`), drills isolated from the lifting pools; leg training
  mode (`training_profiles.leg_training`, prod = athletic) turns the leg
  day into an Athletic day (rotation push/pull/athletic/upper) generated
  on request.
- `2f49282`: leg strength block (all 42 relevant leg lifts), build-up
  phase, recovery-aware 5–10 min add-ons on push/pull/upper days (never
  two active days in a row); the Legs injury pause makes the Athletic day
  a rest day.
- `937abf2`: durability-first aims (injury-free, flexible, leg fatigue
  resistance, then strength; not skill or footwork), drills filtered by
  gym equipment (bench stand-in for drop landings, no box jumps or rowing
  machine), avoided drills honoured.
- Production data (owner-stated, after a backup
  `deployment-backups/pre-937abf2-20261018T154518Z.sqlite`): jump rope
  added to equipment; both shadow-footwork drills set to avoided.
- Tests: `tests/athletic/athleticDay.test.ts` (25); full suite 2310, no
  new failures.
