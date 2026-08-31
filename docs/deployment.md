# Local dev and deployment

## Local development

```bash
npm install
npm run sync-blueprint     # generates src/blueprint/snapshot/*.json (already committed; re-run after Blueprint data changes)
npm run dev                 # tsx watch — API + static UI on http://localhost:3000
npm test                    # vitest
npm run typecheck
```

No `.env` file is required to run locally — see the variable table below,
all of it is optional with sane defaults. If you do want to override
anything, create `.env.local` (gitignored) and export the variables before
running `npm run dev`, or set them inline:

```bash
DB_PATH=./data/dev.sqlite PORT=4000 npm run dev
```

## Environment variables / secrets

| Variable | Where it's used | Local | Production |
|---|---|---|---|
| `DB_PATH` | `src/db/client.ts` | optional, defaults to `./data/workout-logger.sqlite` | **must** point at a persistent volume/disk (see below) |
| `PORT` | `src/server/index.ts` | optional, defaults to `3000` | set by most hosts automatically (e.g. Render sets `PORT`) |
| `BLUEPRINT_REPO_PATH` | `scripts/sync-blueprint.mts` only | optional — point at a local `workout-blueprint` checkout to skip cloning | not used at runtime; only needed by whoever re-runs the sync script |

There are **no API keys or third-party secrets** in Phase 1 — no LLM/AI
calls, no external service integrations at request time. The old Python
CLI tool this repo replaced used a `GEMINI_API_KEY`; that dependency is
gone.

## Production deployment

This is a plain Node process (`npm run build && npm start`) serving both
the REST API and the static UI.

```bash
npm run build   # tsc -> dist/
npm start        # node dist/server/index.js
```

**The decided production target is an Oracle Cloud Infrastructure
Always Free VM** — chosen specifically because it gives this app a
filesystem that survives process restarts and redeploys, which SQLite
requires. See **`docs/PRODUCTION_DEPLOYMENT.md`** for the complete,
ordered deployment runbook (VM setup, systemd service, Nginx + HTTPS,
database persistence, backups) and the `ops/` directory for the
committed systemd units, Nginx config template, and backup script it
references.

### The SQLite caveat

The previous app in this repo was once deployed to Render's free tier,
whose filesystem is **ephemeral and resets on every redeploy/restart** —
that's exactly why Render (and similarly Cloud Run) is **not** an
acceptable target for this repository's current SQLite-based
architecture, and why the Oracle VM approach above was chosen instead:
if `DB_PATH`'s SQLite file isn't on a filesystem that survives
restarts/redeploys, all data is lost. `docs/PRODUCTION_DEPLOYMENT.md`'s
persistence test (deploy → write data → restart the service → reboot
the VM → confirm the data survives) exists specifically to verify this.

Do **not** switch this to Postgres or another server-backed DB without
deciding to — that's an explicit open decision (see
`docs/open-decisions.md`); SQLite-on-persistent-VM-storage is the
current, decided default, not a placeholder pending a "real" answer.

### Regenerating the Blueprint snapshot in CI/production

`src/blueprint/snapshot/*.json` is committed to this repo, so a normal
`npm run build` never needs network access to workout-blueprint. Re-run
`npm run sync-blueprint` manually (locally, with `BLUEPRINT_REPO_PATH` set
to a checkout, or lettting it clone) whenever Blueprint's data changes, and
commit the result — see `docs/architecture.md` for why this is vendored
rather than fetched live.
