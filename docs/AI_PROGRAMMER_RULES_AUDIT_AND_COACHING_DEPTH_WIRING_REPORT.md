# AI Programmer: Rules Audit, Coaching-Depth Signal Wiring, and Model Evaluation — Full Session Report

2026-09-18. This is the durable record of a long, single working session that
started as a production bug hunt and ended up rewriting the AI Programmer's
entire rule set and wiring six previously-invisible coaching signals into its
context. It is written to be read cold, months later, by someone who was not
in the conversation. Where a decision was contested or reversed, the
reasoning is kept, not just the outcome — several of the calls here look
obvious in hindsight but were not obvious at the time.

Related: `docs/COACHING_DEPTH_PROGRAMMING_ROADMAP.md` (the roadmap this
session closes a gap in), `docs/LEGS_SESSION_EXERCISE_CAP_FIX_REPORT.md`
(the original, narrower leg-cap fix this session's leg+abs work supersedes),
`docs/logs/2026-09-16-60-legs-session-exercise-cap.md` (log entry
immediately prior to this one).

## 1. How this session started

Three earlier, narrower threads led here:

1. A parallel session's "Coaching Depth" work (periodization, muscle
   profiles, historical trends, reactive deloads, intensity techniques,
   exercise rotation/pairing, structural-balance advisories, individual
   profile factors) was verified and deployed to production.
2. A specific date's AI proposal generation kept failing/timing out. Root
   cause: the model's completion was being truncated before valid JSON
   closed, not a logic bug — `GENERATE_SESSION_MIN_MAX_TOKENS` was raised
   (4096 → 8192 → 16384 after live testing) and a `AIProviderOutputTruncatedError`
   path (`isLikelyTruncatedOutput` in `velonaProvider.ts`) was added so this
   fails loudly and specifically instead of surfacing as a generic schema
   error.
3. That investigation turned into "why do these models struggle with this
   task at all" — real per-request prompt/completion token counts were
   pulled (not estimated), and a model evaluation harness
   (`scripts/modelEval.mjs`) was built to compare candidates on real
   production context.

That evaluation surfaced the actual finding that reframed the rest of the
session: the Coaching Depth roadmap's 9 phases were essentially all built at
the deterministic-engine level, but only 3 of them ever reached the AI's own
context object, and only one of those three (deload) had an actual rule in
the system instruction anchoring it. The other signals existed in the
database and the deterministic engine but were invisible to the model that
was supposed to be exercising judgment about them. Sharper rules alone could
not fix a model reasoning over data it never received.

## 2. Model evaluation: findings, not just numbers

Models tested against real production context via `scripts/modelEval.mjs`
(calls `VelonaProvider.generate()` directly with real `buildProgrammerContext`
output, bypassing persistence — nothing written is ever committed):
OpenAI GPT-5.6 Luna Pro, Mistral Small 4, others earlier in the session.

Key findings, with corrections made along the way:

- **Truncation was an infrastructure problem, not a capability problem** —
  fixed by raising max_tokens, not by simplifying the task.
- **GPT-5.6 Luna Pro's ~4x token inflation** (110k tokens from a ~30k-token
  prompt) was initially attributed to a moderation wrapper. That explanation
  was checked and found wrong — OpenAI's moderation endpoint is free and
  separate, and doesn't inflate billed tokens. The better-supported
  explanation, found via research, is structured-output/schema-mode token
  overhead specific to OpenAI-compatible models. Recorded here specifically
  because the first explanation was stated with confidence and then
  retracted — a reminder to keep skepticism about self-generated
  explanations for model behavior that wasn't directly observed.
- **Budget is real but was initially overestimated as a hard blocker.**
  Velona wallet funds were limited enough mid-session that an in-progress
  eval run was stopped immediately on the user's word ("I don't think I have
  money for 5 reps each in my velona wallet") rather than continued on the
  assumption it would probably be fine.
- **Currency clarity ruled out OpenRouter** as an aggregator, independent of
  price: it bills in USD, and the user is in India and did not want
  after-the-fact currency-conversion uncertainty on what was actually spent.
  An INR-billing aggregator is a hard requirement, not a preference.
