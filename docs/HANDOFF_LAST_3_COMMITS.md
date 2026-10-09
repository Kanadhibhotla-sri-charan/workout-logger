# Handoff — the last three commits (5cc0348, 5332ef1, ea57848)

Read this first if you are picking up the project. It explains what the
three most recent commits on `main` do, how they fit together, how to run
and verify them, what is live in production, and what is still open — so
you can start working without any other context.

Deeper background (why the AI path was redesigned, earlier commits,
incidents): `docs/AI_GENERATION_REDESIGN_DECISION_LOG.md`.

| Commit | Date (IST) | Title | Size |
|---|---|---|---|
| `5cc0348` | 2026-10-01 22:52 | Add explicit week generation behind `AI_WEEK_GENERATION_MODE` | 13 files, +1497 / −11 |
| `5332ef1` | 2026-10-01 23:29 | Show explicit week generation on the program page | 3 files, +330 |
| `ea57848` | 2026-10-02 12:21 | Add a decision log for the AI generation redesign | 2 files, +338 (docs only) |

---

## 0. Two-minute orientation

* **App:** single-user workout programmer. Node/TypeScript + Express +
  SQLite (`better-sqlite3`), static HTML/JS front end in `public/`.
  Exercise knowledge comes from the vendored "Blueprint" snapshot in
  `src/blueprint/snapshot/` (source repo `workout-blueprint`).
* **AI Programmer** (`src/ai-programmer/`): asks an LLM (Velona gateway,
  model `qwen/qwen3-next-80b-a3b-instruct`) for workout **proposals**. A
  proposal is never a workout until the user approves and commits it
  (`pending → approved → committed`, or `rejected` / `expired`).
* **How a day is generated today ("planned generation")**:
  `buildProgrammerContext` → deterministic `planSession` (SessionPlan:
  which targets, how many exercises, which exercises count) → compact
  planned context to the AI → `runProposalPipeline` (schema → plan
  conformance → repair → domain → completion → adequacy) → pending proposal.
* **What these three commits add:** a way to generate the whole week's
  sessions **on purpose** (a button / one POST), instead of the old
  behaviour where merely *reading* an unsaved week silently paid for an
  AI call. Plus the UI for it and a written decision log.

---

## 1. Commit `5cc0348` — explicit week generation (backend)

### 1.1 The problem it fixes
Before this commit, `GET /api/programming/week` and `GET /api/programming/today`
called `ensureWeekProgramGenerated`. For a week with no saved program and
`AI_PROGRAMMER_ENABLED=true`, that made a **paid** AI `generate_week` call
(~29.5k input + ~3.9k output tokens) and wrote the AI's week directly into
`programs` / `program_sessions`. Problems seen in production:

* any client (including a scraper) could trigger it, for **any** date;
* concurrent page loads paid several times (9/28: three parallel calls
  from one phone);
* a failure saved nothing, so every reload paid again;
* a provider outage made the week view return an error;
* the user deleted those AI days anyway and used per-day proposals.

### 1.2 What it does
A mode flag, `AI_WEEK_GENERATION_MODE`:

* `legacy` (the default when unset) — exactly the old behaviour,
  byte-for-byte. This is the rollback path.
* `explicit` —
  * **Reads are pure.** `GET /week` and `GET /today` never call the
    provider and never write. A saved week renders as before; an unsaved
    week renders as a "skeleton" (7 days, activities, logged sessions, no
    prescriptions). Both responses gain an additive `generation` field.
  * **Generation is explicit.** `POST /api/ai-programmer/generate-week
    {weekStart, confirmRetry?}` creates **one pending proposal per
    remaining gym day**, using exactly the same planned pipeline as
    single-day `generate-session`. Nothing is written to
    `programs` / `program_sessions`.

### 1.3 Rules (approved decisions D1–D7)
* **D1** Output is per-day pending proposals (existing lifecycle, approve
  and commit per day as before).
* **D2** Later days are planned knowing earlier days' planned work
  ("projected exposure"); the same SessionPlan is used — no second planner.
* **D3** Allowed weeks: the user's **current** programming week, and **next**
  week only on Saturday/Sunday (user timezone). Never past weeks, never
  further ahead. Reads of any week are always allowed.
