import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';

import {authRoutes} from '../../../src/platform/auth';
import {csrf, previewCookies, sameOrigin} from '../../../src/platform/guards';
import {syncPermissions} from '../../../src/platform/permission-sync';
import {authSettings} from '../../../src/server/auth-settings';
import {CATALOGUE} from '../../../src/server/permissions';
import {adminCheckinRoutes} from '../../../src/server/routes/admin-checkin';
import {adminEventRoutes} from '../../../src/server/routes/admin-events';
import {adminPollRoutes} from '../../../src/server/routes/admin-polls';
import {adminWebhookRoutes} from '../../../src/server/routes/admin-webhooks';
import {eventRoutes} from '../../../src/server/routes/events';
import {pollPublicRoutes} from '../../../src/server/routes/polls-public';
import {privacyRoutes} from '../../../src/server/routes/privacy';
import {rsvpRoutes} from '../../../src/server/routes/rsvp';
import {Browser, db, emails, signedIn, userId} from './harness';

/**
 * The event routers on a local app with the same middleware chain as `src/server/app.ts`
 * (previewCookies, sameOrigin, csrf, body limit, permission sync), so these tests do not depend
 * on how the integrator mounts them. Paths are this fixture's own.
 */
export const eventsApp = new Hono()
  .basePath('/site-api')
  .use(previewCookies)
  .use(sameOrigin)
  .use(csrf)
  .use(bodyLimit({maxSize: 64 * 1024}))
  .use(syncPermissions(CATALOGUE))
  .route('/auth', authRoutes(authSettings))
  .route('/events', eventRoutes)
  .route('/admin-events', adminEventRoutes)
  .route('/checkin', adminCheckinRoutes)
  .route('/admin-polls', adminPollRoutes)
  .route('/webhook-endpoints', adminWebhookRoutes)
  .route('/rsvp', rsvpRoutes)
  .route('/polls-public', pollPublicRoutes)
  .route('/privacy', privacyRoutes);

export async function resetEvents() {
  await db.$executeRawUnsafe('TRUNCATE "events", "webhook_endpoints", "event_settings", "guest_email_outbox", "rate_attempts" RESTART IDENTITY CASCADE');
  emails.length = 0;
}

/** Exactly these roles for the user, whatever sign-up gave. Use `ownerSignedIn` for the site owner: an `owner` role row alone is not the owner. */
export async function setRoles(email: string, ...slugs: string[]) {
  // resetDatabase() deletes non-system roles, including the migration-seeded checkin-staff.
  await db.$executeRawUnsafe(
    `INSERT INTO "roles" ("slug", "name", "description", "is_system", "updated_at") VALUES ('checkin-staff', 'Check-in staff', 'Door staff', false, CURRENT_TIMESTAMP) ON CONFLICT ("slug") DO NOTHING`
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "role_permissions" ("role_id", "permission_id") SELECT r."id", p."id" FROM "roles" r, "permissions" p WHERE r."slug" = 'checkin-staff' AND p."codename" = 'site:event:checkin' ON CONFLICT DO NOTHING`
  );
  const id = await userId(email);
  const roles = await db.role.findMany({where: {slug: {in: slugs}}, select: {id: true}});
  if (roles.length !== slugs.length) throw new Error(`missing roles ${slugs}`);
  await db.userRole.deleteMany({where: {userId: id}});
  await db.userRole.createMany({data: roles.map(role => ({userId: id, roleId: role.id}))});
}

/** A signed-in browser holding exactly `roles`. */
export async function userWith(email: string, roles: string[], ip: string) {
  const b = await signedIn(eventsApp, email, undefined, ip);
  await setRoles(email, ...roles);
  return b;
}

const day = 24 * 3600 * 1000;
export const inDays = (n: number) => new Date(Date.now() + n * day).toISOString();

export const eventBody = (over: Record<string, unknown> = {}) => ({
  title: 'Launch party',
  startAt: inDays(10),
  endAt: inDays(10.1),
  timezone: 'UTC',
  format: 'in_person',
  venueName: 'The Hall',
  venueAddress: '1 Main St',
  ...over,
});


export async function createEvent(admin: Browser, over: Record<string, unknown> = {}, publish = true) {
  const res = await admin.post('/site-api/admin-events', eventBody(over));
  if (res.status !== 201) throw new Error(`create event ${res.status} ${JSON.stringify(res.json)}`);
  const event = res.json.event as {id: string; slug: string};
  if (publish) {
    const pub = await admin.post(`/site-api/admin-events/${event.id}/publish`);
    if (pub.status !== 200) throw new Error(`publish ${pub.status} ${JSON.stringify(pub.json)}`);
  }
  return event;
}

export const rsvpBody = (email: string, over: Record<string, unknown> = {}) => ({name: email.split('@')[0], email, response: 'going', ...over});
