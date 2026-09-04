# Workout Programmer — Next Phase: Post-Deployment Completion
## Run only after the new feature implementation has passed verification

**Target:** Oracle Cloud deployment of the Workout Programmer
**Architecture:** Node.js + Express + SQLite + systemd + Nginx
**Cost requirement:** ₹0 / Oracle Always Free only

---

# 1. Purpose

The application is already running successfully on the Oracle VM.

The post-deployment work was paused while product issues were discovered during real-world use.

After the two product changes are implemented, tested, and deployed, resume this checklist.

**Do not perform this phase against an unstable/newly modified build until the new build has passed its full test suite.**

---

# 2. Precondition

Before starting this phase, confirm:

- [ ] Latest application changes are deployed.
- [ ] `npm run verify` passed before deployment.
- [ ] App loads through the public HTTP address.
- [ ] Add Unplanned Exercise works.
- [ ] Daily Gym/Badminton/Both behavior works.
- [ ] Existing Substitute flow still works.
- [ ] A real workout has been logged successfully.
- [ ] VM reboot has not yet caused data loss.

Current Oracle deployment details from the existing deployment:

- VM: `workout-programmer-new`
- OS: Ubuntu 24.04 LTS
- Shape: `VM.Standard.E2.1.Micro`
- Public IP at the time of deployment: `68.233.97.63`
- SSH user: `ubuntu`
- App directory: `/home/ubuntu/workout-logger`
- App port: `3000`
- Nginx public port: `80`
- Public app URL currently uses HTTP.
- SQLite database is under the application's `data/` directory.

**Do not assume the public IP is permanent if OCI has changed it. Verify it in OCI before testing.**

---

# 3. Database integrity check

Install SQLite CLI only if it is not already installed:

```bash
sudo apt install -y sqlite3
```

Then check the live database.

The current application database is expected under:

```text
/home/ubuntu/workout-logger/data/workout-logger.sqlite
```

Run:

```bash
cd ~/workout-logger
sqlite3 data/workout-logger.sqlite "PRAGMA integrity_check;"
```

Expected result:

```text
ok
```

Because the application uses WAL mode, do not casually delete `.sqlite-wal` or `.sqlite-shm` files while the application is running.

If the result is anything other than `ok`, stop and investigate before making further changes.

---

# 4. Confirm persistence across reboot

Before rebooting:

```bash
sudo systemctl status workout-logger --no-pager
sudo systemctl status nginx --no-pager
```

Confirm both are active.

Record/verify that the app currently contains the expected workout/profile data.

Then reboot:

```bash
sudo reboot
```

Wait for the VM to become reachable again.

Reconnect by SSH.

Then verify:

```bash
sudo systemctl status workout-logger --no-pager
sudo systemctl status nginx --no-pager
```

Both should automatically be active.

Then test locally:

```bash
curl -I http://localhost
curl -I http://localhost:3000
```

Then test the public URL from the Windows machine.

Finally open the app and confirm:

- profile persists
- current program persists
- logged workouts persist
- new activity assignments persist

**This is an important acceptance test because SQLite data must survive a normal VM reboot.**

---

# 5. Verify SQLite location and permissions

Confirm:

```bash
ls -lah ~/workout-logger/data/
```

The application user must be able to read/write the database.

Expected owner should be `ubuntu`.

Do not change database permissions to world-writable.

Do not move the database to a new storage architecture unless there is a demonstrated need.

The current persistent VM disk is sufficient for the present single-user architecture.

---

# 6. Establish a simple backup strategy

The immediate goal is a **simple, free, reliable SQLite backup**, not a complicated backup platform.

Preferred approach:

- keep backups on the VM
- use SQLite's safe backup mechanism rather than copying a live WAL database blindly
- retain a small number of recent backups
- do not interfere with the running application

A suitable destination is:

```text
/home/ubuntu/workout-logger-backups/
```

The backup mechanism should produce dated SQLite backup files.

Example conceptual command:

```bash
sqlite3 /home/ubuntu/workout-logger/data/workout-logger.sqlite \
  ".backup '/home/ubuntu/workout-logger-backups/workout-logger-YYYY-MM-DD.sqlite'"
```

Replace the date dynamically in the actual script.

Do not simply use:

```bash
cp workout-logger.sqlite backup.sqlite
```

as the primary live-database backup method while WAL mode is active.

---

# 7. Automate backups

Create a small systemd timer or equivalent local scheduler.

Recommended initial policy:

- once per day
- keep approximately 7 recent local backups
- delete older backups automatically

Do not create hourly/high-frequency backups unless a real need appears.

The backup should:

1. create a consistent SQLite backup
2. verify the backup file exists
3. avoid filling the 45 GB root disk
4. rotate old backups

After creating it, manually run the backup once and verify that the resulting file opens successfully.

---

# 8. Understand the limitation of local backups

Local VM backups protect against:

- accidental application data deletion
- database corruption
- bad application migrations

They do **not** fully protect against:

- VM deletion
- disk loss
- account/tenancy loss
- catastrophic cloud failure

If OCI Always Free block-volume backup capacity is available at no charge, evaluate it separately.

**Do not enable anything that introduces a charge.**

Before enabling OCI backup features, verify the current Always Free quota and the actual UI pricing/estimated cost.

Do not assume a service is free merely because the VM itself is Always Free.

---

# 9. Review firewall state

The deployment required TCP port 80 to be allowed at both OCI and the VM firewall level.

Verify:

```bash
sudo iptables -L INPUT -n --line-numbers
```

Confirm TCP 80 is allowed.

The rule was persisted with `iptables-persistent`.

Verify persistence:

