-- Remove the template job board: its table and its permission.
BEGIN;

DROP TABLE IF EXISTS "jobs";

DELETE FROM "role_permissions" WHERE permission_id IN (SELECT id FROM "permissions" WHERE codename = 'site:job:manage');
DELETE FROM "permissions" WHERE codename = 'site:job:manage';

COMMIT;
