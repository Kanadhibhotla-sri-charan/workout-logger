# Coaching Depth UI Data Contract (Workstream B, Phase B1)

Status: draft data-contract inventory, produced per
`docs/COACHING_DEPTH_NEXT_STEPS_IMPLEMENTATION_SPEC.md` §7 ("Backend/API
integration requirements") ahead of building any UI surface. No frontend
code has been written yet — this document is the required "identify the
existing API/planner output supplying the data" step, and its per-field
table is what each later phase (B2-B5) implements against.

Guiding rule (spec §2.2/§7): every field below is **read from, or written
to, an already-shipped backend endpoint**. Nothing here proposes a new
programming decision, a new scoring mechanism, or a client-side
recomputation of anything the backend already decides. Two small
presentation-only gaps are called out explicitly in §5 below — everything
else is a pure display/edit layer over existing responses.

---

## 1. Weekly Plan / Program Overview surface

Backed by `GET /api/programming/week?date=YYYY-MM-DD` (existing,
`src/server/routes/programming.ts:557`) and
`GET /api/programming/periodization?date=YYYY-MM-DD` (existing, line 945).

| UI field | Backend source | Read/write | Required fallback |
|---|---|---|---|
| Current block number / week-in-block | `periodization.blockNumber` / `periodization.currentWeek` / `periodization.blockLengthWeeks` | Read | Omit the block/week line entirely; show only the plain-language state banner below |
| Training state banner (normal / planned deload / reactive deload / manual deload) | `periodization.deloadReason` (`'calendar' \| 'reactive' \| 'combined' \| 'manual' \| null`) mapped to one of 4 fixed display labels | Read | "You are currently in a normal training state." (spec §6's required empty-state string) |
| Plain-language state explanation | `periodization.explanation` (already a complete, pre-written sentence — **use verbatim, do not re-derive**) | Read | Same fallback string as above if `periodization` fetch fails or 404s |
| Deload end / review date | `periodization.deloadEndDate` | Read | Omit the "through &lt;date&gt;" clause; keep the rest of the sentence |
| Reactive-trigger status (for an optional advanced view only) | `periodization.reactiveTriggerStatus` | Read | Not shown in the default view |
| Active goals + priority | `week.goals` (existing `/week` field, already ordered by real user-set priority — confirm exact key against live response before wiring) | Read | "No active goals" |
| "Why this week looks like this" (per-day) | `week.days[].plannedWork[].friendly_reasoning`, `week.days[].skipped[].friendly_reason` (both already human-authored strings from `friendlyExplanation.ts` — **use verbatim**) | Read | Generic sentence: "This day's plan reflects your current program." |
| Weekly goal-progress summary | `week.targetAllocations` (already consumed by `program.html`'s existing `renderGoalSummary()` — reuse, don't rebuild) | Read | Existing empty state already implemented in `renderGoalSummary` |

**Fallback discipline (spec §8):** if `/periodization` fails or returns a
shape this UI doesn't recognize, the weekly plan itself must still render
fully from `/week` alone — the state banner degrades to the normal-state
sentence, never a blocking error for the whole page.

---

## 2. Exercise Details Drawer/Modal surface

Backed entirely by fields already present on each `plannedWork[]` entry in
`GET /api/programming/week` (via `enrichPlannedWork`,
`src/server/routes/programming.ts:215`) — no new endpoint needed.

| UI field | Backend source | Read/write | Required fallback |
|---|---|---|---|
| Exercise name / target name | `exercise_name`, `target_name` | Read | Raw `exercise_id`/`target_id` (already the existing fallback pattern via `resolveExerciseName`/`resolveTargetName`) |
| Session role (primary/secondary/etc.) | `role`, `classification` | Read | Omit the role line |
| Why included (plain-language) | `friendly_reasoning` | Read | "This exercise was selected as part of your weekly program." |
| Goal this exercise supports | `goal_label`, `goal_id`, `goalNameRef`-derived name | Read | "Supports your overall program" (no specific goal named) |
| Pairing (superset/pre-exhaust partner) | `paired_with_exercise_id`, `paired_with_exercise_name` | Read | No pairing badge shown (field is `null` for an unpaired exercise today — this is the existing, common case, not an error) |
| Intensity technique applied | `applied_intensity_technique` (`{technique_id, name, instruction, extra_fatigue_note, applied_to_working_set_number}` or `null`) | Read | "No intensity technique is prescribed for this exercise." |
| Whether an alternative was considered due to preference/avoidance | Derive a **boolean only** from `decision.selection.rejected_candidates.length > 0` and `decision.selection.substituted_from !== null` — never surface `decisive_gate` or the raw candidate id list by default (spec §4B: "never expose internal scoring/penalties by default") | Read | Omit the note entirely (most exercises have no rejected candidates) |
| Prescription (sets/reps/RIR) | `sets`, `reps_min`, `reps_max`, `rir_min`, `rir_max` | Read | N/A — always present |

**Advanced/debug-only fields (never shown by default, spec §2.3/§4B):**
`decision.selection.decisive_gate`, `decision.selection.rejected_candidates`
(raw ids), `decision.weekly_exposure.*`, `decision.recovery`,
`decision.volume_decision`. If a future advanced/debug view is ever built,
it must be explicitly opt-in and separately labeled — out of scope here.

---

## 3. Coaching Settings surface (new page/section)

Backed by the existing preference and profile-factor CRUD endpoints — no
new backend work required.

| UI field | Backend source | Read/write | Required fallback |
|---|---|---|---|
| Preference list (preferred/disliked/avoided exercises) | `GET /api/programming/preferences` → `rules[]` (`exerciseId`, `exerciseName`, `preference`, `temporaryUntil`, `reason`, `updatedAt`) | Read | "You have not added exercise preferences yet." (spec §6's required empty-state string) |
| Add/update a preference | `PUT /api/programming/preferences/:exerciseId` — body `{ preference: 'preferred'\|'disliked'\|'avoided', temporaryUntil?, reason? }` | Write | Show the 400 body's `error` message verbatim on validation failure (e.g. unknown exercise id, invalid `preference` value) |
| Remove a preference | `DELETE /api/programming/preferences/:exerciseId` | Write | Standard error toast on failure; never optimistically remove the row before the 204 confirms |
| Exercise picker for adding a new preference | Reuse `createBlueprintExercisePicker` (`public/app.js`) against the existing Blueprint exercise catalog — no new endpoint | Read | N/A (existing component) |
| Training experience (profile factor) | `GET /api/programming/profile-factors` → `factors[]` filtered to `factorName === 'training_experience'` | Read | "Not set" |
| Update training experience | `PUT /api/programming/profile-factors/training_experience` — body `{ value: 'novice'\|'intermediate'\|'advanced', userConfirmed: true }` | Write | Same validation-error-surfacing rule as preferences above |
| Remove/clear training experience | `DELETE /api/programming/profile-factors/training_experience` | Write | Standard error toast on failure |
| Factor source / confirmation state | `factors[].source`, `factors[].userConfirmed` | Read | "User-entered" if `source` is null (the only way a factor reaches `SUPPORTED_PROFILE_FACTORS` today is this UI itself) |

**Distinguishing preference vs. avoidance (spec §4C):** the UI must label
`'preferred'` and `'disliked'` as "the program may favor/deprioritize this"
and `'avoided'` as "the program will not prescribe this unless you remove
the rule" — this wording difference is presentation only; the three values
are already mutually exclusive and backend-enforced (`ExercisePreferencesRepo.set`
replaces, never merges).

**No other profile factor exists to expose today.** `SUPPORTED_PROFILE_FACTORS`
(`programming.ts:1093`) currently lists only `training_experience`. Per
spec §11 ("no unsupported profile-factor effects... label
informational-only factors clearly or defer exposing them"), this surface
must show only `training_experience` until a future batch adds a second
supported factor — never a generic "add any factor name" free-text field.

---

## 4. Coaching Insights surface (new page/section)

| UI field | Backend source | Read/write | Required fallback |
|---|---|---|---|
| Structural balance advisories | `GET /api/programming/structural-advisories?date=YYYY-MM-DD` → `advisories[]` (`id`, `category`, `severity`, `evidence`, `affected_targets`, `explanation`, `suggested_review_action`, `affects_prescription` — always `false` today) | Read | "No structural advisories are active for this plan." (spec §6's required empty-state string) |
| Advisory affected area name | `affected_targets` (raw `BlueprintId[]`) resolved via `resolveTargetName`-equivalent lookup (reuse the same target-name resolution `/week` already performs — **do not duplicate the resolution logic**, add a tiny presentation mapping if `/structural-advisories` doesn't already resolve names — see gap noted in §5) | Read | Show the raw target id only if name resolution is unavailable |
| Advisory severity | `severity` | Read | Never color-only (spec §6 accessibility rule) — pair with a text label always |
| Intensity technique catalog (reference list, "what techniques exist and when") | `GET /api/programming/intensity-techniques` → `techniques[]` (Blueprint's raw `BlueprintIntensityTechnique[]`: `id`, `name`, `what`, `when_it_may_help`, `when_not_to_use`, `fatigue_time_implications`, suitability fields) | Read | "No intensity techniques are prescribed in this session." — this applies to the **prescribed-this-week** view (per-session, sourced from each day's `applied_intensity_technique`, not this catalog endpoint); the catalog itself is reference data and always has entries when Blueprint is loaded |
| Recovery/deload explanation (duplicate entry point into Insights) | Same `periodization` fields as surface 1 — reuse, do not re-fetch differently | Read | Same fallback as surface 1 |

---

## 5. Presentation-only gaps found (spec §7: "add a small presentation-oriented field ... rather than reproducing logic client-side")

Two small gaps were found. Both are name-resolution conveniences the
backend already performs elsewhere in this same file — adding them to
these two endpoints is copying an existing one-line lookup to a second
route, not inventing new logic:

1. **`GET /api/programming/structural-advisories`** returns
   `affected_targets` as raw `BlueprintId[]` with no resolved display name,
   unlike every other route in `programming.ts` (which all call
   `resolveTargetName`/`resolveExerciseName` before responding). Phase B5
   should add an `affected_target_names: string[]` field (parallel array,
   same order) using the exact same `resolveTargetName` helper already
   used at the top of this file — a few lines, not a new mechanism.
2. **`GET /api/programming/intensity-techniques`** returns Blueprint's raw
   catalog with no per-technique "currently prescribed this week" flag.
   This is NOT needed — the per-session "is this technique in use today"
   view is already fully covered by each `plannedWork[].applied_intensity_technique`
   field from `/week`, so Insights should build its "techniques prescribed
   this week" list by scanning the already-loaded `/week` response, not by
   asking `/intensity-techniques` to know about scheduling. No backend
   change needed here — noted only to rule out a tempting but wrong
   client-side duplication (deriving "is this used" from Blueprint's
   `suitable_*` fields directly, which would be re-deriving an eligibility
   decision the backend's `intensityTechniques.ts` already owns).

No other gaps were found. Every other surface's fields map directly onto
an existing response field with no transformation beyond formatting/labeling.

---

## 6. Empty/error/loading states required (spec §6, §8)

Every surface above must implement, per section:

- **Loading** — existing `showLoading()` helper (`public/app.js`).
- **Empty** — the exact strings quoted in the spec and reproduced in the
  tables above; use existing `showEmpty()` helper.
- **Failed request** — existing `showError()` helper; the Weekly Plan
  surface must degrade gracefully (§1's fallback discipline) rather than
  blocking the whole page when only `/periodization` fails.
- **Stale data after a save** — re-fetch the affected list from its GET
  endpoint after a successful `PUT`/`DELETE` rather than trusting an
  optimistic local mutation, consistent with `withSaving`'s existing
  pattern elsewhere in this codebase.
- **Unknown/legacy enum value** — any `preference`, `deloadReason`,
  `severity`, or `category` value not in this document's known set
  renders as a safe generic label (e.g. the raw string, humanized) rather
  than throwing or rendering blank.

---

## 7. Non-goals reaffirmed for this document

Per spec §11, this contract does not add, and no later Workstream B phase
may add: a new deload/periodization state, a new preference kind, a new
intensity-technique eligibility rule, a new profile factor, or any
client-side recomputation of `decisive_gate`, exposure, volume, or
recovery decisions. Every writable field above already has a real,
shipped backend endpoint enforcing its own validation — this document
adds no new persisted state.
