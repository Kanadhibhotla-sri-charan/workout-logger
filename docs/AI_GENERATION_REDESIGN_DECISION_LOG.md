# AI generation redesign — decision log (2026-09-28 → 2026-10-02)

This document records **why** the AI generation path looks the way it does:
the problems that drove each change, the decisions taken (including the ones
explicitly rejected), what was verified, and what is still open. Commit
messages and code comments describe *what* each change does; this is the
single place that ties them together. Read it before changing anything in
`src/ai-programmer/planning/`, `proposalPipeline.ts`, `weekGeneration.ts`, or
the week routes.

Related: `docs/deployment.md` (deploy procedure), `docs/open-decisions.md`
(older, unrelated open items).

---

## 1. Summary — the system as of 2026-10-02

| Area | Before | Now |
|---|---|---|
| `generate_session` (one day) | AI got a ~128k-char context and had to work out capacity, feasibility and crediting itself; output often failed adequacy or duplicated exercises | A deterministic **SessionPlan** decides the structure; the AI receives a compact plan (~16–22k chars) and chooses exercises, order, volume within range, intensity and rationale; **plan conformance** normalises its output before the unchanged validators |
| Week generation | Any `GET /api/programming/week` or `/today` for an unsaved week silently made a **paid** AI `generate_week` call (any date, no single-flight, no failure gate) and wrote the week directly into `programs`/`program_sessions` | **Explicit**: reads never generate; `POST /api/ai-programmer/generate-week` creates **per-day pending proposals** for the week's remaining gym days, using the same planned pipeline as `generate_session` |
| UI | Client-side loop calling `generate-session` per day | "Generate this week's AI sessions" driven entirely by the backend `generation` state |

Production (Oracle VM, see memory/deploy notes): build `5332ef1`,
`AI_PLANNED_GENERATION_ENABLED=true`, `AI_WEEK_GENERATION_MODE=explicit`.

---

## 2. Timeline (commits on `main`)

| Commit | Date | What and why |
|---|---|---|
| `1d38287` | 2026-09-28 | Same-context retry gate for `generate_session`: a quality failure (schema/domain/adequacy/truncation) is not paid for again with the identical context unless `confirmRetry: true`. In-process memory (see §8 known issue). |
| `c8bc353` | 2026-09-28 | Feasibility/completion only count exercises that actually **credit** the target under the shared-credit rule (fixed brachialis/curl inconsistencies behind the Pull failures). |
| `9128d8d` | 2026-09-28 | Phase 1+2: rejection observability (bounded `generation rejected` log records) and the **SessionPlan** in shadow mode (computed and logged, not used). |
| `a99886d` | 2026-09-29 | Phase 3+4: plan conformance + planned AI context/instruction behind `AI_PLANNED_GENERATION_ENABLED`; one shared post-provider pipeline; planner ownership of contested candidates; per-target candidate narrowing. |
| `899f872` | 2026-09-29 | Rule-3 conformance made *useful and legal* (no no-op removals, no loss of goals/regions); shared-group trim; planned context shows shared groups as one joint allocation. Triggered by the first production Upper failure (§5.3). |
| `d39837a` | 2026-10-01 | Crash fix: malformed `?date=` on `/programming/today` and `/week` returns 400 instead of an unhandled rejection that exited the process (§6.2). |
| `5cc0348` | 2026-10-01 | Explicit week generation behind `AI_WEEK_GENERATION_MODE` (§7), including the in-flight heartbeat lease. |
| `5332ef1` | 2026-10-01 | Program page UI for explicit week generation (§7.8). |

---

## 3. The problem that started it (Pull, 2026-09-28/29)

Repeated production failures generating Pull sessions. Forensic analysis of
real outputs showed the failures were **structural, not model quality**:

* The AI was asked to solve a constrained allocation problem (which targets
  fit, how many exercises each needs, which exercises credit which target,
  shared credit, caps) from a very large context — and it frequently got it
  wrong: infeasible targets included (upper-traps), required capacity
  starved (lat/back under their floors), the same exercise used twice
  (schema-rejected duplicates).
* Incremental prompt fixes were not converging. Decision: **stop patching
  the prompt; move the arithmetic into deterministic code** and give the AI
  only the decisions that genuinely need judgment.

---

## 4. Architecture of planned generation

### 4.1 Pipeline (one path for everything)

```
build context (programmerContextBuilder)
  → planSession(context)                     deterministic SessionPlan
  → planned AI context + instruction          plannedContext.ts (flag on)
  → provider call
  → runProposalPipeline (proposalPipeline.ts):
       schema → [plan conformance] → repair → domain → completion → adequacy
  → persist pending proposal (existing lifecycle)
```

`runProposalPipeline` is the **only** post-provider pipeline. Conformance
runs only when a plan is applied; every other stage is identical with the
flag on or off. Validators, Blueprint data and the output schema
(`ai-workout-session-proposal.v1`) were never weakened.

### 4.2 SessionPlan (`planning/sessionPlanner.ts`)

Decides, per session: which targets are **required** (active goals),
**selected**, **deferred**, **infeasible**, **ineligible**,
**recovery-excused** or **outside identity**; ranks them by tier
(goal → identity_primary → identity → accessory, first target of each
identity region first); computes **capacity groups** (targets linked only
by genuine Blueprint shared credit) and the minimum exercise slots each
group needs; and reports refusals (`REQUIRED_GOAL_INFEASIBLE`,
`REQUIRED_GOAL_EXCEEDS_CAPACITY`, `IDENTITY_MINIMUM_UNSATISFIABLE`).

Key planner decisions:

* **7a – contested candidate ownership.** An exercise listed for several
  planned targets where one label does not credit the other (e.g.
  `seated-cable-row` for back-thickness and lat-width) gets exactly one
  owner, so the AI is never offered the same label-only exercise twice
  (the root of the Pull duplicate). Exhaustive search over assignments;
  only assignments where every unshared target still reaches its minimum
  within its reservation; preference: shared-credit coverage, then
  Blueprint "primary" role, then plan priority. Genuine shared credit
  (overhead extensions for triceps + long head, cable fly for the pecs)
  stays available to every target it credits.
* **7b – candidates must be able to reach the minimum.** An unshared
  reservation of N slots only offers candidates that, with the N−1 best
  others, reach `plannedMinimumSets` (e.g. 1-slot hamstrings never offers
  a 2-set leg curl; found from a real Legs failure).

### 4.3 Plan conformance (`planning/planConformance.ts`)

Normalises the AI output to the plan **before** repair/domain/completion.
It only ever *removes*; it never invents exercises or adds volume.

1. Remove whole targets the plan does not train (deferred, infeasible, …).
2. Remove entries whose exercise does not credit its label, or whose side
   credit would hit an untrained target.
3. If over capacity:
   * **3a** remove a whole *selected* target, lowest priority first —
     **only** if removal actually lowers the excess (a member of a group
     kept at size by a goal frees nothing) and keeps every required goal,
     identity-minimum target and represented identity region;
   * **3b** if no such removal exists, trim a capacity group that uses more
     entries than its planned allocation back to it, only while every
     member keeps its planned minimum (deterministic: fewest credited sets
     lost, then later-listed entry);
   * otherwise change nothing — the unchanged validators decide.

Every action is recorded in the proposal's `warnings`.

### 4.4 Planned AI context (`planning/plannedContext.ts`)

Compact `ai-programmer-planned-context.v1`: purpose, capacity, targets in
rank order with role, min/recommended/max sets and their **candidates only**
(with ceilings, authored reps/RIR, `alsoCredits`), `exerciseGroups` (one
**joint** allocation per shared group — added after the AI repeatedly read
"triceps 3 + long head 1" as 4 separate reservations), what is not in the
session, and only the coaching data needed. The instruction (3,200 chars)
says the plan is authoritative and the AI owns exercise choice, order,
emphasis, intensity and rationale.

### 4.5 Locked product decisions (planned generation)

1. Over budget → drop lowest-ranked **optional** targets whole; never a
   required goal (amended by 3a/3b legality rules and the group trim).
2. A required goal omitted by the AI → **reject**; completion must not add it.
3. No AI target swaps; the planner's allocation is authoritative.
4. An infeasible active goal → refuse before the provider call (planned;
   currently such a plan falls back to the legacy contract).
5. Completion stays **adequacy-only**: an optional planned target removed
   by conformance is not refilled unless adequacy requires it.

---

## 5. Evaluation and rollout of planned generation

