-- Wrapped in one transaction: if any statement fails, none of them apply
-- and the live site keeps its old schema (docs/agent/database.md).
BEGIN;

-- The door-staff role was created as `checkin_staff` (20261030100000_checkin_role), but the
-- platform's role API only accepts slugs of lowercase letters, digits and hyphens, so nobody
-- could assign it. Rename it to `checkin-staff`, keeping its id (so every user who holds it and
-- every permission it grants stay attached). IDEMPOTENT: safe to run on any database state.

-- 1. If an owner already made a `checkin-staff` role by hand, fold the old role into it first:
--    move its holders and grants across, then drop the old row.
INSERT INTO "user_roles" ("user_id", "role_id", "granted_by", "created_at")
SELECT ur."user_id", n."id", ur."granted_by", ur."created_at"
FROM "user_roles" ur
JOIN "roles" o ON o."id" = ur."role_id" AND o."slug" = 'checkin_staff'
JOIN "roles" n ON n."slug" = 'checkin-staff'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "granted_by", "created_at")
SELECT n."id", rp."permission_id", rp."granted_by", rp."created_at"
FROM "role_permissions" rp
JOIN "roles" o ON o."id" = rp."role_id" AND o."slug" = 'checkin_staff'
JOIN "roles" n ON n."slug" = 'checkin-staff'
ON CONFLICT DO NOTHING;

DELETE FROM "roles"
WHERE "slug" = 'checkin_staff' AND EXISTS (SELECT 1 FROM "roles" WHERE "slug" = 'checkin-staff');

-- 2. Otherwise rename it in place (same id: assignments and grants are untouched).
UPDATE "roles" SET "slug" = 'checkin-staff', "updated_at" = CURRENT_TIMESTAMP WHERE "slug" = 'checkin_staff';

-- 3. A database that never had it gets it, as the first migration intended.
INSERT INTO "roles" ("slug", "name", "description", "is_system", "updated_at") VALUES
  ('checkin-staff', 'Check-in staff', 'Checks guests in at the door. Sees names and ticket codes only.', false, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "permissions" ("codename", "title", "description", "group_name") VALUES
  ('site:event:checkin', 'Check guests in', 'Scan or search tickets and mark guests as checked in.', 'Events')
ON CONFLICT ("codename") DO NOTHING;

-- 4. Grants: door staff check in; admins may too (the catalogue default, which the app's
--    permission sync only applies when IT inserts the codename, and the first migration already had).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM (VALUES ('checkin-staff', 'site:event:checkin'), ('admin', 'site:event:checkin')) AS g(slug, codename)
JOIN "roles" r ON r."slug" = g.slug
JOIN "permissions" p ON p."codename" = g.codename
ON CONFLICT DO NOTHING;

COMMIT;