- Frontier models (Opus, Fable, Sonnet, Astra, Terra, Sol, etc.) were
  explicitly excluded from consideration on cost grounds throughout.

**Not yet decided, deliberately deferred** (see §6): whether a dedicated
reasoning-tuned model, or a two-step reason-then-commit pipeline, is the
right way to get genuinely reliable judgment out of a non-frontier model for
the four items in §4 that this session decided must stay AI judgment calls.
The user's explicit instruction was to finish the rules/wiring "plumbing"
first, since whichever model/pipeline is chosen will be reasoning over this
same rule set and context — deciding the setup before the substance it
operates on was judged premature.

## 3. The rules audit: from 26 rules to 23, and a philosophy shift

### 3.1 The core complaint

The system instruction (`buildProgrammerSystemInstruction()` in
`src/ai-programmer/service/aiProgrammerService.ts`) had grown to 26 rules,
several defensively over-specified — written to preempt hypothetical model
mistakes rather than to state what's actually true. The user's own framing,
via analogy: rules like "nothing from the blueprint is invalid, don't omit
anything because equipment is not available" are like handing someone a book
and saying "all pages are valid, don't skip pages because the color of the
page is black or torn" — when the simpler, truer instruction is "this book is
your reference, stick to it." Negations that pre-empt a mistake the model was
never going to make just add noise and erode how much of the instruction a
model (or a human) actually reads carefully.

This produced a standing principle applied for the rest of the audit:
**positive framing over defensive negation** — state what's true and let
absence of permission do the excluding, rather than enumerating every wrong
answer and disclaiming it. A second, sharper refinement emerged from
pushback partway through: don't answer a question the model was never going
to ask, and don't plant doubt by pre-emptively reassuring against it.
Restating "this doesn't mean X" for an X nobody would infer just teaches the
model that X was ever plausible.

### 3.2 Rule-by-rule resolution (old numbering → new)

Several old rules were purely redundant restatements of "there's a list,
don't deviate from it" (old rules 6, 7, 9, 10, 11) — collapsed into what is
now **rule 5**, which states the list is closed and complete, then explains
*why* no escape hatch is needed (equipment/time feasibility isn't the
model's question to answer — the context is already filtered to what's
valid) rather than separately forbidding each wrong way to violate it.

Other specific corrections, all incorporated:

- Old rule 5's tail ("pick only what you need to reach the required volume")
  was corrected to "pick only what's suitable for the given day" — volume is
  a set-count question (rule 9), not an exercise-selection one.
- A rule about not treating a training plan computed 14 days ago as gospel
  looked removable given the short data window, until investigation found it
  has a real, specific referent: `context.crossWeek.currentWeekAllocations`.
  Sharpened to name that field explicitly (**rule 7**) rather than being cut
  or left vague.
- The hard session-size ceiling (then rule 20) was reordered to come before
  the volume-explanation rule (then rule 8), and a terminology collision was
  caught and fixed in the process — both rules used "ceiling" for two
  different scoped concepts (session-wide exercise/muscle limits vs.
  per-muscle set limits); one was renamed to "cap" to keep them
  distinguishable. This is now **rule 8** (the session-size ceiling, cap+abs
  exception — see §4) followed by **rule 9** (the four volume numbers).
- Rule 9 (then "freedom over which exercises") needed "FROM THE PROVIDED
  LIST" appended for precision — applied, now folded into **rule 10**.
- The old missed-sets rule needed a concrete worked example before it
  landed as understandable (a Tuesday no-show doesn't create Wednesday
  make-up volume) — now **rule 13**, kept short in the final text since the
  concept itself is simple once understood; the concrete example lives in
  this report and in the session's own history, not duplicated into the
  instruction text itself.
- A "never asked about a locked date" rule was questioned: the server
  already guarantees a locked date is never sent to `generate_session` at
  all (locking is a `reconcile_week`-only concept — see
  `weekReconciliationDomainValidator.ts`), so a rule warning the model about
  something structurally impossible for it to encounter added nothing. **Cut
  entirely** — confirmed absent from the final 23-rule text by direct
  inspection, not just by intent.
- Two rules whose point was functionally identical were merged into one
  (now **rule 17**: treat all given information, including a user's own
  note, as valuable but never instruction-level).