### 5.1 Method
Isolated provider calls on a scratch checkout + throwaway DB copy (never
production) before every rollout step; fixture replay of real saved outputs
(`tests/ai-programmer/fixtures/`) through old vs new pipelines; full-suite
comparison against a name-by-name baseline of known date-rotation failures.

### 5.2 First production rollout (2026-09-29) — stopped
Pull and Push passed; **Upper** passed the validators but conformance
removed biceps (freeing no capacity) and then rear-delt — the session's
only shoulder target. Rollout reverted by flag, investigated offline with
an exact reproduction (same context hash), fixed in `899f872`.

### 5.3 Controlled evaluation and normal rollout (2026-09-29)
One fresh proposal per purpose on `899f872`: all valid; the Upper triceps
over-allocation recurred and was trimmed legally; no incorrect removals;
input tokens ~5.6–7.0k per call vs ~37.5k on the legacy contract (~83%
less). Approved and enabled permanently.

### 5.4 Known non-blocking issues (accepted at rollout)
1. AI repeatedly over-allocates the Upper triceps shared group; 3b trims it.
2. AI rationale can mention an exercise later trimmed by conformance.
3. Completion can add a 1-set exercise when adequacy requires it.
4. Evidence is a handful of runs per purpose on one model (qwen3-next-80b).

---

## 6. Production incidents found during observation (2026-09-30 → 10-01)

### 6.1 Velona "credentials rejected" — actually key budget exhausted
Six user generations on 10/1 failed with `AI_PROVIDER_AUTHENTICATION_ERROR`.
The key file was unchanged and the dashboard looked fine. One approved
diagnostic request (empty body, cannot run inference) returned
`401 {code: INVALID_KEY, message: "API key budget exceeded"}` — a **per-key
budget**, distinct from account credits. Resolved by raising the budget in
Velona (a user generation succeeded at 16:44 UTC on 10/1).
*Lesson / open item:* `velonaProvider.ts` maps 401 **and** 403 to one
generic error and discards Velona's error body, so logs cannot show the
real cause. Logging the status, `error.code` and `request_id` (never the
key) is a recommended follow-up.

### 6.2 Server crashes from a scraper — fixed in `d39837a`
The process exited 8 times. A scraper (`WebSiphon/next-0.1`) requested
`/api/programming/today?date=${session.date}` (the frontend's unexpanded
template text); the async route parsed the date outside its `try`, so the
unhandled rejection killed Node. Both date-taking routes now validate and
return 400.
*Security note (open):* the app is public over plain HTTP without
authentication; the same bot probed for secrets (all 404) but received
personal API data (workouts, goals, profile). Authentication / access
restriction is an open decision.

---

## 7. Explicit week generation (`5cc0348`, `5332ef1`)

### 7.1 Why
The legacy week path paid for an AI week on the first **read** of any
unsaved week (scrapers included, any date), had no single-flight (9/28: one
phone opening three pages launched three parallel ~33k-token calls), no
failure gate (every reload re-paid), no fallback (a provider outage would
break the week view), and wrote AI days straight into the program — which
the user then deleted to use per-day proposals anyway.

### 7.2 Approved decisions
* **D1** Output = per-day **pending proposals** in the existing lifecycle;
  never written into `programs`/`program_sessions`.
* **D2** Later days are planned with **projected exposure** from earlier
  days; the same SessionPlan, no second planner.
* **D3** Paid generation only for the **current week**, and next week from
  **Saturday**; never past weeks or further ahead. Reads of any week are
  always allowed (read-only).
* **D4** Week-run proposals expire at the **end of their target date**
  (user timezone); single-day proposals keep 24h.
* **D5** Run / lock / gate state lives in the **database** (the process
  restarted 8 times in two days; in-memory state is lost each time).
* **D6** No global provider circuit added to `generate_session` (separate
  decision if ever needed).
* **D7** In explicit mode `GET /week` and `/today` never generate; an
  unsaved week renders the live skeleton + `generation.status =
  "not_generated"`. No hidden deterministic prescription on read.

### 7.3 Flow
`POST /api/ai-programmer/generate-week {weekStart, confirmRetry?}` →
validate window → eligible days (gym day, date ≥ today, no session, no
pending/approved proposal) → acquire guard → **202** → background run: per
day, re-check eligibility, build context with projection, check the quality
gate, `planSession` (refusal ⇒ never paid), planned generation via
`AIProgrammerService.generatePlannedDayProposal` (same private
`generateFromContext` as `generate_session`), persist pending proposal with
`week_run_id`. Progress is read from `GET /week`'s `generation` field.
202 instead of waiting: one call per day exceeds a proxy timeout.

### 7.4 Concurrency
`ai_week_generation_runs` with a partial `UNIQUE(week_start) WHERE
status='running'`; `WeekGenerationRunRepo.acquire` is one synchronous
transaction completed **before any provider await**. Heartbeat between
days **and every 30 s during an in-flight provider call**
(`withHeartbeat`), so a slow live call is never treated as stale; a dead
process stops refreshing and the run is recoverable after 5 min
(`abandoned`). `generate-session` returns 409 only for a date a live run
still has queued.

### 7.5 Failure classes
* Provider auth (401/403) → stop run, 30-min backoff.
* Provider transient (5xx/timeout/429/invalid response) → stop run,
  2/10/30/60-min backoff by consecutive failures.
* Quality (schema/domain/adequacy/truncation) → that day only; recorded in
  `ai_week_generation_day_failures` by (date, contextHash); rerun on the
  same context is "gated" (no call) unless `confirmRetry`.
* SessionPlan refusal → "refused", never paid.
* Partial success is kept; later runs only attempt remaining, ungated days.
* During backoff: POST → 503 with `retryAfter`; GETs stay 200.

### 7.6 Projection detail (deliberate deviation)
Projection uses **every earlier day of the week with a live proposal**
(pending/approved, or committed but not yet trained), read from the DB —
not only days from the same run — so a re-attempted day is planned against
the same context (and contextHash) as its first attempt, which keeps the
quality gate meaningful. Implemented in `context/projectedExposure.ts` via
the engine's own `calculateExerciseExposure`; an optional
`projectedSessions` input to the context builder — absent ⇒ byte-identical
context (generate_session unchanged).

### 7.7 Verification
33 backend tests (concurrency, stale/in-flight lease, partial success,
gates, provider failure, refusal, projection, generate-session interplay,
legacy unchanged); legacy responses byte-identical before/after deploy;
production reads verified read-only; 202/progress/concurrency verified on
the deployed build against a production DB copy with Velona stubbed
(never a real paid call while the budget was uncertain).

### 7.8 UI
`program.html`: when `GET /week` carries `generation`, the week control is
"Generate this week's AI sessions" — one POST, the backend headline and
reason (with backoff retry time), per-day status badges. While the backend
says "generating", the page re-reads `GET /week` every 4 s (one timer) and
re-renders; the button is disabled unless the backend allows a start, with
an in-flight guard. Proposals are still reviewed/approved/committed in each
day's existing panel. Legacy mode keeps the old control. Display mapping is
the pure `weekGenerationView` in `app.js`; a contract test fails if the
backend adds a status or reason the UI does not label. Browser-checked
locally (all states) and read-only on production.

---

## 8. Open items / known issues

| # | Item | Status |
|---|---|---|
| 1 | Velona client discards provider error bodies; log status + `error.code` + `request_id` | Recommended, not done |
| 2 | Public app without authentication (personal data readable by scrapers) | Open decision |
| 3 | `generate_session` retry gate is in-process memory (lost on restart) | Known; week gates are durable |
| 4 | When only quality-gated days remain, backend still reports `canGenerate: true` (button enabled; rerun is harmless, no paid call) | Minor; backend tweak possible |
| 5 | No week picker in the UI — next week (allowed from Saturday) not reachable | Small follow-up |
| 6 | Infeasible-goal plans fall back to the legacy contract instead of refusing before the call (locked decision 4) | Not implemented |
| 7 | Rationale can be stale after conformance trims (issue 5.4-2) | Observing frequency |
| 8 | Date-rotation tests with hard-coded dates fail as time passes (baseline ~245) | Pre-existing |
| 9 | Stale "Planned recovery week … through Sep 23" banner seen locally | Existing content, not investigated |

---

## 9. Operations

* **Flags** (systemd drop-ins under `/etc/systemd/system/workout-logger.service.d/`):
  `planned-generation.conf` → `AI_PLANNED_GENERATION_ENABLED=true`;
  `week-generation.conf` → `AI_WEEK_GENERATION_MODE=explicit`.
  **Rollback** either one: delete the file, `sudo systemctl daemon-reload`,
  restart; verify the running process with `/proc/<MainPID>/environ`.
  No data migration in either direction (all schema changes additive).
