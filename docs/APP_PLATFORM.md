# DigitalOcean App Platform

Use [`.do/app.yaml`](../.do/app.yaml) to create the app with a **new inline PostgreSQL 18 dev database**, as selected for this deployment. It needs no existing cluster and runs no PostgreSQL container.

## Components

| Component | App Platform type | Purpose |
| --- | --- | --- |
| `tarubot` | One worker, 1 GB | Discord gateway, application decisions, and durable work |
| `nodestone` | Internal-only service, 1 GB | Source-built parser/selector sidecar, port 8080 |
| `migrate` | Pre-deploy job, 512 MB | Apply/check numbered SQL migrations using the same bot image |
| `db` | Inline PostgreSQL 18 dev database | Persistent application state provisioned by App Platform |

All application components use matching **2.12.3** GHCR images; wait for their checked merge/publication before deploying this template. The images contain Linux AMD64 support required by App Platform. GHCR does not support App Platform image-push autodeploy, so update the image reference explicitly. Immutable digests may replace tags after publication; keep bot and migration references identical.

Nodestone has `internal_ports: [8080]`, no `http_port`, and no ingress route. The worker reaches it at `http://nodestone:8080`. Only the worker receives the Discord token; only the worker and migration job receive database connection variables. The worker's HTTP liveness probe uses port 3000 and `/health/live`; readiness remains available inside its console at `/health/ready`. Both processes have a 30-second termination grace period.

## Database provisioning and TLS

The spec deliberately sets `production: false` and omits `cluster_name`, `db_name`, and `db_user`. App Platform creates its dev PostgreSQL database and injects its credentials through `${db.DATABASE_URL}`. This is a DO-hosted database with dev-tier limits, including no permission to create additional databases. The application's migrations create tables/domains/functions within the supplied database, not a new database.

`${db.CA_CERT}` is bound to `DATABASE_CA_CERT`. The shared PostgreSQL boundary supplies that CA to node-postgres with certificate and hostname verification enabled. When this variable is set, URL SSL switches are removed before native driver parsing so a URL's `sslmode` cannot discard the CA or disable verification. Empty/unset CA preserves the existing driver configuration used by local Compose. Use direct database connections; the application's session advisory locks are incompatible with transaction-mode connection pooling.

The App Spec can create this dev database inline. A production DigitalOcean Managed Database instead requires its separately provisioned cluster name. DigitalOcean provides a control-panel conversion from dev to managed if that becomes necessary. Follow the provider's backup/lifecycle guidance and the project's [recovery runbook](OPERATIONS.md); keep independent exports before migration or destructive app/database changes.

## First deployment

1. Install/authenticate `doctl`, and copy the template to an ignored location such as `.cache/app-platform.yaml`.
2. Set the app name/region, replace `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`, and review instance sizes. Supply the token as a DO **secret**. For a test bot, set `TEST_GUILD_ID`; optionally enable `PUBLIC_TEST_RESPONSES` and set `TEST_PLAN_CHANNEL_ID`.
3. If GHCR packages are private, add `registry_credentials: USERNAME:READ_PACKAGES_TOKEN` to the bot and Nodestone image objects in that private copy. The migration job inherits the bot image via the YAML anchor. DO encrypts submitted credentials; preserve the encrypted form in subsequent exported specs.
4. Stop any existing process using the same Discord bot/database before starting this worker. Keep exactly one active bot writer. `ENABLE_EFFECTS` starts false; it pauses outbound effects, not command admission or database decisions.
5. Validate the spec and create the app. The pre-deploy job installs schema 003 before the worker starts.

```sh
# Schema validation is offline; suppress normalized output when a private copy contains secrets.
doctl apps spec validate .cache/app-platform.yaml --schema-only > /dev/null
doctl apps create --spec .cache/app-platform.yaml --format ID
```

Watch the migration/job and worker logs in App Platform. Check `/health/ready` from the worker console:

```sh
bun -e 'const response = await fetch("http://localhost:3000/health/ready"); console.log(await response.text())'
```

Register commands explicitly from that console, choosing exactly one scope:

```sh
bun dist/scripts/register.js --guild YOUR_TEST_GUILD_ID
# Production cutover uses: bun dist/scripts/register.js --global
```

Follow [MIGRATION.md](MIGRATION.md) for legacy import/activation, or configure a fresh guild using [SETUP.md](SETUP.md). Enable `ENABLE_EFFECTS` for the intended deployment when ready; imported guilds also need their persisted activation flag.

## Single-writer updates and migrations

App Platform deployments can overlap old and new containers. `instance_count: 1` controls steady-state scaling; it is not a singleton deployment lock. A pre-deploy job also runs before the old worker has necessarily stopped. Use this explicit maintenance sequence for updates, including schema changes:

1. Export the **current live spec**, retaining its database identity and encrypted secrets. Do not recreate the app or remove/rename its database component.
2. Make a maintenance copy that removes only `workers` and `jobs`; retain the existing `databases` and internal Nodestone service. Apply it and wait for deployment completion so the old bot writer is stopped.
3. Back up/export the database using its connection details. Create the next deployment spec from the exported full spec, changing the worker, migration, and sidecar to the same verified release. Preserve DO-generated database fields and encrypted credentials.
4. Apply that full updated spec. Its pre-deploy migration now runs with no bot writer; the new worker starts afterward. Verify readiness, installed version, and durable work before concluding the window.

```sh
doctl apps spec get APP_ID --deployment ACTIVE_DEPLOYMENT_ID --format yaml > .cache/app-platform-live.yaml
# Make the two reviewed copies described above before applying them.
doctl apps update APP_ID --spec .cache/app-platform-maintenance.yaml
# Wait for that deployment to finish, then back up the database.
doctl apps update APP_ID --spec .cache/app-platform-next.yaml
```

Use exported specs for existing apps so the provider-assigned dev cluster and encrypted secrets are retained. Never scale the bot worker horizontally or run the Compose writer alongside it. Keep a database backup and the previous image references for recovery; a database migration is not reversed by switching image tags.

## Verification and provider references

CI runs the pinned `doctl` schema validator without network access or cloud credentials. Local unit checks cover matching image versions, automatic database creation, private parser routing, credential scope, and real node-postgres TLS option parsing. Creating a real App Platform deployment still requires your DO account, filled credentials, and published images; no cloud resources are created by these checks.

- [App Spec reference](https://docs.digitalocean.com/products/app-platform/reference/app-spec/)
- [Database creation and dev-to-managed conversion](https://docs.digitalocean.com/products/app-platform/how-to/manage-databases/)
- [Internal-only service ports](https://docs.digitalocean.com/products/app-platform/how-to/manage-internal-routing/)
- [Runtime bindable database variables](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/)
- [GHCR images and deployment behavior](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-container-images/)