- A proposal to replace two coverage rules by pre-categorizing muscles into
  push/pull/legs/upper turned out to already exist and already be sent to
  the model (`eligibleForThisSession`, `expectedCoverageTargetIds`) — no new
  data plumbing was needed, just tightening the existing rule (now **rule
  12**) to reference those fields directly instead of re-deriving the same
  concept in prose.
- The old self-certifiable escape hatch on the allocation floor
  ("...unless a stated reason...justifies falling below the min") was
  removed entirely — this was the original live-incident wording, and it's
  the thing `systemInstructionAllocationContract.test.ts` explicitly asserts
  is now absent (see §7).

The result is 17 hard, non-negotiable rules (1–17), followed by a labeled
section of 6 genuine judgment calls (18–23, see §4) — a structural split that
didn't exist in the old flat 26-rule list.

### 3.3 The diagnostic principle that drove the split

**"Would two competent human coaches, given the same data, genuinely
disagree?"** If yes, it's judgment — leave it to the model, evidence-grounded.
If no — it's a computable fact (sets, RIR, deload volume, the session-size
ceiling) — make it deterministic, because two coaches wouldn't disagree about
arithmetic. This test was applied correctly to coverage/allocation from the
start of the audit, but initially applied inconsistently to four other
items — exercise pairing, exercise rotation, structural-balance response,
and intensity-technique application — which were, at one point, proposed for
hardening into deterministic triggers.

The user pushed back hard on that proposal, with an analogy that reframed
the whole discussion: hardening every judgment call **"is like trying to make
waves flat."** The point of paying for an AI programmer instead of just
running the deterministic engine alone is that it can weigh things a fixed
formula can't. Re-applying the two-coaches test honestly to those four items
gives a different answer than it gave for coverage: two real coaches
absolutely would disagree about whether today's biceps/triceps pairing is
worth sequencing back-to-back, or whether this is the session to swap an
exercise for a fresh angle. Hardening these into triggers wouldn't reduce
the risk of a bad call, it would just relocate a bad call from "the model
guessed wrong" to "the trigger fired on data that didn't actually warrant
it" — while also removing the one advantage of using an AI at all here.

**Resolution:** these four stay genuine AI judgment, not deterministic
triggers — but they can't be judgment calls made in the dark. They needed to
actually reach the model's context in the first place (most of them never
did — see §5), and the rules governing them (18–23) all carry an explicit
evidence-citation requirement: name the specific data point behind the
decision in `programmingRationale`, never a generic impression.

## 4. The leg+abs session-size architecture

Explicit, exact rule given by the user, after the "waves flat" discussion
settled the philosophy question, worded precisely so it could go straight
into both prose and code:

> Never train more than 7 muscles or use more than 9 exercises in one
> session for every other day and 5 exercises max and 5 muscles max on leg
> day and this is excluding abs which are the only group pairable with legs.
> If paired with abs a leg day can have a max of 8 exercises restricting leg
> work to 5 only.

One subtlety resolved by investigation before implementing: abs
(`obliques`/`rectus-abdominis`) is not actually a legs-exclusive pairing in
the existing code — it's part of `UNIVERSAL_PHYSIQUE_TARGETS`, eligible on
every session purpose already. The user's own correction on this point:
*"you got it right about abs being universal, just flexing the cap on leg day
with abs"* — i.e. the rule is a leg-day exercise-count exception for when abs
happens to show up there, not a new pairing relationship.