* **D4** Week-run proposals expire at the **end of their target date**
  (midnight in the user's timezone). Single-day proposals keep their 24h TTL.
* **D5** Run / lock / gate state is stored in the **database** (the process
  had restarted many times; in-memory state would be lost).
* **D6** `generate_session` is not given a global provider circuit breaker.
* **D7** In explicit mode reads never generate and never build a hidden
  deterministic prescription.

### 1.4 Request flow
```
POST /api/ai-programmer/generate-week {weekStart}
  → 409 if mode ≠ explicit (or AI / planned generation disabled)
  → 400 if weekStart is not a Monday or outside the allowed window
  → eligible days = gym days with date ≥ today, no workout session,
                    no pending/approved proposal
  → 202 {status:"in_progress", runId} if a live run already exists
  → 409 AI_WEEK_GENERATION_NOTHING_TO_DO if no eligible day
  → 503 AI_WEEK_GENERATION_BACKOFF if a recent provider failure backs off
  → acquire guard (one synchronous DB transaction, BEFORE any await)
  → 202 {status:"running", runId, days}
  → background, for each day in date order:
       re-check eligibility (skip if it changed)
       build context with projectedSessions (earlier days' live proposals)
       same-context quality gate (skip as "gated" unless confirmRetry)
       planSession → refusal? day "refused", never paid
       AIProgrammerService.generatePlannedDayProposal(...)   ← paid call
         (same private generateFromContext as generate-session)
       persist pending proposal with week_run_id + end-of-day expiry
  → finish run: completed | partially_completed | failed
```
It returns 202 straight away because one provider call per day is longer
than a reverse-proxy timeout. Progress is read from `GET /week`'s
`generation` field.

### 1.5 Concurrency and the lease
* Table `ai_week_generation_runs` has a **partial unique index**
  `UNIQUE(week_start) WHERE status='running'` → at most one running run per week.
* `WeekGenerationRunRepo.acquire` runs in one synchronous transaction:
  stale running run → marked `abandoned`; fresh running run → returned as
  `in_progress`; active backoff → `backoff`; otherwise insert.
* **Heartbeat:** refreshed between days **and every 30 s while a provider
  call is in flight** (`withHeartbeat`). A run is considered stale only if
  its heartbeat is older than **5 min** — which happens only when the
  process died. So a slow live call is never taken over.
* `POST /generate-session` returns **409 `AI_WEEK_GENERATION_IN_PROGRESS`**
  only for a date that a live run still has queued (explicit mode only).

### 1.6 Failure handling
| Failure | Effect |
|---|---|
| Provider auth (401/403, incl. Velona "API key budget exceeded") | Run stops; remaining days `not_attempted`; **30 min** backoff |
| Provider transient (5xx, timeout, 429, invalid response) | Run stops; backoff **2 → 10 → 30 → 60 min** by consecutive failed runs |
| Quality (schema/domain/adequacy/truncation) | That day `failed_quality`; recorded in `ai_week_generation_day_failures` by (date, contextHash); rerun on the same context = `gated` (no call) unless `confirmRetry: true` |
| SessionPlan refusal | Day `refused`; never paid |
| Day became ineligible mid-run | Day `skipped` |

Partial success is kept: successful days stay pending; a later run only
attempts the remaining, ungated days. During a backoff `POST` returns 503
with `retryAfter`, while `GET /week` and `/today` stay 200.

### 1.7 Projection detail (one deliberate deviation)
Projection uses **every earlier day of that week that has a live proposal**
(pending/approved, or committed but not yet trained), read from the DB —
not only days from the same run. Reason: a re-attempted day is then planned
against the same context (and same contextHash) as its first attempt, which
keeps the quality gate meaningful. Planned sets are counted with the
engine's own `calculateExerciseExposure` (as if completed). Real history is
never modified. The input is optional: with no projections the context is
**byte-identical** to before, so `generate-session` is unchanged.

### 1.8 Files
| File | Change |
|---|---|
| `src/ai-programmer/service/weekGeneration.ts` | **New.** Window rules, eligibility, guard use, day loop, failure classes, `readWeekGenerationState` (pure read), `activeRunClaimingDate` |
| `src/repositories/weekGenerationRunRepo.ts` | **New.** Synchronous run/guard/heartbeat/finish + day quality-gate storage |
| `src/ai-programmer/context/projectedExposure.ts` | **New.** `applyProjectedSessions` (pure) |
| `src/ai-programmer/context/programmerContextBuilder.ts` | Optional `projectedSessions` input |
| `src/ai-programmer/service/aiProgrammerService.ts` | `generatePlannedDayProposal(context, plan, {weekRunId, expiresAt})` |
| `src/repositories/aiProposalRepo.ts` | Optional `expiresAt` / `weekRunId` on create (defaults unchanged) |
| `src/ai-programmer/provider/config.ts` | `aiWeekGenerationMode()` |
| `src/ai-programmer/errors.ts` | 5 new typed errors (`AI_WEEK_GENERATION_*`) |
| `src/server/routes/aiProgrammer.ts` | `POST /generate-week`; the 409 guard in `generate-session` |
| `src/server/routes/programming.ts` | Explicit read path + `generation` field (legacy untouched) |
| `src/db/schema.sql`, `src/db/client.ts` | 2 new tables + nullable `ai_program_proposals.week_run_id` (all additive) |
| `tests/ai-programmer/weekGeneration.test.ts` | **New**, 33 tests |

### 1.9 The `generation` object (contract the UI relies on)
```ts
{
  mode: 'explicit',
  status: 'generating' | 'saved' | 'generated' | 'partially_generated' | 'failed' | 'not_generated',
  canGenerate: boolean,
  reason?: 'outside_window' | 'in_progress' | 'provider_unavailable' | 'nothing_to_generate' | 'disabled',
  retryAfter?: string,          // ISO, during provider backoff
  runId?: string,               // while generating
  perDay: [{ date, weekday, purpose, status, proposalId?, code? }]
  // per-day status: past | locked | committed | proposal_pending | approved | generating
  //                 | refused | failed_quality | gated | failed_provider | not_generated
}
```

---

## 2. Commit `5332ef1` — program page UI

* `public/app.js` — `weekGenerationView(generation)`: a **pure** mapping
  from the backend `generation` object to text and badge tones (it decides
  nothing; `canStart = canGenerate && status !== 'generating'`). Plus five
  user-facing messages for the `AI_WEEK_GENERATION_*` error codes in
  `AI_ERROR_MESSAGES`.
* `public/program.html` —
  * `buildGenerateWeekControl()` gained one line: if the week response has
    `generation` (explicit mode), render `buildWeekGenerationControl`;
    otherwise the **legacy control is unchanged**.
  * `buildWeekGenerationControl`: headline, backend reason (with backoff
    retry time), the **"Generate this week's AI sessions"** button, and one
    row per gym day (`Mon, Oct 5 · Push` + status badge).
  * While the backend says `generating`, the page re-reads `GET /week`
    every **4 s** (one timer at a time) and re-renders; it stops as soon as
    the status changes. The button is disabled unless the backend allows a
    start, and an in-flight guard blocks double clicks.
  * Proposals are still reviewed/approved/committed in each day's existing
    panel — the control never shows a second copy of the workouts.
* `tests/frontend/weekGenerationUI.test.ts` — 16 tests, including a
  **contract test** that parses `weekGeneration.ts` and fails if the backend
  adds a status or reason the UI has no label for.

Verified in Chrome locally against a production DB copy with the AI stubbed
(not_generated, generating, partially_generated, generated, failed/backoff,
duplicate-click prevention, day panels, swap control), then read-only on
production.

---

## 3. Commit `ea57848` — decision log (documentation only)

* `docs/AI_GENERATION_REDESIGN_DECISION_LOG.md` — the full record of the
  AI generation redesign (2026-09-28 → 10-02): the original Pull failures,
  SessionPlan / plan conformance / planned context, locked decisions, the
  stopped first rollout, production incidents (Velona key budget, scraper
  crash, public access), explicit week generation D1–D7, open items,
  operations.
* `docs/open-decisions.md` — pointer to that log.

**Convention going forward:** every major change or decision gets a section
appended to the decision log in the same commit.

---

## 4. Running it locally

```bash
npm install
npm run dev                 # http://localhost:3000 (tsx watch)
npm test                    # vitest
npm run typecheck
npm run build
```

To exercise explicit week generation locally:
```bash
AI_PROGRAMMER_ENABLED=true AI_PLANNED_GENERATION_ENABLED=true \
AI_WEEK_GENERATION_MODE=explicit VELONA_API_KEY=... VELONA_MODEL=qwen/qwen3-next-80b-a3b-instruct \
npm run dev
```
Then open `/program.html`. **Without a real key**, use the test approach:
stub `fetch` for `https://velona.in/` (see
`tests/ai-programmer/weekGeneration.test.ts`, "concurrent POSTs through the
real route") — never test against the real provider unless you mean to pay.

Focused tests for this area:
```bash
npx vitest run tests/ai-programmer/weekGeneration.test.ts tests/frontend/weekGenerationUI.test.ts
```
Expected full-suite state: ~245 failures that are all **pre-existing
date-rotation tests** (hard-coded calendar dates now in the past); compare
failures by name, not by count. 0 new failures as of these commits.

---

## 5. Production state

* Oracle VM `68.233.97.63` (SSH user `ubuntu`), checkout
  `/home/ubuntu/workout-logger`, systemd service `workout-logger`, nginx
  on :80 → :3000. DB `data/workout-logger.sqlite`.
* Deployed build: **`5332ef1`** (`ea57848` is docs only, no deploy needed).
* Flags (systemd drop-ins in `/etc/systemd/system/workout-logger.service.d/`):
  * `planned-generation.conf` → `AI_PLANNED_GENERATION_ENABLED=true`
  * `week-generation.conf` → `AI_WEEK_GENERATION_MODE=explicit`
* **Rollback** (either flag): delete the drop-in file,
  `sudo systemctl daemon-reload && sudo systemctl restart workout-logger`.
  Confirm with `/proc/<MainPID>/environ`. All schema changes are additive,
  so no data migration in either direction.
* Deploy procedure: back up the DB to
  `deployment-backups/pre-<commit>-<timestamp>.sqlite`, then
  `git fetch && git checkout -B main origin/main && npm ci && npm run build &&
  sudo systemctl restart workout-logger`, then check `/api/health`.
* Read-only observation tool (outside the repo):
  `/home/ubuntu/ai-observe/observe.sh [isoWatermark]`.

---

## 6. Open items — good places to start

1. **No week picker in the UI.** Next week is allowed from Saturday, but the
   page only shows the current week, so it can't be generated from the UI yet.
2. **Gated-only weeks:** when only quality-gated days remain, the backend
   still reports `canGenerate: true` (the button stays enabled; clicking is
   harmless — no paid call). Excluding gated days from the eligible count
   would fix it.
3. **Blueprint is two versions behind.** The app vendors `b018abc`; the
   Blueprint repo is at `930d1be` (8 new bodyweight/dumbbell exercises,
   new `equipment_setups` field). Before syncing, update
   `isExerciseEquipmentFeasible` (`src/engine/constraintEngine.ts`) to honour
   `equipment_setups` (any one setup available; `bodyweight` always
   available) — otherwise `close-grip-bench-press` drops out of
   `/api/programming/substitutes`. Sync only when no proposal is pending
   (pending proposals become "stale" after a Blueprint commit change).
4. **Velona error logging:** the provider client maps 401 and 403 to one
   generic error and discards Velona's body, so logs can't show causes such
   as "API key budget exceeded". Log status, `error.code` and `request_id`
   (never the key).
5. **No authentication:** the app is public over plain HTTP; scrapers can
   read personal data. Needs a decision.
6. `generate_session`'s retry gate is in-process memory (lost on restart);
   the week gates are durable.
7. Known AI behaviours accepted at rollout: Upper over-allocates the
   triceps shared group (conformance trims it legally); rationale text can
   mention an exercise that conformance later removed; completion can add a
   1-set exercise.

## 7. Working rules used so far
* No real provider calls for testing in production; use stubs or an isolated
  scratch checkout with a DB copy.
* Never approve, modify or delete the user's proposals.
* Commit and deploy only with explicit approval; append to the decision log.