* **Schema added:** `ai_week_generation_runs`, `ai_week_generation_day_failures`,
  `ai_program_proposals.week_run_id` (nullable).
* **Backups** before each deploy: `deployment-backups/pre-<commit>-<ts>.sqlite`.
  Daily backup timer (`ops/systemd/workout-logger-backup.timer`, 00:00
  UTC, `Persistent=true`) installed 2026-10-20 on the owner's go-ahead
  (it had never been installed, found in `docs/logs/2026-10-20-88-...`):
  `/usr/local/bin/backup-workout-logger.sh` writes
  `~/workout-logger-backups/workout-logger-<ts>.sqlite` (sqlite3 online
  backup + integrity check), keeps 7 days. Same disk as the DB, so no
  protection against losing the VM itself. See `docs/logs/2026-10-20-90-...`.
* **Calorie Tracker sync** (2026-10-21, §21): drop-in `calorie-sync.conf`
  (`ops/systemd/workout-logger-calorie-sync.conf`) loads
  `~/.config/workout-logger/calorie-sync.env` (branch) and
  `calorie-sync-token.env` (the secret token, chmod 600). Off when the
  token file is absent. Rollback: delete the token file and restart.
* **Observation tooling** (outside the repo, read-only, works on DB copies):
  `/home/ubuntu/ai-observe/observe.sh [isoWatermark]`; `observeAsOf.mjs` and
  `planCompare.mjs` for proposals whose date is already locked (pinned clock
  + compare against the logged shadow plan).
* **Rules followed throughout:** no provider calls against production for
  testing; isolated scratch checkout + DB copies for real-provider evals;
  never modify or approve users' proposals; commit/deploy only on explicit
  approval.

---

## 10. Exercise variety: wide pool and rotation shortlist (2026-10-09; revised 2026-10-11, see section 11)

### 10.1 Why
Committed proposals 9/28 → 10/9 repeated the same exercises: all four push
days shared incline barbell press, flat barbell bench, cable fly, cable
overhead extension, DB lateral raise and cable crunch. Cause: the planner only
prescribes development-package exercises (46 of 123), so most targets had
1-3 candidates. Contributing: the old repeat signal
(`recentConsecutiveSessionsUsed`) reset whenever two exercises shared a
target on one date, so heavily repeated exercises looked fresh.

### 10.2 Approved decisions
* Flag `AI_EXERCISE_POOL_MODE=package|wide`, default `package` (byte-identical
  context). Wide applies only with planned generation on.
* Non-package exercises are prescribed only for their Blueprint **primary**
  target: reps from the Blueprint programming profile's primary range (the
  rule the package reps were copied from; a test proves all 76 package rows
  match), RIR from global principles (1-3), 3 sets compound / 2 isolation.
  Package prescriptions unchanged. Deload rep bias applies to both.
* *(Superseded 2026-10-11, see 11.1: packages no longer prescribe or anchor
  anything in wide mode.)* Package primary compounds stay on the list for the
  block (anchors).
  Accessories used in both of the last two comparable sessions are rested
  when an alternative exists; least recently used first. Comparable = same
  day type, with upper counting as push and pull; a past date's type comes
  from the targets it directly trained.
* At most 4 prescribed exercises per target, widened only if the shortlist
  would be less feasible than the full pool.
* Repair, completion, feasibility and the planner see only the shortlist
  (exercises left off it lose their prescription). Approval revalidation
  builds the context without the shortlist.
* New signal `recentSameTypeUsage {sessionsUsed, sessionsConsidered,
  lastUsedDate}` replaces the run counter in wide mode; rule 7 reworded
  positively. No equipment filter (user decision: overrides manually).

### 10.3 Verification
* Unit/integration: `tests/blueprint/programmingProfiles.test.ts`,
  `tests/ai-programmer/exercisePool.test.ts`. Full suite: same 245
  date-rotation failures by name, 0 new.
* Replay of 10/5, 10/6, 10/8, 10/9 on a production copy, AI stubbed
  (`tests/replay/exercisePoolReplay.test.ts`, skipped without `REPLAY_DB`):
  no refusals, no search-limit notes, plan time unchanged (~0.2 s), planned
  context +6-13 %, all stubbed generations pass in both modes.

### 10.4 Pre-test fixes (2026-10-09, same branch)
* **Candidate-list enforcement** (plan conformance, wide pool only): an AI
  entry whose exercise is not one of its target's plan candidates (rested or
  never listed) is removed. Kept only if listed for another planned target
  that Blueprint also credits it to (genuine shared credit). Nothing is
  substituted; validators unchanged. Package mode unchanged.
* **One-exercise sessions — fixed (identity counted by muscle group)**: with
  light weekly biceps volume, a single hammer curl (Blueprint credits
  brachialis + biceps) used to pass adequacy in both modes, the identity rule
  counting 2 covered targets. Identity coverage is now counted in distinct
  Blueprint development-package muscle groups (`identityGroupOf`,
  `requiredIdentityGroups` in programmerAdequacyValidator.ts), in the
  validator and the planner's identity-minimum step together (covering
  targets: first in allocation order, one per group). Ranking, the 8-target
  cap, shared-credit volume accounting and goal checks unchanged. Applies in
  every mode. Side effect: a "push" made only of chest work (e.g. bench +
  incline) is now one group and rejected; one existing test fixture was moved
  to chest + side-delt for that reason, and two planner snapshots changed
  (push: triceps-long-head -> lower-pec as covering target, lower-pec
  minimum 1 -> 2; upper: triceps-long-head -> back-thickness). All 17 stored
  proposals still pass.
* **Front delts / upper traps**: eligible whenever they have candidates;
  ranking and the 8-target cap unchanged. Under the existing allocation
  order (identity regions before accessory regions) they are selected on
  every push / pull day while capacity allows — the same reason side-delt
  and rear-delt are. No code forces them.

### 10.5 Replay (production copy, AI stubbed)
Oct 5/6/8/9, both modes: no refusals, no search-limit notes, largest group
12 options (limit 20), plan time ~0.2 s, all stubbed generations pass.
Sequential wide run from Oct 5: rotation visible day to day. Off-list
injection: every rested/unlisted exercise removed by conformance.

---

## 11. Owner revisions and additions (2026-10-11, branch `exercise-variety`)

### 11.1 Packages supply numbers only (wide mode)
Owner's original design intent, restated: development packages give the
weekly set NUMBERS (complete package for goal muscles, efficient for the
rest); they never limit or bias which exercise is chosen. Package mode had
been reading the packages' exercise lists as the candidate pool, which caused
the repetition in section 10.1. Wide mode now ignores package exercise lists:
* Every physique target's Blueprint primary-target exercises are prescribed
  from the profile default (reps: programming-profile primary range, which
  reproduces every authored package rep range; RIR 1-3 from global
  principles; 3 sets compound / 2 isolation). Package exercises lose their
  authored prescription in wide mode; package mode is unchanged.
* Anchor: the Blueprint primary-target compound the target was most recently
  trained with (then most use in the comparable sessions, then id); one per
  target, none if no compound has been used. Accessories rotate as before.
* The "package first" tie-break is removed.
* Volume (weekly reference, per-session range, per-exposure cap, minimums)
  still comes from the packages exactly as before.
* Visible differences in the Oct 5-9 replay: same targets selected, 0
  refusals, 0 search notes; mid-pec's anchor on 10/5 becomes flat DB press
  (the compound used most recently); DB lateral raise maxSets 3 -> 2
  (isolation default); hanging knee raise leaves the obliques list (its
  Blueprint primary target is rectus abdominis). Off-list injection: every
  rested/unlisted exercise still removed.

### 11.2 Goals panel in explicit week mode
`/week` in explicit mode has no saved week program, so "This week's goals"
always showed "Not enough information yet." For an unsaved week the panel is
now derived live (`liveTargetAllocations`, server/routes/programming.ts):
Required = the deterministic planner's `requiredDirectSets` as of the week
start; Done so far = direct sets logged this calendar week. Read-only (no
rotation record, nothing persisted). Response field `targetAllocationsBasis`
('completed' | 'programmed') switches the labels to "Done so far /
Remaining". Saved weeks unchanged. `/today` does not compute it.

### 11.3 "Other" day notes
Free text for non-logged activity (rehab, a sport, an injury, how it felt).
* Table `day_notes (date PK, note, created_at, updated_at)`; repo
  `DayNotesRepo`; `PUT /api/programming/days/:date/note {note}` (empty
  deletes; max 2000 chars). `/week` days carry `otherNote`.