```bash
sudo iptables-save | grep -- '--dport 80'
```

Do not remove the working port-80 rule.

---

# 10. SSH security review

Current SSH ingress was opened broadly during setup.

After the deployment is stable, consider restricting TCP 22 to the user's normal IP address if practical.

However:

- do not lock yourself out
- do not remove the current SSH access before testing the replacement rule
- if the user's network changes frequently, keeping SSH open may be operationally simpler for this personal project

This is a hardening step, not a prerequisite for the application to function.

---

# 11. HTTPS decision

The current app is served through:

```text
http://<public-ip>
```

HTTPS should not be added by randomly installing certificates against the raw IP.

A normal public HTTPS certificate setup is much easier with a domain name.

For the strict ₹0 requirement:

- do not purchase a domain solely for this task
- do not add a paid load balancer
- do not add Cloudflare/other paid infrastructure
- do not change the application architecture just to obtain HTTPS

If the user already has a suitable domain/subdomain available at no additional cost, HTTPS can be considered as a separate task.

Until then, understand that the current endpoint is HTTP.

Avoid entering sensitive credentials/secrets into the application.

---

# 12. Verify systemd behavior

Confirm:

```bash
sudo systemctl is-enabled workout-logger
sudo systemctl is-enabled nginx
```

Expected:

```text
enabled
enabled
```

Confirm the application service:

```bash
sudo systemctl status workout-logger --no-pager
```

Check recent logs:

```bash
sudo journalctl -u workout-logger -n 100 --no-pager
```

Look for:

- repeated crashes
- restart loops
- database errors
- port binding failures

Do not treat a one-time startup restart counter as a current failure if the service is stable.

---

# 13. Verify Nginx

Run:

```bash
sudo nginx -t
```

Expected:

```text
syntax is ok
test is successful
```

Then:

```bash
sudo systemctl status nginx --no-pager
```

Confirm the default site has not reintroduced a conflicting server configuration.

The active application site should proxy:

```text
port 80 → 127.0.0.1:3000
```

Do not expose Node directly to the public internet unnecessarily.

---

# 14. Resource sanity check

The VM is a small Always Free E2.1.Micro instance.

Check:

```bash
free -h
df -h
```

Confirm:

- swap exists
- root disk has substantial free space
- Node process is stable
- no runaway memory usage

The deployment already uses a 1 GB swapfile.

Do not increase VM size or add paid resources unless explicitly requested.

---

# 15. Application update procedure

Document the safe update sequence for future releases.

Conceptually:

```bash
cd ~/workout-logger
git pull
npm ci
npm run verify
sudo systemctl restart workout-logger
sudo systemctl status workout-logger --no-pager
```

Before applying updates:

- take a SQLite backup
- confirm the Git working tree state
- do not run `npm audit fix` blindly
- do not upgrade dependency major versions without testing

If `npm run verify` fails, do not restart the production service with the new build.

---

# 16. Database backup before application updates

Before any future deployment that changes schema or persistence logic:

1. Back up the SQLite database.
2. Deploy/test the new application.
3. Verify the application.
4. Keep the previous backup until the new release is confirmed stable.

Never use an application deployment as an excuse to delete the existing database.

---

# 17. Final end-to-end test

Perform one complete user journey:

1. Open public app.
2. Load profile.
3. Confirm daily activity assignments.
4. Generate/load program.
5. Change one day from Gym to Badminton.
6. Change another day to Both.
7. Add an unplanned Blueprint exercise.
8. Log a workout.
9. Refresh browser.
10. Confirm all state remains.
11. Reboot VM.
12. Reopen app.
13. Confirm state and logged history remain.

This is the final confidence test.

---

# 18. Free-tier audit

Before declaring deployment complete, verify that the architecture still consists only of intended Always Free resources.

Expected:

- Oracle Always Free VM
- existing VCN/subnet/Internet Gateway
- root/block storage within free allocation
- no load balancer
- no paid public IP configuration
- no paid managed database
- no paid Cloud Run/serverless service
- no paid monitoring tier
- no unnecessary extra compute

Do not add infrastructure just because it is available in OCI.

---

# 19. Final documentation to leave behind

Create/update a concise deployment document containing:

### Application

- repository
- application directory
- Node version
- build/start commands

### Services

- systemd service name
- Nginx configuration location
- application port
- public port

### Database

- SQLite path
- backup directory
- backup procedure
- restore procedure

### Oracle

- VM shape
- OS
- network/security configuration
- current public IP (if static/reserved and verified)

### Recovery

- how to SSH
- how to restart the app
- how to restart Nginx
- how to inspect logs
- how to restore a SQLite backup

Do not document private SSH key contents.

---

# 20. Completion criteria

Post-deployment work is complete when:

- [ ] Database integrity check returns `ok`.
- [ ] Database survives VM reboot.
- [ ] Application survives VM reboot.
- [ ] systemd starts the app automatically.
- [ ] Nginx starts automatically.
- [ ] Port 80 remains reachable.
- [ ] SQLite backup has been manually tested.
- [ ] Automated backup/rotation is working.
- [ ] Disk usage is healthy.
- [ ] Swap is present.
- [ ] No unexpected service crashes are present.
- [ ] Final end-to-end application test passes.
- [ ] Oracle resources remain within the intended ₹0/Always Free setup.
- [ ] Recovery/update instructions are documented.

---

# 21. Important operating principle

This is a personal single-user Workout Programmer.

Prefer:

> **simple + stable + free + recoverable**

over:

> **more infrastructure + more automation + more services**

Do not introduce architectural complexity unless the current single-user Node/Express/SQLite deployment demonstrably requires it.
