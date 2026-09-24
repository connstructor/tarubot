# Production hosting (Linode)

Production TaruBot has run on a **Linode Docker host with Linode managed PostgreSQL** since 2026-09-24.

The cutover first went live on DigitalOcean App Platform, then moved the same evening, with about 90 seconds of downtime, because **the Lodestone refuses DigitalOcean's addresses**: HTTP 403 at the edge, within milliseconds. From App Platform, Nodestone could not refresh profiles, verify claims or read the roster. Linode's addresses get HTTP 200. [MIGRATION.md](MIGRATION.md#record-of-the-2026-09-24-cutover) has the record. [APP_PLATFORM.md](APP_PLATFORM.md) describes the superseded App Platform setup.

## Layout

| Piece | Where |
| --- | --- |
| Host | Linode `tarubot`: us-iad-2, 1 vCPU / 2 GB, Ubuntu 26.04. Reached as `tarubot@tarubot.deconfined.com`. The DNS zone is DNSSEC-signed and carries SSHFP records, so `ssh -o VerifyHostKeyDNS=yes` checks the host key. |
| Bot and sidecar | `~/tarubot` on the host: a clone of this repository, run with [`docker-compose.production.yml`](../docker-compose.production.yml). It has only `nodestone` and `tarubot`: no bundled PostgreSQL, the release pinned by `TARUBOT_IMAGE_TAG`, bounded logs. |
| Settings | `~/tarubot/.env` on the host, mode 600, never committed: `TARUBOT_IMAGE_TAG`, `DATABASE_URL`, `DATABASE_CA_CERT` and `DISCORD_TOKEN`. Everything else is fixed in the Compose file: the production application ID, `TARUBOT_ENVIRONMENT=production`, effects on, and no test-guild scoping. |
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

Readiness must report `database`, `writerLease`, `discord` and `effects` as true.

## Updating to a release

Releases are published by the repository's `Publish containers` workflow. Try each one on DevBot before production.

**A release without a migration:**

```sh
cd ~/tarubot && git pull --ff-only
sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' .env
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d --wait
```

Compose stops the old container first, which releases the writer lease within its 30-second grace. It then starts the new one, and `--wait` returns once the health check passes. The check allows a 60-second start period. The outage is a few seconds. If the release changes commands, register them from the operator machine: `prod dist/scripts/register.js --global`, then `prod dist/scripts/commands.js list`, which must exit 0.

**A release with a migration.** Stop the bot first. `migrate.js` refuses a pending migration while a bot holds the writer lease.

1. `docker compose -f docker-compose.production.yml stop tarubot`.
2. From the operator machine, run the writer-lease gate, then take an independent backup: `pg pg_dump -d tarubot -Fc -f /work/backups/before-X.Y.Z.dump`. Keep it off the provider, and record its checksum.
3. On the host, after the pull, run `docker compose -f docker-compose.production.yml run --rm --no-deps tarubot bun dist/scripts/migrate.js`. It prints the restore-point line, then `Schema ready.`
4. `docker compose -f docker-compose.production.yml up -d --wait`, then check readiness.

**Rollback** means pinning the previous `TARUBOT_IMAGE_TAG` and running `up -d --wait` again. That only works when no migration lies between the two releases. After a migration, the way back is a fix release or a restore.

## Backups and recovery

- **Linode's backups:** Linode's managed PostgreSQL backups and point-in-time recovery cover the database. Check the plan's retention in the Linode console.
- **Independent backups:** take a `pg_dump` before every migration and keep it on the operator machine, off Linode. The 2026-09-24 cutover left `pre-activation.dump` and `move-to-linode.dump` in `~/tarubot-cutover/work/backups/`.
- **Restore checks:** `check-restore.js` compares a restored copy with the source. The production profile accepts `tarubot` on another host, such as a new cluster, or `tarubot_restore` on the same host.

## DigitalOcean leftovers

- **App Platform app `tarubot`:** idle in the worker-free maintenance phase, to be deleted.
- **Cluster `tarubot-pg`:** kept a few days as a fallback, then deleted together with its trusted-source rule.
- **The tool guard** still accepts DigitalOcean's direct port 25060 until that cluster is gone.