* UI: the day modal's activity dropdown has "Other (write what you did)",
  which opens a note box. Saving a note never changes the day's activity or
  program.
* AI: `context.activityNotes` = notes dated targetDate-14 .. targetDate,
  oldest first, passed through to the planned context; planned rule 9a tells
  the model to read them as recovery evidence (gentler candidates / lower
  volume within the legal range, cited in recoveryConsiderations). Never sets,
  never structure. A new note changes the context hash, so a failed day can
  be retried with it.

### 11.4 Injury pause
* Table `injury_pauses (area PK, note, since, created_at)`; repo
  `InjuryPausesRepo`. Areas (by Blueprint target parent_region): chest,
  shoulders, back, arms (arms + forearms), core, legs (quads, hamstrings,
  hips, calves), neck.
* `GET /api/programming/injuries`, `PUT /api/programming/injuries/:area
  {paused}`. UI: "Injury pause" checkboxes on the Program page.
* Effect (all pool modes): a paused area's targets get
  `eligibleForThisSession=false` + `pausedForInjury`, leave the session's
  expected coverage, are not demanded by the active-goal check, and are
  planned as `ineligible` ("body area paused for injury"). The planner also
  drops any candidate exercise whose Blueprint credit includes a paused
  target. `context.injuryPauses` reaches the model with a one-line rule
  (prefer candidates that load the paused area least).
* Limits: a legs session with legs paused has nothing to plan (the planner
  refuses; no paid call). The deterministic week planner (legacy mode) does
  not read pauses. Indirect loading not modelled by Blueprint credit (e.g.
  general bracing) is left to the model's choice.

### 11.5 Verification
* Tests: `tests/ai-programmer/activityNotes.test.ts` (6),
  `tests/ai-programmer/injuryPause.test.ts` (13), exercisePool tests
  rewritten for 11.1, explicit-mode goals-panel test in
  `weekGeneration.test.ts`. Full suite 2222 tests: the same 245 known
  date-rotation failures by name, 0 new. Typecheck clean.
* Replay (production copy 2026-10-09, AI stubbed): see 11.1.

### 11.6 Paid wide-mode test (one call, 2026-10-11)
Run in an isolated scratch checkout on the VM (`~/wl-paid-test`) against a
`.backup` copy of the production DB; production untouched. Flags: AI on,
planned generation on, `AI_EXERCISE_POOL_MODE=wide`, model
qwen/qwen3-next-80b-a3b-instruct. Legs paused in the copy (mirrors the
owner's injury). Push, Mon 2026-10-12.
* Tokens: 8,013 in / 1,590 out, finish "stop". Result: pending proposal,
  passed schema, conformance, domain and adequacy validation.
* 10 exercises / 23 sets: close-grip bench 3, skull crusher 2, overhead
  triceps extension 2, cable shoulder press 3, incline cable press 3, cable
  lateral raise 2, cable chest press 3, chest-biased DB pullover 2, Pallof
  press 2, overhead press 1 (deterministic completion, front-delt short by
  one set). Seven of the ten were not used in the last two push sessions.
* Finding: a reactive deload is active (10/8-10/14). The plan's numbers
  already include it (rule 6), yet the model cut every target to its
  minimum (23 sets vs a recommended 37), citing the deload: a double
  reduction. Pre-existing model behaviour, not caused by the pool change.
  Also: its rationale mentions "rest-pause applied" with no technique in the
  output. Open item for the owner.


---

## 12. Deload fixes (2026-10-11, owner-approved, same branch)

### 12.1 Reactive deload measured per exercise
Finding: the reactive trigger averaged estimated 1RM across ALL of a target's
exercises, so an exercise swap read as a decline (back-thickness: seated cable
row ~80 kg e1RM -> chest-supported DB row ~14 kg looked like an 80% drop), and
lighter scheduled-deload sessions read as decline too. On 2026-10-06 a
scheduled deload was running; on 2026-10-08 a reactive deload fired (5
targets) through 2026-10-14: roughly two deload weeks back to back. Wide-mode
rotation would make such false triggers routine.

Fix (`reactiveTrendEvaluator.ts`): `targetDeclineEvidence` groups a target's
completed exposures by exercise, drops sessions on deload dates
(`deloadDatesInRange`, from the periodization event log), trends each exercise
against itself, counts an exercise only with >= 3 sessions
(`MIN_EXERCISE_POINTS_FOR_DECLINE`), and calls the target "down" when more than
half of its counted exercises are down. Thresholds (2+ targets, 21-day
lookback, 5% tolerance, cooldown) unchanged. Signals now carry per-exercise
evidence. Re-run on the production copy: 10/6, 10/8 and 10/9 all "clear" (the
10/8 trigger would not have fired).

### 12.2 Deload applied once (planner floor)
Finding (paid run, 11.6): the floor was 50% of a recommendation that the
deload had already halved, so a model citing the deload could legally cut to a
quarter of a normal session. Fix: during a deload each target's tolerance is
`deloadAdequacyTolerance(deloadMin, normalMin)` = min(1, max(0.5, 0.5 x
normalMin / deloadMin)), i.e. the floor is the smaller of the deload
recommendation and a normal week's floor (it never asks for more than a normal
week; a capped target such as triceps at 12 keeps its 6-set floor). Stored as
`AIProgrammerMuscleGuidance.adequacyTolerance` (deload only) and used by the
validator, planner, feasibility and shortlist (`adequacyToleranceFor`). Planned
rule 9 adds: during a deload aim for recommendedSets; the deload itself is not
a reason to go lower.

### 12.3 Ending a reactive deload early
`POST /api/programming/periodization/end-reactive-deload` (409 when none is
active): closes the reactive window yesterday, clears the cooldown, records a
'manual' event. Scheduled deload weeks are unaffected. `GET /periodization`
now returns `reactiveEvidence` (the triggering event's signals with names); the
Insights card lists the declining exercises and has an "End this deload now"
button.

### 12.4 Verification
`tests/coaching/reactiveDeclinePerExercise.test.ts` (7),
`tests/ai-programmer/deloadVolume.test.ts` (6). Full suite 2235 tests: the same
245 known date-rotation failures, 0 new. Replay 10/10 (the replay stub now
gives every member of a shared group one exercise before filling minimums).

### 12.5 Deployed 2026-10-11 06:49Z
* Commit `7a94cc2` on `main`. Backup:
  `deployment-backups/pre-7a94cc2-20261011T064924Z.sqlite`.
* New drop-in `/etc/systemd/system/workout-logger.service.d/exercise-pool.conf`
  -> `AI_EXERCISE_POOL_MODE=wide`. Rollback: delete it, `daemon-reload`,
  restart (package pool; all schema changes additive, nothing to migrate).
* Verified: service active, `/api/health` ok, running process has
  AI_PROGRAMMER_ENABLED, AI_PLANNED_GENERATION_ENABLED, AI_WEEK_GENERATION_MODE
  =explicit and AI_EXERCISE_POOL_MODE=wide; tables `day_notes` and
  `injury_pauses` created; `/injuries`, `/periodization` (with
  reactiveEvidence) and `/week` (targetAllocationsBasis "completed", 23
  allocations) respond. Scratch dir `~/wl-paid-test` removed.
* Left to the owner: the reactive deload stored before the fix (through
  2026-10-14) is still active; its evidence predates per-exercise trends.
  End it with "End this deload now" on Insights if wanted.

---

## 13. Insights and Coaching pages (2026-10-11, owner-approved)

Owner feedback: Insights showed only a vague deload note; Coaching was only
exercise preferences. Split by question: Insights = what is happening (facts
from logs, no AI); Coaching = what to do about it (AI-written, grounded in
those facts).

### 13.1 Reactive deload evidence, tightened further
Running the per-exercise trigger (12.1) on the production history showed two
remaining false signals: an exercise whose early/late averages dipped while it
ended higher (overhead extension 30.9 -> 38.5 kg counted "down"), and one
exercise counted for two targets (triceps and triceps long head). Now an
exercise is "down" only if it also ends lower than it started, and each
declining exercise supports one target (targets with the fewest declining
exercises claim theirs first). Production history re-evaluated: the
2026-09-17 reactive deload would have been "watch" (brachialis only), and
2026-10-06/08/09 "clear". So both reactive deloads (Sep 17-23, Oct 8-14) were
false; with the scheduled Oct 5-7 week, three deloads in four weeks.

### 13.2 Insights (`GET /api/insights`, `src/insights/insightsService.ts`)
* Strength progress: per exercise, best set per session as estimated 1RM
  (Epley; reps for unloaded work), deload sessions marked and excluded from
  status. Status: new best (beats every earlier session by 1%), stalled (no
  new best in the last 3 sessions, 4+ sessions), else improving / dropping /
  holding from the early-late trend, which must agree with first vs last.
* Weekly volume: direct sets done vs required per muscle per week (6 weeks;
  leading weeks with no logged work dropped). Required = the saved week
  program's allocations, else the planner as of the week start (cached for
  finished weeks).
