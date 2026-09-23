-- migrations/005_launch_access_policy.sql (TaruBot 2.13.0; owner launch decisions of 2026-09-23).
-- Registered-visitor Guest (decision 2) needs no schema change: it is derived from links,
-- membership and guest_state in every guild. This file adds first-activation grandfathering state
-- (decision 3) and the per-guild managed-role layout switch (decision 4).
-- Resulting state of existing rows:
--   * guilds created by /setup or /config and never imported (e.g. DevBot 1040379370159743139):
--     role_layout_enabled=true (today's hoist/ordering behavior), guest_grandfather=NULL;
--   * imported guilds never activated (e.g. a rehearsal database imported under 2.12.x):
--     role_layout_enabled=false, guest_grandfather='pending';
--   * imported guilds already activated: role_layout_enabled=false, guest_grandfather=NULL;
--   * an empty database (new managed production cluster, test runs): both UPDATEs are no-ops; the
--     importer writes role_layout_enabled=false and guest_grandfather='pending' on the rows it creates.
-- Neither UPDATE changes guilds.revision, so a guild such as DevBot keeps its configuration revision.

-- 1. Grandfathered grants are durable exactly like approved grants; their provenance records the
--    cutover origin. 001_initial.sql:96 declared this CHECK inline on the column, so PostgreSQL
--    named it guest_grants_provenance_check.
ALTER TABLE guest_grants DROP CONSTRAINT guest_grants_provenance_check;
ALTER TABLE guest_grants ADD CONSTRAINT guest_grants_provenance_check
  CHECK (provenance IN ('approved','manual','imported_guest','grandfathered'));

-- 2. guest_grandfather: NULL = never grandfathered (guilds created by /config or /setup);
--    'pending' = imported guild awaiting its single first-activation run;
--    'completed' = that run committed at guest_grandfathered_at.
--    role_layout_enabled: true = TaruBot keeps the managed roles displayed separately (hoist) in one
--    consecutive FC Leader > Officer > Member > Guest block; false = TaruBot never changes any
--    role's hoist flag or position. The column defaults on, so guilds created later by /setup or
--    /config start on; ADD COLUMN also fills every existing row with true, and step 3 turns imports off.
ALTER TABLE guilds
  ADD COLUMN guest_grandfather text
    CONSTRAINT guest_grandfather_state CHECK (guest_grandfather IN ('pending','completed')),
  ADD COLUMN guest_grandfathered_at timestamptz,
  ADD COLUMN role_layout_enabled boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT guest_grandfather_completion CHECK (
    (guest_grandfather IS NOT DISTINCT FROM 'completed') = (guest_grandfathered_at IS NOT NULL)
  );

-- 3. Imported (legacy cutover) guilds leave the existing server layout alone until a server manager
--    opts in, whether or not they were already activated.
UPDATE guilds g SET role_layout_enabled = false
 WHERE EXISTS (SELECT 1 FROM audit a WHERE a.guild_id = g.id AND a.action = 'migration.import');

-- 4. An imported guild published under schema 004 but never activated still owes its one run.
UPDATE guilds g SET guest_grandfather = 'pending'
 WHERE NOT g.effects_enabled
   AND EXISTS (SELECT 1 FROM audit a WHERE a.guild_id = g.id AND a.action = 'migration.import')
   AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.guild_id = g.id AND a.action = 'activation');
