-- Wrapped in one transaction: if any statement fails, none of them apply
-- and the live site keeps its old schema (docs/agent/database.md).
BEGIN;

-- The `checkin_staff` role: door staff who may ONLY check guests in (site:event:checkin).
-- They never see emails or event settings. IDEMPOTENT, matched by slug / codename.
-- Not a system role: owners can rename or edit it in /dashboard/roles.
INSERT INTO "roles" ("slug", "name", "description", "is_system", "updated_at") VALUES
  ('checkin_staff', 'Check-in staff', 'Checks guests in at the door. Sees names and ticket codes only.', false, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

-- Declared in the catalogue (src/server/permissions.ts); the app also syncs it, so this insert
-- only makes the grant below possible on a database that has not served a request since deploy.
INSERT INTO "permissions" ("codename", "title", "description", "group_name") VALUES
  ('site:event:checkin', 'Check guests in', 'Scan or search tickets and mark guests as checked in.', 'Events')
ON CONFLICT ("codename") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM (VALUES ('checkin_staff', 'site:event:checkin')) AS g(slug, codename)
JOIN "roles" r ON r."slug" = g.slug
JOIN "permissions" p ON p."codename" = g.codename
ON CONFLICT DO NOTHING;

COMMIT;