* Consistency (gym days done vs scheduled, sets done vs prescribed), goal
  check-ins (last self-assessment, next due), deload history (from the event
  log). Page: training state card with evidence + "End this deload now",
  then these sections; advisories and techniques kept below.

### 13.3 Coaching (`/coaching.html`, `/api/coaching/*`)
* Weekly coach review: ONE paid call (`mode: coach_review`) on the user's
  click, at most one per programming week unless "Write a new review"
  (`regenerate`). Facts: goals, training state and deloads, up to 15
  exercises (goal or 3+ sessions) with recent best sets, 4 weeks of volume
  and consistency, check-ins, 14 days of notes, injury pauses, accepted
  advice, and swap options (same-primary-target alternatives, paused areas
  excluded) for stalled/dropping exercises.
* Output checked strictly (`validateCoachReview`): sizes, every plateau
  exercise must be a stalled/dropping exercise from the facts, a swap target
  must be one of its swap options. Invalid -> 502, nothing saved. Tables
  `coach_reviews`, `coach_advice`.
* Advice accept/dismiss. Accepted advice (21 days) goes to session
  generation as `context.coachAdvice` (planned rule 7). An accepted swap also
  sets a 14-day avoid on the old exercise and a 14-day prefer on the new one,
  unless the user already has a rule for either.
* Settings moved: the old Coaching page (exercise preferences, training
  experience) is now "Training settings", reached from Profile; the nav's
  Coaching item opens the review.

### 13.4 Exercise preferences now reach AI generation
Finding: only the legacy deterministic planner read exercise preferences; the
AI path ignored them, so an "avoid" rule had no effect on AI workouts. Now
(both pool modes) an avoided exercise is never prescribed; preferred and
disliked are passed to the model (`userPreference`, rule 7) and order the wide
shortlist (preferred first, disliked last).

### 13.5 Verification
`tests/insights/insightsService.test.ts` (9), `tests/coaching/coachReview.test.ts`
(7), two more cases in `reactiveDeclinePerExercise.test.ts`; frontend wiring
tests updated for the nav move. Full suite 2253 tests: the same 245 known
date-rotation failures, 0 new. Replay 10/10. Pages rendered headlessly
(jsdom) against a production-data copy: no script errors.

