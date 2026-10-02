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
* **Observation tooling** (outside the repo, read-only, works on DB copies):
  `/home/ubuntu/ai-observe/observe.sh [isoWatermark]`; `observeAsOf.mjs` and
  `planCompare.mjs` for proposals whose date is already locked (pinned clock
  + compare against the logged shadow plan).
* **Rules followed throughout:** no provider calls against production for
  testing; isolated scratch checkout + DB copies for real-provider evals;
  never modify or approve users' proposals; commit/deploy only on explicit
  approval.
