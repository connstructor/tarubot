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
| Settings copy | Encrypted with `age` in `~/tarubot-cutover/env-backups/` on the operator machine (2.23.0; see "Settings copy"). |
| Backups | A daily encrypted dump at 04:30 UTC, and a settings copy, uploaded to Linode Object Storage `tarubot-backups` (2.24.0; see "Backups and recovery"). |
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

There are three layers:
- **Linode's point-in-time recovery.** The managed cluster keeps its own backups. On 2026-09-25 its restore window reached back to the cluster's creation. Restoring forks a new cluster in the Linode console.
- **Daily encrypted dumps (2.24.0),** kept in Linode Object Storage. They're independent of the cluster, so they survive a deleted or broken cluster.
- **A dump before every migration,** kept on the operator machine (below).

The cluster's weekly maintenance runs Tuesdays from 19:00 UTC for up to 4 hours. On this single-node cluster a restart can drop the bot's connection. The bot then exits, Docker restarts it, and it waits for the writer lease again. A long outage trips the heartbeat.

### Daily dumps

`ops/backup.sh` runs at 04:30 UTC from the `tarubot` user's crontab on the host:
1. `pg_dump` runs in the pinned PostgreSQL 18 image, through the production Compose file's `backup` service. The service sits behind a profile, so `up` never starts it. It uses the bot's database URL and CA.
2. The dump streams straight into `age`, encrypted for [`ops/age-recipients.txt`](../ops/age-recipients.txt). No unencrypted dump touches the disk, and the host can't decrypt what it wrote.
3. `curl` uploads it with SigV4 signing to `daily/`, and also to `monthly/` on the 1st.
4. The host's `.env` goes to `env/` the same way, so the settings copy stays current without the operator machine.
5. healthchecks.io's "TaruBot backups" check (period 1 day, grace 3 hours) hears the start, then success with the sizes, or a failure naming the step. The script logs one line per run to `~/tarubot-backup.log`.

| Piece | Where |
| --- | --- |
| Bucket | `tarubot-backups` in Linode Object Storage, `us-iad-2`, at `https://tarubot-backups.us-iad-18.linodeobjects.com`. The access key `tarubot-backup-key` is limited to this bucket. Linode offers no write-only keys, so a compromised host could delete copies. The copies are encrypted, and the operator machine can pull its own. |
| Retention | [`ops/bucket-lifecycle.xml`](../ops/bucket-lifecycle.xml): `daily/` and `env/` for 30 days, `monthly/` for 365 days. |
| Settings | In the host's `.env`: `BACKUP_STORAGE_ENDPOINT`, `BACKUP_STORAGE_ACCESS_KEY`, `BACKUP_STORAGE_SECRET_KEY`, `BACKUP_STORAGE_REGION` (`us-iad-2`) and `HEALTHCHECKS_BACKUP_URL`. The bot never sees them, because Compose passes it only its own settings. The operator copies are `~/tarubot-cutover/backup-storage.env` and `~/tarubot-cutover/healthchecks-backup.url`. |

**Setting it up** (on a new host, rebuild step 10). A settings copy taken on or after 2026-09-25 already holds the storage settings, so after a restore only the schedule is needed:

```sh
# From the operator machine: the storage settings and the check URL, over SSH stdin.
set -a; . ~/tarubot-cutover/backup-storage.env; set +a
{ printf 'BACKUP_STORAGE_ENDPOINT=%s\nBACKUP_STORAGE_ACCESS_KEY=%s\nBACKUP_STORAGE_SECRET_KEY=%s\nBACKUP_STORAGE_REGION=us-iad-2\n' \
    "$BACKUP_STORAGE_ENDPOINT" "$BACKUP_STORAGE_ACCESS_KEY" "$BACKUP_STORAGE_SECRET_KEY"
  printf 'HEALTHCHECKS_BACKUP_URL=%s\n' "$(tr -d '\r\n' < ~/tarubot-cutover/healthchecks-backup.url)"
} | ssh tarubot@tarubot.deconfined.com 'set -e; umask 077; cd ~/tarubot; tmp=$(mktemp .env.XXXXXX)
    grep -v -E "^(BACKUP_STORAGE_[A-Z_]+|HEALTHCHECKS_BACKUP_URL)=" .env > "$tmp"; cat >> "$tmp"
    chmod 600 "$tmp"; mv "$tmp" .env'
# On the host, as tarubot: the schedule, then one run to check it.
( crontab -l 2>/dev/null | grep -v ops/backup.sh; echo '30 4 * * * $HOME/tarubot/ops/backup.sh >> $HOME/tarubot-backup.log 2>&1' ) | crontab -
~/tarubot/ops/backup.sh
```

