# DigitalOcean App Platform

[`.do/app.yaml`](../.do/app.yaml) is the production spec. It **attaches the owner-provisioned DigitalOcean Managed PostgreSQL cluster `tarubot-pg`** (PostgreSQL 18, database and user `tarubot`) with `production: true`. App Platform neither creates nor resizes that cluster, and the spec runs no PostgreSQL container.

Never create the app from the file directly. [`scripts/app-spec.ts`](../scripts/app-spec.ts) derives the reviewed deployment phases below, so that no phase can start an unintended bot writer or detach the cluster. Provisioning the cluster, creating or updating the app, and changing trusted sources are separately authorized owner actions. Generating or validating a spec authorizes none of them.

## Components

| Component | App Platform type | Purpose |
| --- | --- | --- |
| `tarubot` | One worker, 1 GB | Discord gateway, application decisions, and durable work. Present only from activation onward. |
| `nodestone` | Internal-only service, 1 GB | Source-built parser/selector sidecar, port 8080 |
| `migrate` | Pre-deploy job, 512 MB | Applies numbered SQL migrations up to the image's `SCHEMA_VERSION`, using the same bot image |
| `db` | Existing Managed PostgreSQL 18 cluster `tarubot-pg`, database and user `tarubot` | Persistent application state, attached rather than created |

All application components use matching **2.13.0** GHCR images; wait for their checked merge and publication before deploying the template. The production cutover itself uses a published release at or above 2.15.0 ([MIGRATION.md](MIGRATION.md)). The images include the Linux AMD64 support App Platform requires. GHCR does not support App Platform image-push autodeploy, so update the image reference explicitly. Immutable digests may replace tags after publication; keep the bot and migration references identical.

Nodestone has `internal_ports: [8080]`, no `http_port`, and no ingress route. The worker reaches it at `http://nodestone:8080`. Only the worker receives the Discord token; only the worker and migration job receive database connection variables. The worker's liveness probe uses port 3000 and `/health/live`; readiness remains available inside its console at `/health/ready`. Both processes have a 30-second termination grace period.

The worker commits these non-secret settings:
- `DISCORD_APPLICATION_ID "965294750741692416"`. Startup refuses a token that belongs to any other application.
- `ENABLE_EFFECTS "true"`. The worker exists only from activation onward, and an imported guild still needs its persisted activation flag.
- `TEST_GUILD_ID ""` and `PUBLIC_TEST_RESPONSES "false"`.
- `TARUBOT_ENVIRONMENT production`, so maintenance tools run from its console resolve the production profile.