**Implementation** — one shared source of truth, `sessionRealismCapFor()` in
`src/engine/config.ts`, consumed by all four places that previously computed
this ceiling independently (the exact drift risk this session was designed
to avoid — "prompt says X but validator enforces Y" was a real bug class
earlier in this project's history):

```ts
export const LEGS_SESSION_MAX_TARGETS = 5;
export const LEGS_SESSION_MAX_EXERCISES = 5;
export const LEGS_WITH_ABS_SESSION_MAX_EXERCISES = 8;
export const ABS_PHYSIQUE_TARGETS: readonly string[] = ['obliques', 'rectus-abdominis'];

export function sessionRealismCapFor(
  sessionPurpose: SessionPurpose | null,
  targetIdsInSession: readonly string[]
): { maxTargets: number; maxExercises: number; legExerciseShareMax: number | null } {
  if (sessionPurpose !== 'legs') {
    return { maxTargets: 7, maxExercises: 9, legExerciseShareMax: null };
  }
  const hasAbs = targetIdsInSession.some((id) => ABS_PHYSIQUE_TARGETS.includes(id));
  return {
    maxTargets: LEGS_SESSION_MAX_TARGETS,
    maxExercises: hasAbs ? LEGS_WITH_ABS_SESSION_MAX_EXERCISES : LEGS_SESSION_MAX_EXERCISES,
    legExerciseShareMax: LEGS_SESSION_MAX_EXERCISES,
  };
}
```

Consumers, all updated to call this instead of the old flat 7/9 constants or
the prior legs-only 5/9 cap:

- `src/engine/workoutBuilder.ts` — `applySessionRealismCap()` now tracks a
  running `legExerciseCountKept` counter during allocation, capping leg
  exercises specifically to `legExerciseShareMax` even when the session's
  total-exercise budget (8, with abs present) has more room; `sessionRealismSkipsFor()`
  uses the same caps for its skip-reason messaging.
- `src/ai-programmer/validation/programmerAdequacyValidator.ts` — added a
  leg-exercise-count check alongside the existing target/exercise-count
  checks, all now reading from `sessionRealismCapFor`.
- `src/ai-programmer/validation/weekReconciliationDomainValidator.ts` — same
  pattern, with explicit narrowing of `sessionPurpose` (`string | null` →
  the literal union) since the source field is untyped at that layer.
- `src/ai-programmer/service/aiProgrammerService.ts` — rule 8 (generate_session)
  states the same cap/exception in prose, generated from the same constants
  (not a hand-copied number) so the instruction text and the enforcement
  code can never independently drift.

Tests: 2 new cases in `tests/engine/sessionRealismCap.test.ts` (9/9 passing)
isolating the muscle-cap dimension specifically (the pre-existing test
happened to always be bound by the exercise cap, not the muscle cap — a real
coverage gap, not a bug, discovered and closed here), 2 new cases in
`tests/ai-programmer/programmerAdequacyValidator.test.ts` (13/13 passing)
covering both the over-cap rejection and the legitimate 5-leg+abs-to-8 case.

## 5. Six coaching-depth signals wired into AI context

Before this session, the AI context object
(`src/ai-programmer/context/programmerContextTypes.ts`) carried almost none
of the Coaching Depth roadmap's real signal, despite the deterministic
engine having computed most of it for months. All six additions below reuse
real, already-tested deterministic functions — nothing here is new judgment
logic, only new visibility:

1. **Rep-range bias baking.** `programmerContextBuilder.ts` now computes
   `effectiveRepRangeBias` per target (deload bias overrides the muscle's own
   curated bias when active, mirroring `workoutBuilder.ts`'s own precedence
   exactly) and applies it via `applyRepRangeBias()` to authored prescription
   reps before they reach the model.
2. **Training experience.** `context.trainingExperience` — read via
   `ProfileFactorsRepo.effectiveValue(user.id, 'training_experience', ...)`,
   narrowed to the literal `'novice' | 'intermediate' | 'advanced' | null`
   union. Backs rule 18.
3. **Structural-balance advisories.** `context.structuralAdvisories` — real
   output of `evaluateStructuralAdvisories()`, fed the same
   `StructuralAdvisoryTargetInput` shape the deterministic engine already
   builds per target. Backs rule 22.
4. **Antagonist pairing.** Each entry in `programmingBrief.muscles` now
   carries `antagonistGroup: 'push' | 'pull' | null`, computed from
   `PUSH_PHYSIQUE_TARGETS`/`PULL_PHYSIQUE_TARGETS`. Backs rule 20.
5. **Intensity-technique suitability.** Each `validExercises` entry now
   carries `plausibleIntensityTechniques` — the real, Blueprint-authored
   suitability filter (`isExerciseSuitable()`, promoted from private to
   exported in `src/engine/intensityTechniques.ts` specifically for this
   reuse) applied per exercise. Backs rule 19.
6. **Exercise-rotation signal.** Each `validExercises` entry now carries
   `recentConsecutiveSessionsUsed`, computed by walking a flattened,
   most-recent-first cross-exercise history and counting a leading
   consecutive run on that exact exercise id. Backs rule 21.

Removed in the same pass: `profile.availableEquipment` and the entire
`executionContext` block — dead data the rules audit found no rule actually
depended on once the "time/equipment feasibility isn't the model's question"
resolution (§3.2) landed; the context that was validating it (rule 11, old
numbering) was deleted, so the data backing it was deleted too rather than
left orphaned.

## 6. Deferred: the "genuine reasoning setup" decision

Explicitly not decided this session, by the user's own instruction — the
plumbing (rules + wiring) had to land and be verified first, since whichever
setup is chosen reasons over this exact rule set and context:

- **Option A** — a dedicated reasoning-tuned model for the four genuine
  judgment items (§3.3), used as-is.
- **Option B** — a two-step pipeline: a reasoning pass that produces a
  citation-backed judgment call, then a separate commit pass that turns it
  into the final structured output.

Open question flagged during discussion, not yet answered: whether a strong
enough version of either setup would make the *current* (non-frontier)
candidate model list viable after all, rather than requiring a different
model entirely. This is the next decision once this report and its
commit land, and it should be tested rigorously against real context the
same way the earlier model evaluation was (§2), not decided from
priors alone.

## 7. Verification

- `npm run typecheck` (`npx tsc --noEmit`): clean, zero errors, after all
  source and context changes.
- `tests/ai-programmer/systemInstructionAllocationContract.test.ts`: fully
  rewritten (the old version pinned exact old-26-rule phrasing that no
  longer exists after the audit) to assert the same underlying guarantees —
  the four volume numbers are distinguished by name, `recommendedSessionSets`
  is stated as a range not a suggestion, selection flexibility is separated
  from allocation non-flexibility, the ordered allocation procedure and its
  narrow budget exception are present, the old self-certifiable escape hatch
  is confirmed absent, exercise-list closure language is preserved, and
  deload volume is stated as already-final. 8/8 new assertions pass against
  the real current rule text.
- `tests/ai-programmer/tokenReport.test.ts`: checked and confirmed to only
  assert byte/char-length relationships between the real system instruction
  and reconstructed wire bodies — never pins specific rule wording, so it
  needed no changes for this audit.
- Full suite (`npx vitest run`): 1729 tests, 1498 passed, 231 failed —
  diffed test-by-test (not just by count) against the established
  `/tmp/failures_deloadfix.txt` baseline. **Zero difference.** Every one of
  the 231 failures is the same pre-existing date-drift noise (fixture dates
  hardcoded relative to a fixed calendar date, now in the past relative to
  the real current date) that predates this session entirely — none of it
  is caused by the rules rewrite, the leg+abs cap, or the coaching-depth
  wiring.

## 8. Not yet done / future steps

- **The two reasoning-setup options (§6)** — deliberately deferred, next
  decision after this report and its commit land.
- **Tempo/ROM/unilateral signals** — part of the Coaching Depth roadmap's
  broader ambition, not built at the deterministic-engine level yet, so
  there's nothing to wire into AI context yet either.
- **Sleep/soreness/readiness signals** — same status: not yet collected by
  the app at all, so this is a data-collection gap before it can become a
  context-wiring gap.
- **Dislike-list population** — the user-preference exclusion mechanism
  exists structurally but isn't populated with real data yet.
- **Aggregator evaluation beyond this session's two models** — Yantra AI and
  other INR-billing aggregators were named as worth testing but not yet
  evaluated with the same real-context harness used for GPT-5.6 Luna Pro and
  Mistral Small 4.
- **`scripts/modelEval.mjs`** — committed to the repo this session (see log
  entry) as a reusable harness for the above, rather than being thrown away
  as a one-off script.
- **Production deployment** — this session's changes are committed to `main`
  per explicit instruction; deploying them to the production VM was not
  requested and has not been done. Confirm with the user before deploying,
  consistent with this project's established practice of not deploying
  large, multi-file changes unilaterally.
