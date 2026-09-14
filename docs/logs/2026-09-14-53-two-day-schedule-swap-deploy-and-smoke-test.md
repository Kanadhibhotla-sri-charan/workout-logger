# 2026-09-14 — Two-Day Schedule Swap: Production Deploy + Smoke Test

Deploys `7943974` (see entry 52 for what it contains). No code change in this entry.

## Deployment

VM checked out `7943974` (from `1969a1d`), `npm ci`/typecheck/build clean, service restarted. `AI_PROGRAMMER_ENABLED` was deliberately left untouched (`true`, unchanged) — this deploy never edited the systemd unit at all. Database hash-verified byte-identical across all six affected tables immediately before and immediately after the deploy.

## Smoke test — why it ran against an isolated data copy, not live production

The spec's worked example assumes a starting arrangement of Push(Monday)/Pull(Tuesday)/Rest(Wednesday). Real production's Monday had already been changed to Rest during earlier UI exploration in this same project (see entry 50's live-test section), and the deterministic split-rotation had shifted Tuesday/Thursday/Friday to Push/Pull/Legs as a result. Running the literal two-swap sequence against live production would therefore have (a) not reproduced the example's literal wording (starting from a different arrangement), and (b) genuinely changed the real Tuesday/Wednesday schedule going forward — exactly the case the task instructions call out: *"If a real production-data test would alter the user's schedule, do not perform it directly."*

Used the explicitly-permitted alternative: fetched a complete, WAL-consistent copy of the production database (main `.sqlite` + `.sqlite-wal` + `.sqlite-shm` — the first such copy attempt earlier in this project had missed the WAL file and produced a stale snapshot; corrected here from the start), started an isolated local server against the copy only, and set the copy's Monday to match the spec's assumed starting state (an explicit, disposable edit made only on the local copy, never on production). Ran the real app code, real HTTP endpoint, against this copy.

## Smoke test results

1. **Real production page verified to be serving the control**: fetched `program.html` directly from production (read-only `GET`) and confirmed `buildSwapControl`, the "Swap two days" label, and the `/api/programming/week/swap` call are present in the actually-deployed bytes.
2. **Real production `/api/programming/week` verified to return the shape the pickers need**: a read-only `GET` against production returned all 7 real days with `weekday`/`date`/`type`/`sessionPurpose` — exactly what `buildSwapControl`'s day-option rendering consumes. No mutating request was sent to production.
3. **The exact required sequence, on the isolated copy**: starting state set to Push(Mon)/Pull(Tue)/Rest(Wed); `POST /week/swap {monday,wednesday}` → Monday Rest / Wednesday Push (Tuesday Pull unchanged, confirmed via the raw `program_sessions`/`week_activity_overrides` tables); `POST /week/swap {tuesday,wednesday}` → **Monday Rest, Tuesday Push, Wednesday Pull** — an exact match to the spec's required final arrangement.
4. **No AI or reconciliation call**: grepped the isolated server's full log for any Velona/AI-programmer/reconcile activity — none found, across both swaps.
5. **Workout history untouched**: `workout_sessions`/`workout_exercises`/`workout_sets` row counts on the copy were 11/34/94 both before and after — identical to production's real counts, confirming the swap never touched them.
6. **Error handling verified against the real backend** (isolated copy, still no mutation risk): a same-day request returned `400` with `"dayA and dayB must be different weekdays."`; an invalid weekday value returned `400` with a clear message — both are exactly what the page's `withSaving`/`showInlineStatus` helpers render inline.
7. **Live production database re-verified byte-identical** after all of the above — every read against production was a plain `GET`; nothing was ever mutated there.

## Known limitation

Could not perform an actual visual, in-browser click-through of the live control — the Claude-in-Chrome extension was not connected in this environment (same limitation noted in entry 52). Compensated with the read-only production checks (1)–(2) above plus the full isolated-copy walkthrough (3)–(6). A human visual smoke test of the real button/picker interaction on production is still recommended.
