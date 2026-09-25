# Production hosting (Linode)

Production TaruBot has run on a **Linode Docker host with Linode managed PostgreSQL** since 2026-09-24.

The cutover first went live on DigitalOcean App Platform, then moved the same evening, with about 90 seconds of downtime, because **the Lodestone refuses DigitalOcean's addresses**: HTTP 403 at the edge, within milliseconds. From App Platform, Nodestone could not refresh profiles, verify claims or read the roster. Linode's addresses get HTTP 200. [MIGRATION.md](MIGRATION.md#record-of-the-2026-09-24-cutover) has the record. [APP_PLATFORM.md](APP_PLATFORM.md) records the App Platform setup, retired in 2.21.0.

## Layout

| Piece | Where |
| --- | --- |
| Host | Linode `tarubot`: us-iad-2, 1 vCPU / 2 GB, Ubuntu 26.04. Reached as `tarubot@tarubot.deconfined.com`. The DNS zone is DNSSEC-signed and carries SSHFP records, so `ssh -o VerifyHostKeyDNS=yes` checks the host key. |
| Bot | `~/tarubot` on the host: a clone of this repository, run with [`docker-compose.production.yml`](../docker-compose.production.yml). It has only `tarubot`: no bundled PostgreSQL, no parser sidecar (the Lodestone parser runs inside the bot since 2.21.0), the release pinned by `TARUBOT_IMAGE_TAG`, bounded logs. |
| Settings | `~/tarubot/.env` on the host, mode 600, never committed: `TARUBOT_IMAGE_TAG`, `DATABASE_URL`, `DATABASE_CA_CERT`, `DISCORD_TOKEN`, since 2.18.0 `GITHUB_REPORTS_TOKEN` (the issue reporter's token; empty saves reports without sending them), and since 2.22.0 `HEALTHCHECKS_PING_URL` (the heartbeat; see below). Everything else is fixed in the Compose file: the production application ID, `TARUBOT_ENVIRONMENT=production`, effects on, and no test-guild scoping. |
| Database | Linode managed PostgreSQL `tarubot-pgsql`, PostgreSQL 18, us-iad-2. Use the **direct port 27520**, never the 27521 pool, which can't hold the writer lease. The login and database are `tarubot`, and `tarubot` owns the database. The admin login `akmadmin` is for provisioning only; the tool guard refuses it. The allow list holds the host and the operator's address. |
| Operator tools | Run from a clean clone of the deployed release on the operator machine, as `prod dist/scripts/<tool>.js`, with `~/tarubot-cutover/production.env` ([MIGRATION.md](MIGRATION.md#e0-conventions) E0). That file points at the Linode database, with its CA in `DATABASE_CA_CERT`. |

## Everyday checks

```sh
ssh tarubot@tarubot.deconfined.com
cd ~/tarubot
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs --since 1h tarubot
docker compose -f docker-compose.production.yml exec -T tarubot \
  bun -e 'const r = await fetch("http://127.0.0.1:3000/health/ready"); console.log(await r.text())'
```

Readiness must report `database`, `writerLease`, `discord` and `effects` as true. Its `lodestone` object is informational (since 2.21.0; the sidecar's `/health` before):

- `cooldownSeconds` above 0 means new Lodestone requests are paused after a 429 (since 2.17.0). Jobs wait it out.
- `selectors` shows the live selector commit (`source: upstream`) or the bundled set.
- `parsing` and `waiting` count parses running and requests waiting for a parse slot.

## Heartbeat

Since 2.22.0 the bot pings a [healthchecks.io](https://healthchecks.io) check every five minutes while its readiness is fully green (database, writer lease, Discord). When the pings stop, healthchecks.io alerts the owner through Pushover and email. This catches what the issue reporter can't, because the reporter runs inside the bot: the host is down, the container is gone, the process hangs, or the bot has stayed unready.

- **The check:** "TaruBot production", simple schedule, period 5 minutes, grace 10 minutes. A deploy restart or a Discord reconnect stays well inside that, so only about 15 minutes of silence alerts.
- **The URL** is `HEALTHCHECKS_PING_URL` in the host's `.env`. Treat it as private: anyone holding it can ping the check and hide an outage. The operator machine keeps a copy in `~/tarubot-cutover/healthchecks-production.url` (mode 600). Issue reports redact it.
- **Each ping** carries one status line for the check's event log: version, pending and blocked work, degraded FCs, the Lodestone cooldown and the live selectors.
- **No failure pings.** An unready bot stays silent, and the grace period decides when that alerts. A failed ping (healthchecks.io unreachable) is retried every minute and logged once as a warning.
- **Planned maintenance** longer than about 10 minutes, such as a long migration: pause the check in healthchecks.io first, and resume it afterwards. The first ping after the restart also resumes it.
- **When it alerts:** SSH to the host and run the everyday checks above. `docker compose ps` shows whether the container is up; readiness shows which part is not ready.

To set or change the URL on the host from the operator machine, without it passing through a terminal or chat:

```sh
tr -d '\r\n' < ~/tarubot-cutover/healthchecks-production.url | ssh tarubot@tarubot.deconfined.com \
  'set -e; umask 077; cd ~/tarubot; read -r u || true; [ -n "$u" ]; tmp=$(mktemp .env.XXXXXX)
   grep -v "^HEALTHCHECKS_PING_URL=" .env > "$tmp"; printf "HEALTHCHECKS_PING_URL=%s\n" "$u" >> "$tmp"
   chmod 600 "$tmp"; mv "$tmp" .env
   docker compose -f docker-compose.production.yml up -d --wait'
```

## Updating to a release

Releases are published by the repository's `Publish containers` workflow. Try each one on DevBot before production.

**A release without a migration:**

```sh
cd ~/tarubot && git pull --ff-only
sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' .env
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d --wait --remove-orphans
```

`--remove-orphans` removes containers of services the Compose file no longer has, such as the `nodestone` sidecar on the first 2.21.0 deploy; afterwards it does nothing. Compose stops the old container first, which releases the writer lease within its 30-second grace. It then starts the new one, and `--wait` returns once the health check passes. The check allows a 60-second start period. The outage is a few seconds. If the release changes commands, register them from the operator machine: `prod dist/scripts/register.js --global`, then `prod dist/scripts/commands.js list`, which must exit 0.

**A release with a migration.** The migration must run in the *new* image, and only after the bot has stopped: `migrate.js` refuses a pending migration while a bot holds the writer lease.

1. On the host, fetch and pin the release first. Nothing restarts until step 5.

   ```sh
   cd ~/tarubot && git pull --ff-only
   sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' .env
   docker compose -f docker-compose.production.yml pull
   ```

2. `docker compose -f docker-compose.production.yml stop tarubot`.
3. From the operator machine, run the writer-lease gate. It must print nothing. Then take an independent backup: `pg pg_dump -d tarubot -Fc -f /work/backups/before-X.Y.Z.dump`. Keep it off the provider, and record its checksum.
4. On the host, run `docker compose -f docker-compose.production.yml run --rm --no-deps tarubot bun dist/scripts/migrate.js`. Because of step 1, this runs in the new image. It prints the restore-point line with the files it applied, then `Schema ready.` If it applies nothing, the new image wasn't pinned: recheck step 1 before starting the bot.
5. `docker compose -f docker-compose.production.yml up -d --wait --remove-orphans`, then check readiness.

The `pg` helper and the writer-lease gate are MIGRATION.md's [E0 conventions](MIGRATION.md#e0-conventions), with Linode's values: `PGHOST` is the cluster host, `PGPORT=27520`, `PGUSER=tarubot`, and `PGSSLROOTCERT=/work/linode-ca.crt` (the cluster CA, saved in `~/tarubot-cutover/work/`).

**Rollback** means pinning the previous `TARUBOT_IMAGE_TAG` and running `up -d --wait` again. That only works when no migration lies between the two releases. After a migration, the way back is a fix release or a restore. Rolling back past 2.21.0 also needs the older Compose file, which still has the sidecar: check out that release's tag in `~/tarubot` before `up -d --wait`.

## Backups and recovery

- **Linode's backups:** Linode's managed PostgreSQL backups and point-in-time recovery cover the database. Check the plan's retention in the Linode console.
- **Independent backups:** take a `pg_dump` before every migration and keep it on the operator machine, off Linode. The 2026-09-24 cutover left `pre-activation.dump` and `move-to-linode.dump` in `~/tarubot-cutover/work/backups/`.
- **Restore checks:** `check-restore.js` compares a restored copy with the source. The production profile accepts `tarubot` on another host, such as a new cluster, or `tarubot_restore` on the same host.

## DigitalOcean leftovers

- **App Platform app `tarubot`:** idle in the worker-free maintenance phase, to be deleted. The repository's spec and tooling were retired in 2.21.0.
- **Cluster `tarubot-pg`:** kept a few days as a fallback, then deleted together with its trusted-source rule.
- **The tool guard** still accepts DigitalOcean's direct port 25060 until that cluster is gone.