A new bucket also needs its retention rules, set once from the operator machine with the bucket's key:

```sh
set -a; . ~/tarubot-cutover/backup-storage.env; set +a
printf 'user = "%s:%s"\n' "$BACKUP_STORAGE_ACCESS_KEY" "$BACKUP_STORAGE_SECRET_KEY" |
  curl --config - -sS --fail --aws-sigv4 "aws:amz:us-iad-2:s3" -X PUT \
    -H "Content-MD5: $(openssl md5 -binary ops/bucket-lifecycle.xml | base64)" \
    --data-binary @ops/bucket-lifecycle.xml "https://${BACKUP_STORAGE_ENDPOINT%/}/?lifecycle"
```

**Restoring a dump.** Restore into a new database, never over the live one. Use a new cluster, or `tarubot_restore` on the same cluster:

```sh
set -a; . ~/tarubot-cutover/backup-storage.env; set +a
base="https://${BACKUP_STORAGE_ENDPOINT%/}"
s3() { printf 'user = "%s:%s"\n' "$BACKUP_STORAGE_ACCESS_KEY" "$BACKUP_STORAGE_SECRET_KEY" |
  curl --config - -sS --fail --aws-sigv4 "aws:amz:us-iad-2:s3" "$@"; }
s3 "$base/?list-type=2&prefix=daily/" | grep -o '<Key>[^<]*' | cut -c6-   # the copies, oldest first
s3 -o db.age "$base/daily/tarubot-YYYYMMDDTHHMMSSZ.dump.age"
age --decrypt --identity ~/tarubot-cutover/age/tarubot.key -o db.dump db.age
pg_restore --no-owner --no-privileges --exit-on-error -d "NEW_DATABASE_URL" db.dump
```

Compare the result with `check-restore.js`, then stop the bot and point `DATABASE_URL` at it. Settings copies in `env/` decrypt the same way.

**Before a migration** keep taking an independent `pg_dump` on the operator machine, as in the migration procedure above. Running `~/tarubot/ops/backup.sh` on the host right before also puts a fresh copy off-site. The 2026-09-24 cutover left `pre-activation.dump` and `move-to-linode.dump` in `~/tarubot-cutover/work/backups/`.

**Restore checks:** `check-restore.js` compares a restored copy with the source. The production profile accepts `tarubot` on another host, such as a new cluster, or `tarubot_restore` on the same host.

## Settings copy (off the host)

