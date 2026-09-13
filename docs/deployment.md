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
| `AI_PROGRAMMER_ENABLED` | `src/ai-programmer/provider/config.ts` | optional, defaults to disabled (any value other than the exact string `true`) | set explicitly to `true` to turn on the AI Programmer feature |
| `VELONA_API_KEY` | `src/ai-programmer/provider/config.ts` | **required** if `AI_PROGRAMMER_ENABLED=true` | **required**, real secret from your Velona account — never committed, never logged, never sent to the frontend |
| `VELONA_MODEL` | `src/ai-programmer/provider/config.ts` | **required** if `AI_PROGRAMMER_ENABLED=true`, no default | **required** — a real model id from Velona's own catalogue (`GET https://velona.in/gateway/v1/models`); see `docs/REAL_AI_INTEGRATION_REPORT.md` for the one currently recommended |
| `VELONA_BASE_URL` | `src/ai-programmer/provider/config.ts` | optional, defaults to `https://velona.in/gateway/v1` (the real gateway) | same default; override only for testing against a different gateway |
| `VELONA_TIMEOUT_MS` / `VELONA_MAX_RETRIES` / `VELONA_TEMPERATURE` / `VELONA_MAX_TOKENS` | `src/ai-programmer/provider/config.ts` | optional, sane defaults (60s / 1 / 0.2 / 4096) | same, tune per model/cost if needed |

**This is no longer accurate as of the real Velona AI integration**:
there IS now a real third-party secret and a real external API call at
request time (`AI_PROGRAMMER_ENABLED=true` + `POST /api/ai-programmer/generate-session`
→ Velona's `/inference/run`). See `docs/REAL_AI_INTEGRATION_REPORT.md`
for the full picture — provider, model, exact call path, and how the
secret is configured on the production VM. The feature is fully disabled
by default (`AI_PROGRAMMER_ENABLED` unset), so a deployment that never
sets these variables behaves exactly as this paragraph originally
described.

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