`DISCORD_TOKEN` stays a `REPLACE_WITH_` placeholder in the repository; fill it only in an untracked copy. The migrate job also sets `TARUBOT_ENVIRONMENT production`, so `migrate.js` requires the managed direct port, the `tarubot` login, and a CA ([CONFIGURATION.md](CONFIGURATION.md#maintenance-tool-profiles)).

## Provider prerequisites (owner-authorized)

1. **Cluster.** Create `tarubot-pg` with PostgreSQL 18 in an NYC datacenter, close to the app's `region: nyc`. Clusters cannot be renamed, and the spec pins the name.
   - The owner chooses the edition, node size, standby node, storage autoscaling, and weekly maintenance window. Put the maintenance window at a quiet hour, never inside the cutover window.
   - Do not create a connection pool (PgBouncer) for this app.
   - **Connection budget:** a 1 GiB node allows 22 backend connections and a 2 GiB node 47. The worker's pool allows 12 (one of them holds the writer lease), each local tool opens its own pool of up to 12, and `check-restore` opens two. 1 GiB works only if the worker and the tools never run at the same time; 2 GiB leaves headroom.
2. **Database and user.** Create database `tarubot` and user `tarubot`, in the control panel or with `doctl databases db create CLUSTER_ID tarubot` and `doctl databases user create CLUSTER_ID tarubot`. Never use `doadmin` or `defaultdb` for the app. The cutover rehearsal also needs `tarubot_rehearsal` and `tarubot_restore_test`, and a same-cluster production restore uses `tarubot_restore`. `doadmin` creates them, grants each as below, and drops them afterwards.
3. **Grants.** PostgreSQL 15 and later no longer give PUBLIC `CREATE` on the public schema. As `doadmin`, connected to the database being granted:

   ```sql
   GRANT CONNECT ON DATABASE tarubot TO tarubot;
   GRANT USAGE, CREATE ON SCHEMA public TO tarubot;
   SELECT has_schema_privilege('tarubot','public','USAGE') AS usage,
          has_schema_privilege('tarubot','public','CREATE') AS "create";
   ```

   `ALTER DATABASE tarubot OWNER TO tarubot` is an alternative where `doadmin` may run it. Every schema-changing or writing tool connects as `tarubot`: `doadmin` is not a superuser, so tables it created would be unusable by the app. The managed-privileges integration test proves that every migration runs with exactly these grants.
4. **Trusted sources.** Add the operator's current IP first, with `doctl databases firewalls append CLUSTER_ID --rule ip_addr:IP`. That turns the restriction on, so App Platform adds the app automatically when it is created. After creating the app, `doctl databases firewalls list CLUSTER_ID` must show an `app:APP_ID` rule; without it the pre-deploy migration cannot connect. Remove the IP rule after each maintenance window unless the owner keeps a narrow rule for exports.
5. **CA certificate.** Download the CA from the control panel ("Download CA certificate"), or decode the base64 from `doctl databases get-ca CLUSTER_ID -o json`. Keep it outside Git. Local tools take it through `DATABASE_CA_CERT`.

## Database binding and TLS

The spec binds only `${db.DATABASE_URL}`, the cluster's direct connection on port 25060, and `${db.CA_CERT}` to `DATABASE_CA_CERT`. It never binds a connection pool, because session advisory locks, including the writer lease, need a real session. It does not bind `${db.DATABASE_PRIVATE_URL}` at launch: that needs a `vpc` and proof that the private hostname passes TLS hostname verification, which is later hardening. `app-spec.js` refuses any spec that binds a pool or the private URL, or binds `DATABASE_URL` without the CA.

The shared PostgreSQL boundary supplies the CA to node-postgres with certificate and hostname verification enabled. When a CA is set, URL SSL switches are removed before native driver parsing, so a URL's `sslmode` cannot discard the CA or disable verification. An empty or unset CA preserves the driver configuration used by local Compose. Rotating the cluster CA needs a redeploy to refresh `${db.CA_CERT}`.

## Deployment phases

`bun dist/scripts/app-spec.js PHASE INPUT OUTPUT` (or `bun run app:spec …` in a checkout) derives a phase from the template or an exported live spec. It refuses to write in place, writes the output with mode 0600 because exported specs carry encrypted secrets, and prints only component names. Error messages name components, keys, and paths, never values.

| Phase | Keeps | Use |
| --- | --- | --- |
| `foundation` | Database, Nodestone, the pre-deploy `migrate` job, alerts; **no worker** | Creating the app before activation |
| `maintenance` | Database, Nodestone, alerts; **no worker and no jobs** | Stopping the writer for migrations, restores, and recovery |
| `full` | Everything, after checking for exactly one non-autoscaled worker with one instance and no `REPLACE_WITH_` placeholder | Activation and steady-state updates, from an untracked copy with the token filled |

Every phase checks the same things:
- exactly one PostgreSQL database with `production: true` and a named cluster, database, and user (not `doadmin` or `defaultdb`);
- at least one service;
- the exact `${db.DATABASE_URL}` and `${db.CA_CERT}` bindings;
- a CA wherever `DATABASE_URL` is bound.

Worker-free phases also refuse any component that would still receive `DISCORD_TOKEN`. Encrypted `EV[...]` values from exported specs pass through unchanged.

App Platform has no worker-level scale-to-zero, and archiving stops every component, so a worker-free phase simply omits the worker.

## Creating the app without a writer

After the provider prerequisites:

```sh
bun dist/scripts/app-spec.js foundation .do/app.yaml .cache/app-platform-foundation.yaml
doctl apps spec validate .cache/app-platform-foundation.yaml --schema-only > /dev/null
doctl apps create --spec .cache/app-platform-foundation.yaml --format ID
```

For private GHCR packages, add `registry_credentials: USERNAME:READ_PACKAGES_TOKEN` to the image objects in that untracked copy. DO encrypts submitted credentials; keep the encrypted form in later exported specs.

The foundation app starts Nodestone and runs the pre-deploy migration inside App Platform. That proves the database binding, verified TLS, the trusted-source rule, and the public-schema grants, with no Discord connection and no bot writer. Collect this evidence:
- `Schema ready.` in the job log;
- the `app:` rule in the firewall list;
- from the operator's machine as `tarubot`, the top `schema_migrations` version equals the release's `SCHEMA_VERSION`;
- `SELECT count(*) FROM guilds` returns 0.

The window's import, preview, activation, and command registration then run from local tools ([MIGRATION.md](MIGRATION.md) E3). After activation, the worker is added by applying the `full` phase of an untracked copy of the release's template with the token filled (W13). Once the worker reports ready, delete that filled copy and its checked output: they hold the token in plaintext, and later `full` updates start from the exported live spec, where it appears only as `EV[...]`. Check readiness from the worker console:

```sh
bun -e 'const response = await fetch("http://localhost:3000/health/ready"); console.log(await response.text())'
```

Production commands are registered in global scope from the local tools: `register.js --global`, then `commands.js clear-guild` for leftover guild scopes, then `commands.js list` exiting 0. They are not registered from the worker console.

## Single-writer updates and migrations

Exactly one bot process writes to the database. Each bot process takes the PostgreSQL writer lease before it logs in or starts its queue ([OPERATIONS.md](OPERATIONS.md#single-database-writer)). During an overlapping deployment, the new worker waits with liveness 200 and readiness false until the old one stops. `instance_count: 1` is a scaling setting, not a lock.

The pre-deploy job is not held back by the lease, and it can run before the old worker stops. Use this maintenance sequence for every update that carries a migration, and for restores:

1. Export the **current live spec**, which keeps the encrypted secrets. Do not recreate the app or remove or rename its database component.
2. Derive the `maintenance` phase from it and apply it. Wait for the deployment to finish, then confirm with the writer-lease gate that no writer is connected.
3. Take an independent export and record a point-in-time-recovery timestamp ([OPERATIONS.md](OPERATIONS.md#managed-postgresql-backups-and-recovery)).
4. In the exported live spec, set the worker, migration, and Nodestone images to the same verified release. Check it with the `full` phase and apply it. The pre-deploy migration now runs with no writer, and the new worker takes the lease afterwards. Verify readiness, the installed version, and durable work before closing the window.

```sh
doctl apps spec get APP_ID --format yaml > .cache/app-platform-live.yaml && chmod 600 .cache/app-platform-live.yaml
bun dist/scripts/app-spec.js maintenance .cache/app-platform-live.yaml .cache/app-platform-maintenance.yaml
doctl apps update APP_ID --spec .cache/app-platform-maintenance.yaml
# Wait for that deployment, run the writer-lease gate, and back up the database.
# Edit the image tags in .cache/app-platform-live.yaml, then:
bun dist/scripts/app-spec.js full .cache/app-platform-live.yaml .cache/app-platform-next.yaml
doctl apps update APP_ID --spec .cache/app-platform-next.yaml
```

A configuration-only update with no migration, such as a token rotation, may apply `full` directly. To rotate the Discord token: export a fresh live spec (`doctl apps spec get APP_ID --format yaml > .cache/app-platform-live.yaml && chmod 600 .cache/app-platform-live.yaml`), replace the worker's `DISCORD_TOKEN` `EV[...]` value with the new token while keeping `type: SECRET`, run `bun dist/scripts/app-spec.js full .cache/app-platform-live.yaml .cache/app-platform-next.yaml` and `doctl apps update APP_ID --spec .cache/app-platform-next.yaml`, and once `/health/ready` reports ready run `rm -f .cache/app-platform-live.yaml .cache/app-platform-next.yaml`, because both hold the new token in plaintext. Put the new token in the production env file only if local tools still need it. The lease keeps the replacement worker waiting until the previous one stops. Never scale the worker horizontally or run a Compose writer against this database. Keep a database backup and the previous image references for recovery: switching image tags does not reverse a migration.

## Backups, PITR, and recovery

- **Provider backups.** Managed PostgreSQL keeps daily backups for 7 days, and WAL gives point-in-time recovery (PITR) anywhere in that window. A restore always **forks a new cluster**, with its own host, trusted sources, and possibly a new CA, holding copies of all databases and users.
- **Independent exports.** Take a `pg_dump -Fc` as `tarubot` over verified TLS before every maintenance window and on an owner-chosen schedule. Keep it off the provider, with the cutover artifacts. Destroying the cluster destroys its backups, and PITR stops at 7 days.
- **Never destroy or detach** the app, its database component, or the cluster as a recovery step.

To recover after activation, keeping acknowledged decisions:
1. Stop the writer with the `maintenance` phase.
2. Fork the cluster (for example `tarubot-pg-rYYYYMMDD`) at the chosen time. Never choose a time before activation once user decisions have been acknowledged.
3. In the exported live spec, point `databases[0].cluster_name` at the fork. The component name `db` stays the same, and so does every binding.
4. Repoint the local production tooling before any tool, gate or backup runs: set the fork's host in the production env file's `DATABASE_URL` and its CA in `DATABASE_CA_CERT` (leave `RESTORE_DATABASE_CA_CERT` empty), copy the CA to `work/ca-certificate.crt`, re-export `PGHOST` with the fork's host, add the operator's address to the fork's trusted sources if local tools need it, and run the writer-lease gate against the fork.
5. With the old cluster's writer stopped, have `doadmin` rename the original cluster's database (`ALTER DATABASE tarubot RENAME TO tarubot_superseded_YYYYMMDD`) so any stale env file, `PGHOST` or template that still names the old cluster fails to connect instead of writing to it. Do not destroy the old cluster as a recovery step.
6. Confirm the fork's trusted sources include the app, then apply `full`.
7. Record the new cluster name in the repository template in a follow-up pull request; until it merges, every later `full` spec must carry the fork's cluster name.

The alternative is for `doadmin` to restore the fork's export into the original cluster's database, repeating the grants.

To rehearse a restore (OPS-13), in a maintenance window with the worker removed:
1. Record the time T and fork the cluster at T.
2. Run `check-restore.js` with `DATABASE_URL` set to the primary and `RESTORE_DATABASE_URL` set to the fork's `tarubot`. Set `RESTORE_DATABASE_CA_CERT` if the fork's CA differs. It must match exactly.
3. Destroy the fork, which is billed; this is an authorized action.

A same-cluster alternative restores into `tarubot_restore` with `pg_restore --no-owner --no-privileges`. See [OPERATIONS.md](OPERATIONS.md#managed-postgresql-backups-and-recovery) for the commands.

## Verification and provider references

CI derives the `foundation` and `maintenance` phases and validates them, together with the template, using the pinned doctl 1.169.0 image under `--network none --schema-only`.

Unit tests cover:
- managed-cluster attachment and the PostgreSQL major matching Compose (18);
- matching release images and a single worker;
- private parser routing and component-scoped secrets;
- refusal of pools and private URLs, and the CA wherever `DATABASE_URL` is bound;
- the sole effect-enabled worker;
- the production tool profile of the migrate job and console tools;
- every phase and refusal of `app-spec.ts`, including mode 0600 output;
- real node-postgres TLS option parsing.

The managed-privileges integration test proves that migrations run with only the documented grants and leave every object owned by the application login.

These checks create no cloud resources, and schema validation cannot detect a missing cluster, user, or grant, or a version mismatch with the real cluster. Only the authorized foundation deployment can.

- [App Spec reference](https://docs.digitalocean.com/products/app-platform/reference/app-spec/)
- [Managed databases in App Platform](https://docs.digitalocean.com/products/app-platform/how-to/manage-databases/)
- [Internal-only service ports](https://docs.digitalocean.com/products/app-platform/how-to/manage-internal-routing/)
- [Runtime bindable database variables](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/)
- [GHCR images and deployment behavior](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-container-images/)
- [PostgreSQL limits and connection counts](https://docs.digitalocean.com/products/databases/postgresql/details/limits/)
- [Restoring from backups](https://docs.digitalocean.com/products/databases/postgresql/how-to/restore-from-backups/)
- [Trusted sources (firewalls)](https://docs.digitalocean.com/reference/doctl/reference/databases/firewalls/)