### 13.6 Deployed 2026-10-11 07:10Z, and one real coach review
* Commit `3672ad0`; backup `deployment-backups/pre-3672ad0-20261011T071014Z.sqlite`.
  Tables `coach_reviews`, `coach_advice` created; `/api/insights` ~0.5 s cold;
  pages 200. No flag needed (the review is only written on the user's click).
* One paid `coach_review` call on a `.backup` copy on the VM (scratch, since
  removed): 5,500 in / 578 out tokens, passed every check, grounded in the
  facts (pushdown +62.6%, triceps 11/22, long head 4/12, cross-body hammer curl
  -7.1% -> swap to cable rope hammer curl, check-ins overdue).
* Flaw found and fixed (follow-up commit): it read the three deloads as "your
  body needed rest". Reactive deloads now carry `confirmedByCurrentRule`
  (re-evaluated at their start with the current rule); the instruction (5a)
  says to describe an unconfirmed one as a measurement artifact, and Insights
  labels it a false alarm.

---

## 14. Equipment per logged exercise; goal check-in button (2026-10-11)

Owner report: (1) Insights showed "new best" for wrist curl 7.7 -> 36 kg because
dumbbell and barbell sessions of the same exercise were compared (also hammer
curl DB vs cable, chest press barbell vs Smith); the equipment was only in
session notes. (2) Insights said "check-in due" but the Goals page had no way
to record one (the assessments API existed, no UI).

### 14.1 Equipment
* `workout_exercises.equipment` (TEXT, nullable; additive migration). A new
  exercise row starts with the equipment last logged for that exercise, so
  planned and AI-committed sessions are pre-filled; null = not specified.
* `PATCH /api/workouts/:id/exercises/:exerciseId` accepts `{equipment}` alone
  (string up to 40 chars, or null). Logger: an "Equipment" picker on every
  saved exercise card, including past completed sessions (saves on change).
  Choices: the exercise's Blueprint options first, then barbell, dumbbell,
  ez-bar, cable, machine, smith machine, kettlebell, band, bodyweight, other
  (Blueprint lists are incomplete: flat bench has no Smith, pulldown no
  machine).
* Progress is compared only within one exercise + equipment: Insights strength
  series, the reactive-deload evidence and the coach facts. Untagged sessions
  form their own series.
* Backfilled from the owner's own session notes (production, at deploy):
  2026-09-11 overhead triceps extension = dumbbell; 2026-10-02 and 2026-10-06
  wrist curl = barbell; 2026-10-06 wide lat pulldown = machine. Everything
  else stays "not specified" until the owner tags it in the logger.

### 14.2 Goal check-in
Goals page: "Check in" on each active aesthetic goal opens a form (date, the
app's 1-5 scale from "significantly worse" to "significantly improved",
optional notes) posting to `/api/goals/:id/assessments`; each card shows the
last check-in and the next due date (last + review cadence).

### 14.3 Verification
New tests: equipment series split and default/PATCH (`insightsService.test.ts`),
barbell -> dumbbell switch is not a decline (`reactiveDeclinePerExercise.test.ts`),
check-in wiring (`tests/frontend/goalCheckIn.test.ts`). Full suite 2260: the
same 245 known failures, 0 new. Replay 10/10. Logger and Goals pages exercised
headlessly on a data copy: picker saves, check-in saves, no script errors.

### 14.4 "Other" days show as Other (2026-10-11)
Owner report: Sat 10/10 was changed to Other with a note, but the card still
said Badminton (with the raw note text under it). Section 11.3 had made a
note an annotation that never changed the day. Now `/week` (and `/today`)
return a non-gym day that has a note as `type: 'other', activity: 'other'`;
a gym day keeps its workout and just carries the note. Cards show "Other" and
"Note added" instead of a raw preview (the full note is in the day's modal).
Choosing a normal activity again on an Other day removes its note first;
clearing the note also restores the day.

## 15. Blueprint sync: three missing variations (2026-10-11)
Owner notes showed three real exercises logged under stand-ins because the
library lacked them:

| Date  | Performed                   | Logged as                  |
|-------|-----------------------------|----------------------------|
| 09/24 | decline barbell bench press | decline-dumbbell-fly       |
| 09/29 | single-arm lat pulldown     | neutral-grip-lat-pulldown  |
| 10/01 | decline dumbbell press      | decline-dumbbell-fly       |

The owner added them to workout-blueprint (ba784d4, signed off b90c302).

### 15.1 Snapshot
`npm run sync-blueprint` from b018abc (2026-08-29) to b90c302: 123 -> 143
exercises, none removed, development packages unchanged. Besides the three
(`decline-barbell-bench-press` and `decline-dumbbell-press` -> mid/lower pec,
`single-arm-lat-pulldown` -> lat width) the sync brings 17 other exercises
added in Blueprint since August (glute-bridge, step-up, side-plank,
copenhagen-plank, sissy-squat, ...), refreshed cues/mistakes/video fields on
all 123, equipment lists edited on 17, primary-target text on 3 curls, and
three target definitions reworded (triceps, rectus-abdominis,
core-anti-lateral-flexion). In wide mode all of them are eligible like any
other library exercise.

### 15.2 Secondary-target mapping
Three new free-text secondary phrases needed an explicit decision
(`docs/SECONDARY_TARGET_MAPPING.md`): `gluteus medius` and
`bottom-leg hip abductors` -> `gluteus-medius-minimus`;
`obliques and lateral trunk` -> `obliques`.

### 15.3 Effects on stored data
- Proposals generated but not yet committed against the old snapshot fail
  their Blueprint-commit staleness check and must be regenerated (checked on
  production before deploy).
- With owner approval the three stand-in rows above were re-pointed to the
  real exercises (`workout_exercises.exercise_id` only; sets unchanged),
  after a DB backup. This moves press-level loads off decline fly and the
  single-arm session off neutral-grip pulldown in Insights/trend evidence.

### 15.4 Verification
Full suite 2260: the same 245 known failures, 0 new. On a production copy the
three exercises appear in the valid pools for lower-pec/mid-pec and lat-width.

## 16. Attachment and count unit on every logged exercise (2026-10-11)
Owner notes: "Used v bar for pushdowns" (10/01) and "The rep count logged for
suitcase carry is actually step count" (10/09). Owner asked for both to be
universal, usable on any exercise whenever needed, not tied to particular
exercises.

### 16.1 What was added
- `workout_exercises.attachment` (free short string; the logger offers
  straight bar, EZ-bar, V-bar, rope, single handle, lat bar, close-grip
  handle, neutral-grip handle, ankle strap, band, belt, other) and
  `workout_exercises.rep_unit` (`reps` | `steps` | `seconds` | `metres`; null
  = reps). Shared definitions: `src/contracts/loggingOptions.ts`.
- Like equipment, a new exercise row starts with the attachment and unit last
  logged for that exercise (a carry stays in steps). POST and PATCH
  `/api/workouts/:id/exercises[/:exerciseId]` accept both; null clears; each
  may be sent alone.
- Logger: every exercise card has one row with Equipment, Attachment and Count
  pickers (all choices on every exercise). Changing Count relabels the set
  column in place without losing unsaved entries. "Last time" and the copied
  workout text show a non-reps unit and the equipment/attachment.

### 16.2 How the numbers are read
- Progress series are per exercise + equipment + attachment + unit
  (`progressSeriesKey`), in Insights and in the reactive-deload evidence:
  rope vs straight-bar pushdowns are never compared.
- Steps, seconds and metres are not reps: no estimated 1RM, no completed reps
  and no load in history (`historicalService`), the goal-phase load trend
  skips them, and double progression only reads sessions logged in reps (none
  when the latest session was not in reps). Set counts (volume) are unchanged.
- Insights shows such a series by its heaviest load ("24 kg × 40 steps"), or
  by the count when unloaded. The coach review facts carry the same labels.
- Calorie Tracker export gains `rep_unit` per exercise (additive;
  docs/CALORIE_TRACKER_INTEGRATION.md).

### 16.3 Verification
`tests/logging/logOptions.test.ts` (API, defaults, history/Insights/trend
maths, export, logger lists match the contract, logger script loads with
app.js). Full suite 2270: the same 245 known failures, 0 new. Logger checked
headlessly on a production data copy: 9/9 cards show the three pickers,
changing the carry to steps saved and relabelled the column, Insights then
read "17.5 kg × 45 steps". That check caught a duplicate `capitalize`
declaration that stopped the logger loading, fixed before commit; the new
script test guards it.

## 17. Coach review: off-rule advice no longer discards the review (2026-10-11)
Owner's first "Write this week's review" failed with
AI_COACH_REVIEW_OUTPUT_INVALID. Production log (request c0f7d907): the only
error was `plateaus[0]: overhead-triceps-extension is "flat", not stalled or
down`. The model advised on an exercise that went 27 -> 33 -> 21 -> 15 -> 15 ->
27 kg (status flat because it ended where it started); the validator then
rejected the whole review, so the paid call produced nothing.

Changes (`coachReviewService.validateCoachReview`):
- A plateau item that breaks the rules (unknown exercise, not stalled/down,
  duplicate, bad kind/text, swap not in swapOptions) is dropped and logged
  (`droppedPlateaus` on the `[coach-review] saved` line); the review and the
  valid items are saved. A malformed review (headline, lists, recovery) still
  fails and saves nothing. A swap target on a non-swap item is ignored.
- Since section 14 an exercise can have several series (per equipment, now
  also attachment/unit). The old check looked up one series per exercise id;
  an exercise now qualifies when any of its series is stalled or down.
- The Coaching page shows the plain error message, not the error code.

Tests: `tests/coaching/coachReview.test.ts` (dropping, multi-series
eligibility, production case saved with no advice). Full suite: the same
245 known failures, 0 new. No paid call made; the owner retries the review.

### 17.1 Data correction: overhead triceps extension equipment (2026-10-11)
Owner: "15 kg days are of dbs. 27 kg are of cables". Tagged through the PATCH
API after a backup (deployment-backups/pre-ohe-equipment-20261011T163635Z.sqlite):
09-07 (15/21/27 kg) cable, 09-15 (21/27/33 kg, has 27 kg sets) cable,
10-01 (21/27 kg) cable, 09-21 and 09-28 (10-15 kg) dumbbell (09-11 was
already dumbbell). 09-18 (21 kg x 8, then 15 kg x 15/12) was tagged cable
after the owner confirmed it; 09-24 has no completed sets.
Result: cable series flat (27 -> 33 -> 27), dumbbell series 15x15 -> 15x12.

## 18. Reps in reserve (RIR) per set in the logger (2026-10-12)
Context: reviewing Jul-Oct logs, effort could not be judged because no set
had RIR (`workout_sets.rir` existed and the progression rule and history
already read it, but the logger had no field). Owner: "there is no RIR slot
for me to note in the app."

Changes:
- Logger (`public/logger.html`, `style.css`): an optional RIR box on every
  set row (whole number, 0 = failure) with a one-line hint. A logged
  exercise's table shows an RIR column when any set has one; Copy text adds
  `@RIR n` to those sets.
- API (`routes/workouts.ts`): POST/PATCH reject a set `rir` that is not a
  whole number 0-10 or null (400). Missing RIR stays null, never 0.
- Insights best set ends with `@ RIR n` when logged, so the coach review
  sees effort; the coach instruction (rule 5b) says RIR 3+ on a stalled
  exercise means harder sets first, RIR 0-1 means a real plateau.
- Unchanged and now fed: double progression (`progressionEngine`) advances
  only when the top of the range is reached at RIR <= Blueprint's typical
  working max (a set without RIR counts on reps alone); history averages RIR.

Owner, 2026-10-20: logging RIR 0 on most sets is intentional; 0 means
the set went to failure (real data: mostly 0 or 3 since 2026-10-13).

Tests: `tests/logging/setRir.test.ts`. Full suite 2276: 0 new failures vs the
245 known baseline (two further date-dependent tests fail on 2026-10-12 with
or without this change). Headless check: RIR boxes render, save, and show in
the table.

## 19. Body measurements on the Goals page (2026-10-12)
Context: the `measurements` table and API existed (goal phase review reads
goal-tied readings) but no page could write them, so it was empty and
physique change could not be judged. Owner approved building the form.

Changes:
- `src/contracts/measurementMetrics.ts`: presets (bodyweight kg; upper arm
  relaxed/flexed, forearm, chest, shoulders, waist at navel, thigh, calf in
  cm) and a direction per measurement: bigger = better, waist/hips/body fat
  = smaller is better, bodyweight (or a typed name with "weight") = tracked,
  not judged. Typed names use those keywords; anything else = bigger.
- Goal phase review (`goalPhaseEngine.classifyMeasurementTrend`): uses that
  direction; neutral metrics are skipped. Before, a shrinking waist counted
  as "declining" and would have recommended "adjust". The strict first-vs-
  last comparison (no noise band, section "Remediation §4") is unchanged;
  the coach prompt says changes under 0.5 cm are tape error.
- API (`routes/goals.ts`): POST validates date (YYYY-MM-DD, not future),
  positive value, name 1-60 and unit 1-12 characters (trimmed); new
  `DELETE /api/goals/measurements/:id` (typos) and
  `GET /api/goals/measurements/summary` (presets + per-measurement series).
- `insightsService.bodyMeasurements`: series by name (case-insensitive) and
  unit; change = latest - first; verdict better/worse/same/not judged.
- Goals page: "Body measurements" section with the form (date, preset or
  typed name, value, unit, optional goal, note) and one card per measurement
  (latest, change since first with verdict badge, all readings with delete).
- Coach review facts gain `bodyMeasurements` (last 6 readings each, change
  and verdict); instruction rule 5c.

Tests: `tests/goals/bodyMeasurements.test.ts`. Full suite 2284: 0 new
failures vs baseline (plus the two date-dependent ones noted in s18).
Headless check of the Goals page: save, verdict, typed name, delete.

## 20. Legs for badminton: Athletic day, Blueprint 89dd2d6 (2026-10-18)
Owner: legs are not to be trained for size like other muscles but to be
fit and flexible for badminton; the leg day leaves the weight-training
routine and becomes an endurance day, whole-body where possible, legs-only
otherwise; the programmer generates it on request; Push, Pull and Upper
stay as they are. Owner choice for the Legs injury pause: while it is on,
the Athletic day is a rest day.

Blueprint sync b90c302 -> 89dd2d6 (143 -> 163 records): 20 drills with a
`training_mode` (power, agility, movement-strength, mobility-hold,
mobility-dynamic, conditioning), six athletic functional goals, mode
prescription profiles (unit reps/seconds, sets, rest, effort, frequency;
no RIR). Fixes the sync needed:
- `programmingProfiles.matchesProfileRule`: exact training_mode match, as
  in Blueprint (without it a heavy compound resolved to power 3-6).
  `modePrescriptionFor(id)` ports Blueprint's ModePrescription.
- Drill isolation (`src/blueprint/athletic.ts`): `roleFor` gives a drill a
  role only for the athletic goals it carries, so no physique pool,
  substitute list or shortlist ever contains one; `calculateExerciseExposure`
  credits a drill only to its functional goals (its secondary muscle phrases
  are not muscle volume).
- Secondary phrases: `hip abductors` -> gluteus-medius-minimus,
  `foot and ankle stabilizers` -> ankle-resilience (functional goal),
  `lower back` unmapped (docs/SECONDARY_TARGET_MAPPING.md).

Leg training setting (`training_profiles.leg_training`, default
'hypertrophy'; `LegTrainingRepo`; GET/PUT /api/programming/leg-training;
"Leg training" section on the Program page). In 'athletic':
- Rotation push/pull/athletic/upper (`ATHLETIC_SESSION_PURPOSE_ROTATION`,
  `assignSessionPurposes(..., legTraining)`); the Athletic day follows the
  Legs day rules (never Monday, off badminton days when possible).
- Leg physique targets are removed from the plan input
  (`assembleWeeklyPlanInput`), so no session, Program goals panel or
  Insights requirement includes leg growth volume; the AI brief also marks
  any leg target `trainedAthletically` (ineligible) as a second guard.
- `SessionPurpose` gains 'athletic': no physique target (abs included) is
  compatible with it, and athletic goals are compatible only with it.

Athletic day generation (`src/athletic/athleticSession.ts`):
- Context: all 20 drills with their mode prescriptions, block, goals,
  last-done date; the six goals with last trained date; 28 days of drill
  history; yesterday/tomorrow activity; notes; injury pauses.
- Shape: warm-up (mobility-dynamic, 1-3) -> quality (power / agility /
  movement-strength, 1-4) -> conditioning (whole body, 1-2) -> cool-down
  (mobility-hold, 1-2); at most 9 drills.
- Checks (`checkAthleticOutput`): drills only, no repeats, block counts,
  total; numbers clamped into the drill's ranges and order fixed to the
  block order (noted in warnings); goal must be one the drill carries.
- Stored as a normal proposal with `sessionKind: 'athletic'`; drills have
  `repUnit` and `block`, `rirMin/rirMax` null (type now nullable).
- `generateSession`: requestedSessionPurpose 'athletic' (route accepts it),
  or the date's rotation slot is athletic -> Athletic path, same duplicate
  guard and same-context retry gate. Week runs use it for the Athletic day.
- Legs injury pause on -> `AI_ATHLETIC_PAUSED` (409) before any paid call;
  week run skips the day; per-day status `injury_pause` ("Rest day — Legs
  injury pause is on"); commit of an approved Athletic proposal re-checks
  against a fresh Athletic context, so it is refused too.
- Commit writes `rep_unit` per drill, RIR null.

Logger/Insights/coach:
- /api/blueprint/exercises adds `training_mode` and `drill` (prescription).
- Logger: drill note ("Drill · sets × amount per side · rest. Effort: ..."),
  planned amount with unit, no RIR box for drills, weight optional; a drill
  logged by hand starts in its Blueprint unit.
- Insights: drills excluded from strength progress; new `athletic` section
  (days with drills per week; per drill sessions, last, best set).
- Coach review facts: `legTraining`, `athletic`; rule 5d.

Not changed: physique-session rules and validators, generate_week legacy
contract, deterministic engine behaviour for 'hypertrophy'.
Tests: `tests/athletic/athleticDay.test.ts` (16); Insights section list
updated. Full suite 2300: 0 new failures vs baseline. Headless check on a
copy of the production DB: Program (setting, Thursday Athletic +
injury_pause), Logger (drill note, seconds, no RIR), Insights section.

### 20.1 Leg strength, daily athletic add-ons, build-up, timed tests (2026-10-18)
Owner, after an objective review of section 20: muscle/strength work is
essential for badminton legs; do not restrict leg strength variations to
a few (any relevant variation, since leg strength is prioritized with
athletic ability); add real athletic work (5-10 min) to Push/Pull/Upper
days, careful with recovery so endurance work is never done every day
without recovering.

- Athletic day gains a **strength** block (2-3 lifts) between quality and
  conditioning: blocks warmup 1-2, quality 1-3, strength 2-3, conditioning
  1-2, cooldown 1-2; at most 10 exercises. Eligible lifts
  (`liftCatalogue`): every non-drill exercise that trains a leg physique
  target or carries an athletic goal (42 today, e.g. squats, split squats,
  RDLs, step-ups, Nordics, calf raises, Copenhagen plank, tibialis raise,
  leg extension). Prescription: Blueprint profile reps (acceptable range
  allowed), Blueprint typical working RIR (1-3), sets 2-4, rest 60-180 s
  (app defaults: hypertrophy profiles carry no sets/rest). Lifts credit
  their leg target and appear in strength progress/plateau advice; the
  context lists each lift's last 3 sessions.
- **Build-up phase**: fewer than 3 Athletic days in the last 28 days
  (first sessions, after an injury pause) -> drills at minimum sets and
  at most the lower half of the amount range, lifts at most 3 sets and
  RIR 2+. Enforced by clamping; the commit re-check ignores build-up caps.
- **Athletic add-on** (`src/athletic/athleticAddOn.ts`) on Push/Pull/Upper
  when leg training is athletic, deterministic (no extra AI call):
  'mobility' (1 dynamic + 1 hold) when yesterday or tomorrow is a hard
  day (badminton, the Athletic day, or a day already holding power/
  agility/conditioning drills), else 'active' (1 agility/power + 1
  conditioning). Least recently done drill per kind, low-end numbers,
  trimmed to 10 minutes. A day with an active add-on is a hard day for
  its neighbours, so active add-ons are never adjacent. None while the
  Legs pause is on. Stored as `proposal.athleticAddOn` (outside the AI
  output and its validators); commit writes it after the session (skipped
  if the Legs pause is on by then). Program page shows it under the
  proposal with its reason and minutes.
- **Measurements**: presets standing broad jump, vertical jump (bigger is
  better), four-corner footwork time, shuttle run time (smaller is
  better); a typed name with "time"/"sprint" or a unit in seconds/minutes
  is judged smaller-is-better.
- Coach rule 5d updated for leg lifts and add-ons.

Tests: athleticDay.test.ts now 22; bodyMeasurements direction test.
Full suite 2307: 0 new failures vs baseline.

### 20.2 Owner's real context: durability, gym only, no shadowing (2026-10-18)
Owner: recreational player who learns technique by playing; no court time
for drills, only the gym among other people; does not know how to shadow.
The Athletic day and add-ons are for a durable, flexible body, no further
injuries and much better leg fatigue resistance (currently very low), not
for technical/skill ability. Gym has benches, cables, a tyre (usually
taken), sandbags, medicine balls of several weights, a jump rope; no box,
no rowing machine. Floor space is fine for shuttle runs, lateral shuffles
and lateral bounds (owner kept them).

Changes:
- Athletic context v3: `athlete` statement (the aims above, in order);
  goals ordered durability first (ankle resilience, landing control,
  mobility, conditioning, then power, agility); block purposes reworded
  (quality = resilience, strength = strength + fatigue resistance).
- Instruction: not skill/footwork training; power/agility drills are low
  volume for tissue resilience; at least one strength lift in the upper
  part of its rep range for fatigue resistance; conditioning favours
  longer work intervals; favour `preferred` exercises.
- Drills are filtered by the profile's equipment (bodyweight always
  available; a drill needs any one of its listed items). Stand-in:
  drop landing with a bench ("step off and land; never jump onto it");
  box jump has none (a bench is not safe to jump onto). Rowing machine
  intervals stay out (a cable row is not a substitute: it is back work,
  not leg-driven endurance).
- Active exercise preferences apply to drills and Athletic-day lifts:
  'avoided' are left out, 'preferred' are marked.
- Add-on 'active' = one ankle/landing-resilience drill + one
  conditioning drill (was agility/power + conditioning); same filters.
Data (owner-stated facts, applied after deploy with a backup): 'jump rope'
added to available equipment; shadow-badminton-intervals and
four-corner-shadow-footwork set to 'avoided' (permanent, reversible from
the preferences).
Tests: athleticDay.test.ts 25. Full suite 2310: 0 new failures.

## 21. Manual workout duration and Calorie Tracker sync (2026-10-21)

Why: Calorie Tracker picks the day's food target from session type and
duration. A read-only check of production (2026-10-20) found
duration_minutes wrong on 10 of 26 gym sessions (1, 8, 9, 10, 26, 187 and
453 min) and on all 7 badminton sessions (1-6 min): the logger timed from
page load, so a reload, a session logged afterwards, or a page left open
broke it. Owner approved (relayed from the Calorie Tracker session):
1. duration typed by the user in whole minutes, and 2. a job that copies
finished sessions into the Calorie Tracker repo.

Duration (decision: required field, no automatic timing):
- Automatic timing was not made the fallback because it cannot be fully
  reliable here: even timed from the session's real start, a forgotten
  "Finish" (the 453-min case) or a session logged after playing (every
  badminton entry) gives a confident wrong number. So the field is
  required and nothing is ever prefilled.
- Logger: "Duration (minutes)" on the finish bar (empty; Finish refuses a
  blank or invalid value); on a completed session, the duration is shown
  with "Change duration (minutes)" + Save. A legacy duration is flagged
  "recorded by the old timer, often wrong". The page-load "Elapsed" clock
  is gone. Badminton details stay editable after finishing.
- API: duration_minutes is null or a whole number 1-360 (DURATION_MAX_MINUTES,
  6 h: above the longest badminton day). PATCH to completed without a
  duration -> 400 DURATION_REQUIRED; clearing a completed session's
  duration -> 400. `duration_source: 'user_entered'` marks a typed value;
  a duration sent without it (an old cached logger page) is stored
  'legacy'.
- Column workout_sessions.duration_source ('user_entered' | 'legacy' |
  null). On start-up every duration without a source is set 'legacy'
  (all pre-existing durations).

Sync (src/services/calorieTrackerSync.ts; contract in
docs/CALORIE_TRACKER_INTEGRATION.md "Pushed file"):
- data/workout_sessions.json in Kanadhibhotla-sri-charan/food_and_workout_tracker,
  via the GitHub Contents API (GET sha, PUT; 409/422 -> re-fetch and
  retry, up to 5 attempts). Commit message "Sync workout sessions", only
  when `days` changed (generated_at alone never commits).
- 14 IST dates, today first, `[]` for empty days; completed sessions
  only: session_id, session_type, duration_minutes, duration_source,
  badminton {intensity, format, games_count} | null. No exercises, sets,
  notes, goals, AI data.
- Triggers: start-up, Finish workout, an edit of a completed session's
  duration or badminton details, every 15 minutes. One serialized runner
  (a request during a run queues one more). Failures are logged, never
  fail the user's request. Off unless CALORIE_SYNC_TOKEN is set
  (systemd drop-in ops/systemd/workout-logger-calorie-sync.conf; token in
  a chmod-600 env file on the VM only).
- The Athletic leg day appears as session_type 'gym'.
Tests: tests/sync/calorieTrackerSync.test.ts 16; 11 existing route tests
now send a duration when finishing. Full suite 2326: 0 new failures.
Headless logger check: blank Finish refused, 65 -> completed
user_entered, legacy 2 -> edited 120 user_entered, badminton intensity
edited after finishing.

## 22. Weekly volume ledger, shadow mode (2026-10-25)
Context: production review of 10-04..10-25 (owner: "the model is trying to
cover every possible muscle on each given day ... think like a trainer").
Findings:
- The deterministic session planner picks every eligible muscle and fills
  to the 10-exercise cap (10-19 and 10-20 used all 10). It never asks
  whether a later session this week could take a muscle; the AI only
  fills exercises, and adequacy completion adds back planned muscles.
- Abs are accessory (last), capped at 2 exercises, and obliques win the
  alphabetical tie: rectus abdominis was deferred in every logged plan.
- Goal muscles got about a third of their reference (triceps about 7-10
  of 24, brachialis 5 of 8 in the 10-19 week).
- getDevelopmentReference credits every member of the shoulders, back,
  forearms and core packages with the WHOLE package (side, rear and front
  delt 14/wk each; lats, back, traps 16; each abs target 32). Chest,
  triceps and biceps are scoped correctly. Fixing it in the engine breaks
  77 tests: the live planner's floors are built on those numbers. Left
  for the planner rework; reverted.

Owner decisions:
- Growth decides the numbers, not frequency. Direct and indirect work both
  count. Spread across the week is free; abs not every day.
- D1 (a) Efficient numbers for non-goals; D2 goal muscles on every
  suitable day; D3 aim 60 min, never over 90.
- Non-goal numbers are due over a 14-day cycle per muscle; the next cycle
  starts as soon as the number is reached. An unfinished cycle keeps
  counting past day 14 and is offered first.

Built (shadow only; generation unchanged):
- `src/ai-programmer/planning/weeklyLedger.ts`: statuses must / can_wait /
  overdue / met / not_today per muscle; logged as
  `[ai-programmer] weekly ledger shadow` next to every session plan when
  `AI_WEEKLY_LEDGER_MODE=shadow` (drop-in
  `ops/systemd/workout-logger-weekly-ledger.conf`, anchor 2026-10-19).
- The ledger uses its own per-muscle package numbers (`ledgerReference`):
  side delt 10, rear delt 4, lats 6, back 6, traps 4, forearms 6 each,
  obliques 8, rectus abdominis 24 (core profile frequency 4/wk), front
  delt none (Blueprint leaves it to pressing). Goals unchanged: triceps 24,
  long head 8, brachialis 8.
- Future days use the purpose the user actually trained on that weekday in
  the last 21 days (committed proposals), else the rotation.
Dry run on real data for Mon 10-26 Push: must = triceps 12, long head 4,
rectus abdominis 5; can wait = upper/mid/lower pec, side delt, obliques.
Tue 10-27 Pull: must = brachialis 4, rectus 6, forearms 2+2; can wait =
lats, back, biceps, rear delt, traps, obliques.
Tests: `tests/ai-programmer/weeklyLedger.test.ts` (12). Full suite: same
failures as before (246-247, all pre-existing and date-dependent).
Design: `docs/WEEKLY_VOLUME_PLANNING_DESIGN.md`. Next: one week of shadow,
then the planner rework (statuses drive slots; reference scoping fixed).

### 22.1 Volume shown to the owner (2026-10-25, 987f0b2)
`GET /api/insights/volume` exposes the ledger read-only (work through
today counted); the Today page shows it as a Training volume card. Part of
the dark UI change (change log 92). Generation still unchanged.

### 22.2 Blueprint schema 2 numbers; 1-week cycle for every muscle (2026-10-27)
Blueprint shipped the logger change requests (b1381ad, 44b73ae, 74cf1a1,
1d23acf; schema_version 2): weekly credited-set numbers per muscle
(volume-targets.yaml), sub-region shares, target_credit per exercise,
time per exercise, volume levels per goal, variants, session rules,
mobility dose. Owner decisions, 2026-10-27:
- **1-week cycle for every muscle.** The 14-day cycle for non-goal muscles
  is dropped (Blueprint numbers are per 7 days; a 14-day count would
  halve them to near "minimum"). Goals at "priority", the rest at
  "efficient", per calendar week.
- **No minimum rest between sessions.** Blueprint's min_hours_between
  (48 h; 24 h for abs/calves/forearms/neck) is not applied: four training
  days in a row are normal for the owner. Per-session maximums still
  apply.
- Worked check before the decision (Push/Pull/Push/Pull, Blueprint
  credit and time data): every muscle reaches its weekly number in about
  21-22 sets / about 60 min per session; traps need 2 sets of shrugs while
  legs are paused (Blueprint expects deadlifts to cover them).
- **Goal muscles may go past Blueprint's per-session maximum** (owner,
  2026-10-27). Brachialis (14, max 6) is a pull muscle, so on
  Push/Pull/Push/Pull it gets 2 sessions = 12 at Blueprint's maximum;
  triceps (16, max 8) had no slack. Non-goal muscles keep the maximum.
Step 1 (change log 93): the ledger and the Training volume card read
Blueprint's numbers and count credited sets; the logger's own numbers
(ledgerReference) are gone. Generation is still unchanged (shadow).