The host's `.env` is the one thing a rebuild can't recreate from Git, so an encrypted copy is kept off the host (since 2.23.0). `scripts/host-env-backup.ts` runs on the operator machine. It reads `~/tarubot/.env` over SSH and encrypts it with [`age`](https://age-encryption.org) for the public keys in [`ops/age-recipients.txt`](../ops/age-recipients.txt). It writes only the encrypted file, to `~/tarubot-cutover/env-backups/tarubot-env-<UTC time>.age` (mode 600). The settings never touch the operator machine's disk or the terminal.

```sh
bun run host:env-backup -- --identity ~/tarubot-cutover/age/tarubot.key
```

- **The output** names the settings present and any expected ones that are absent, never their values. With `--identity`, it also decrypts the new copy in memory and confirms it matches what was read.
- **When to run it:** after any change to the host's `.env`, such as a rotated token or a new setting. A release only changes `TARUBOT_IMAGE_TAG`, which a restore sets anyway (step 7 below).
- **The private key** is `~/tarubot-cutover/age/tarubot.key` on the operator machine (mode 600). The owner keeps a second copy offline, in a password manager. Without the key the copies can't be opened, and the daily database backups (2.24.0) use the same key.

## Rebuilding the host

Use this when the host is lost, compromised, or being replaced. The data lives in the managed database, so a rebuild loses nothing: the new bot picks up its state from PostgreSQL. Budget about an hour, most of it waiting for DNS.

You need the latest settings copy and the `age` key (above), access to Linode, the DNS for `deconfined.com`, and the healthchecks.io check.

1. **Stop the old bot**, if the old host is still reachable: `docker compose -f docker-compose.production.yml stop tarubot`. The writer lease would make a second bot wait anyway; stopping it keeps the handover clean. Pause the healthchecks.io check.
2. **Create the Linode:**
   - label `tarubot`, region `us-iad` (the database's region), type Linode 2 GB (`g6-standard-1`), image Ubuntu 26.04 LTS;
   - the owner's SSH key for root, and a root password kept in the password manager;
   - attach the Cloud Firewall (inbound TCP 22 only, plus ICMP; the host publishes no other ports).
3. **Set up the base system as root** (`ssh root@NEW_IP`):

   ```sh
   apt-get update && apt-get -y full-upgrade
   # Docker CE from Docker's repository, as on the first host.
   install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
     "$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")" > /etc/apt/sources.list.d/docker.sources
   apt-get update
   apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin age unattended-upgrades
   # The tarubot user runs Compose; it needs the docker group, not sudo.
   useradd -m -s /bin/bash -G docker tarubot
   install -d -m 700 -o tarubot -g tarubot /home/tarubot/.ssh
   install -m 600 -o tarubot -g tarubot /root/.ssh/authorized_keys /home/tarubot/.ssh/authorized_keys
   # Key-only SSH: no passwords, and root only with a key.
   printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-tarubot.conf
   sshd -t && systemctl reload ssh
   hostnamectl set-hostname tarubot && timedatectl set-timezone Etc/UTC
   ```

   Before closing the root session, confirm that `ssh tarubot@NEW_IP true` works from the operator machine.
4. **Point DNS at the new host.** Update `tarubot.deconfined.com`'s A and AAAA records to the new addresses. Replace its SSHFP records with the output of `ssh-keygen -r tarubot.deconfined.com` (as root on the new host). On the operator machine, run `ssh-keygen -R tarubot.deconfined.com`. Use the IP address until DNS has updated.
5. **Let the new host reach the database.** In Linode Cloud Manager → Databases → `tarubot-pgsql` → Access Controls, add the new host's IPv4 address. Remove the old host's address in step 11.
6. **Clone the repository** as `tarubot`: `ssh tarubot@NEW_IP 'git clone https://github.com/deconfined/tarubot.git ~/tarubot'`.
7. **Restore the settings** from the operator machine, then pin the current release:

   ```sh
   latest=$(ls -1 ~/tarubot-cutover/env-backups/tarubot-env-*.age | tail -1)
   age --decrypt --identity ~/tarubot-cutover/age/tarubot.key "$latest" \
     | ssh tarubot@NEW_IP 'umask 077; cat > ~/tarubot/.env'
   ssh tarubot@NEW_IP "sed -i 's/^TARUBOT_IMAGE_TAG=.*/TARUBOT_IMAGE_TAG=X.Y.Z/' ~/tarubot/.env && grep -c = ~/tarubot/.env"
   ```

8. **Start the bot:** `ssh tarubot@NEW_IP 'cd ~/tarubot && docker compose -f docker-compose.production.yml pull && docker compose -f docker-compose.production.yml up -d --wait'`.
9. **Check it** with the everyday checks above. Readiness must be all true, and the logs must show "Database writer lease acquired" and "TaruBot ready". Resume the healthchecks.io check; it should turn green within five minutes. Commands are registered globally and survive a rebuild, so there is nothing to register.
10. **Restore the backup schedule:** add the database's new access-list entry first (step 5), then follow "Setting it up" under Daily dumps. The first run should turn the "TaruBot backups" check green.
11. **Retire the old host.** Delete the old Linode and remove its database access entry. Update the Layout table above, and take a fresh settings copy (`bun run host:env-backup`).

## DigitalOcean leftovers

- **App Platform app `tarubot`:** idle in the worker-free maintenance phase, to be deleted. The repository's spec and tooling were retired in 2.21.0.
- **Cluster `tarubot-pg`:** kept a few days as a fallback, then deleted together with its trusted-source rule.
- **The tool guard** still accepts DigitalOcean's direct port 25060 until that cluster is gone.
