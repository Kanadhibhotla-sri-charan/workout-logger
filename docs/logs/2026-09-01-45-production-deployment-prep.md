# 2026-09-01 — Production Deployment Prep (Oracle Always Free VM)

## What changed

Per `docs/PRODUCTION_DEPLOYMENT_SPEC.md` (the full spec text, saved
verbatim to the repo per this session's established practice), prepared
everything deployable from this sandbox for a production rollout to an
Oracle Cloud Always Free VM. Actual VM provisioning, DNS, and SSH-executed
steps are explicitly out of reach of this session (spec §46) and are
tracked as pending user-provided prerequisites.

**1. Health endpoint (spec §5).** `GET /api/health` now returns exactly
`{"status":"ok"}` with HTTP 200 (previously `{ ok: true }`). New
`tests/routes/health.test.ts` asserts the exact shape and that the
response never leaks database paths, env var names, or stack traces.

**2. Deployment-as-code artifacts (`ops/`).** Added the exact systemd
unit for the app (`ops/systemd/workout-logger.service`), the Nginx
reverse-proxy config template (`ops/nginx/workout-logger.conf`), the
daily SQLite backup script using SQLite's own online-backup mechanism
(`ops/scripts/backup-workout-logger.sh`, `.backup` + `PRAGMA
integrity_check` + 7-day retention pruning — never a raw copy of a live
WAL database), its systemd service/timer pair
(`ops/systemd/workout-logger-backup.{service,timer}`), and the production
environment file template (`ops/workout-logger.env.example`, explicitly
without `BLUEPRINT_REPO_PATH` or any API key — none exist).

**3. `docs/PRODUCTION_DEPLOYMENT.md`** — the complete ordered runbook
covering every numbered spec step: service account creation, Node 20
install, clone/`npm ci`/`npm run build`/`npm run verify` on the VM, the
data directory and environment file, the systemd service, local
pre-Nginx health checks, Nginx + Certbot/HTTPS, firewall rules, the
mandatory persistence test (service restart + VM reboot), the mandatory
backup + restore test, and the documented future-update procedure.

**4. `docs/deployment.md`** updated to point at the above as the decided
production path, explain why Render/Cloud Run were rejected (ephemeral
filesystem), and reword the SQLite-on-persistent-storage framing from "a
Phase 1 default" to the current decided architecture (hosting is no
longer an open decision per this spec).

## A real bug found and fixed during verification

While proving the build artifact actually boots (`npm run build && npm
start`, not just the test suite's in-process `createApp` calls — spec
§14 only asks for `ls dist/server/index.js`, but this session went one
step further given the systemd unit's `ExecStart=/usr/bin/npm start` is
exactly this path), two pre-existing, production-blocking bugs surfaced
that had never been exercised before because `dist/server/index.js` had
never actually been started this way:

1. **Wrong build output path.** `tsconfig.json` had `rootDir: "."` with
   `include: ["src", "scripts", "tests"]`, so `tsc` emitted to
   `dist/src/server/index.js` — not `dist/server/index.js`, which
   `package.json`'s `start` script (and the spec's own systemd unit) both
   require. Fixed by adding `tsconfig.build.json` (extends the base
   config, `rootDir: "src"`, `include: ["src"]` only — `tsconfig.json`
   itself is untouched and still covers `scripts`/`tests` for
   `npm run typecheck`) and pointing `npm run build` at it. This also
   incidentally fixed `src/server/app.ts`'s `PUBLIC_DIR` resolution,
   which had been resolving to a nonexistent `dist/public` before.
2. **Missing non-TypeScript asset.** `src/db/client.ts` reads
   `schema.sql` relative to its own compiled location, but `tsc` never
   copies non-`.ts` files — so the compiled server crashed on startup
   with `ENOENT: .../dist/db/schema.sql`. Fixed by appending `cp
   src/db/schema.sql dist/db/schema.sql` to the `build` script.

Both were latent since whenever this build layout was introduced — they
simply never fired because nothing had run the actual compiled
`dist/server/index.js` entry point end-to-end until this deployment prep
pass. Caught here rather than on the VM, where spec §18-19 would have
required an immediate STOP on `systemctl start workout-logger` failure.

## New tests

`tests/routes/health.test.ts` — 2 new tests (exact response shape;
no leaked sensitive information).

## Verification (real commands, real output)

Full suite, working tree:

```
$ npm run verify
 Test Files  47 passed (47)
      Tests  445 passed (445)
```

Genuinely clean checkout (`git stash create` + `git archive` + manual
copy of untracked new files, matching what a real `git clone` would
produce):

```
$ npm ci
$ npm run verify
 Test Files  47 passed (47)
      Tests  445 passed (445)
```

Then, from that same clean checkout's actual build output (not the test
suite — the literal `npm start` a production systemd unit would run):

```
$ DB_PATH=:memory: PORT=4603 npm start
workout-logger listening on http://localhost:4603
$ curl http://localhost:4603/api/health
{"status":"ok"}   HTTP 200
```

445 = 443 pre-existing tests (unchanged, still passing) + 2 new.

## Not done in this pass (blocked on user-provided prerequisites)

Per spec §46/§47, the following can only be done with information only
the user can supply, and are the only things this session will ask for:
an Oracle Cloud VM with a public IPv4 and SSH access, and a
`DEPLOYMENT_HOSTNAME` with its DNS A record pointed at that VM. All
architecture decisions (OCI Always Free, Node/Express/Nginx/systemd,
SQLite-on-persistent-disk) are already fixed by the spec and were not
re-litigated. Once VM access is available, the runbook in
`docs/PRODUCTION_DEPLOYMENT.md` covers every remaining step through the
mandatory persistence test, backup/restore test, and full application
smoke test, ending in the spec's required PASS/FAIL deployment report.
