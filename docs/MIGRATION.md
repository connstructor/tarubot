# Legacy import and cutover

## Preconditions

- Use one authorized application writer during activation and recovery.
- Retain the supplied fixture for rehearsal. If legacy state continues changing, capture a final consistent dump for cutover and reconcile its independently derived counts and balances.
- Freeze legacy database writes and managed Discord role changes during final capture.
- Have the production application's credentials and privileged Guild Members intent available for the complete Discord snapshot.
- Legacy `DATETIME` values use the owner-approved **UTC** interpretation. Their original values and UTC conversion remain in import provenance/reporting. New application instants use `timestamptz`.

The importer reads MySQL/MariaDB dump syntax as data. Its reader handles escaped quoted values, doubled quotes, Unicode, NULL, comments/directives, explicit or schema-derived column ordering, and forward relationships. Input is bounded to 64 MiB. Foreign keys, canonical IDs, balances, and mappings are validated before publication. PostgreSQL publication is one transaction.

## Rehearse

```sh
bun install --frozen-lockfile
bun run build
bun run test:docker
bun run import:legacy --file tarubot_backup.sql --source-timezone UTC --dry-run
```

The supplied acceptance fixture must report 40 FCs, 4,251 characters, 241 users, 161 ownership links, 36 known balances, and four unknown balances. The linked FC is `9232097761132958152`; its recorded opening is **349,279,945 gil**.

The single source guild is `1036062273631952955`. All 161 ownership links and 40 source ledger states map to it. The report records this mapping. A multi-guild input requires `--mapping FILE.json`:

```json
{
  "ownership": { "CHARACTER_ID": ["DESTINATION_GUILD_ID"] },
  "accounts": { "FC_ID": "DESTINATION_GUILD_ID" }
}
```

Every supplied ownership record needs explicit destination guilds; every source FC balance maps once. Guilds observing the same FC still have independent accounts and policy state.

## Final capture and import

These examples use local Bun tooling with the explicit loopback-port override. Set `.env` with production application credentials and matching local-tool PostgreSQL/sidecar URLs, and run the commands from the project directory.

```sh
docker compose -f docker-compose.yml -f docker-compose.tools.yml up -d --wait postgres nodestone
bun run db:migrate
bun run snapshot --dump tarubot_backup.sql --output artifacts/discord-snapshot.json
bun run import:legacy --file tarubot_backup.sql --snapshot artifacts/discord-snapshot.json --source-timezone UTC --dry-run
bun run import:legacy --file tarubot_backup.sql --snapshot artifacts/discord-snapshot.json --source-timezone UTC
```

Retain command output as the import report in your operational records. The database also retains the report, source checksum, timestamp interpretation, stable input keys, and snapshot checksum.

Snapshot enumeration must complete. Every captured human holder of the configured guest role receives an explicit `imported_guest` grant. Snapshot-only users are additional records reported separately from the 241 SQL users. Imported links use trusted `imported_link` provenance, including owners absent from Discord.

Known balances become immutable import opening entries, including known zero. NULL balances produce uninitialized accounts. The imported ledger begins with those opening entries. Source character/FC relationships remain historical cache facts. Imported historical membership is created only where supplied trusted ownership and the source guild's linked FC match.

Imported users have no selected primary character and nickname management disabled. Their captured nicknames are retained. Successful live roster state starts pending, and imported guild effects start disabled.

The same fingerprint is idempotent: rerunning it returns the committed import report and preserves later links, financial entries, preferences, and access decisions. A changed dump targeting an already populated guild produces an explicit conflict for an operator mapping/migration decision.

## Acquire evidence and preview

During the maintenance window, with the old writer stopped:

```sh
bun run roster:acquire 1036062273631952955
bun run preview 1036062273631952955
```

`roster:acquire` publishes fresh evidence and queues reconciliation without applying Discord effects. `preview` reads that evidence and current complete Discord membership, displaying role deltas and nickname targets. Resolve blocked/missing resource configuration before activation.

Imported member-role holders supported by matching imported membership evidence receive two-observation departure protection. The first complete absence starts confirmation; a second at least 60 seconds later can demote them. New member grants require fresh accepted evidence.

## Activate the existing production application

Register exactly the declared command set for the existing application, review the preview, and activate the imported guild:

```sh
bun run commands:register --global
bun run activate 1036062273631952955
```

Set `ENABLE_EFFECTS=true` in `.env`, clear the development-only `TEST_GUILD_ID` restriction for production, and start the sole writer:

```sh
docker compose up -d tarubot
docker compose logs -f tarubot
```

Check `/config validate`, `/sync status`, `/guest status`, and `/ledger balance`. Verify representative proof/assignment, access transitions, nickname opt-in, guest review, and ledger delivery. Imported users can opt in using `/main character:ID` followed by `/nickname enabled:true`; newcomers can use `/apply`.

## Recovery boundary

Before activation, restore the pre-import database or recreate the disposable rehearsal database and rerun the import. The original dump and captured snapshot remain immutable inputs.

After live decisions have been acknowledged, recovery must retain those decisions. Preserve a current PostgreSQL backup plus any newer WAL/PITR data or exported ledger entries, links, grants/revocations, applications, and job decisions. Restore/reconcile those changes before restarting the writer. Re-importing the legacy opening snapshot is not a post-activation recovery mechanism.

See [OPERATIONS.md](OPERATIONS.md) for the backup/restore and retry procedure.
