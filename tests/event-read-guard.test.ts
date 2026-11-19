import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The read-only demo admin (`site:event:read` only) opens every events-admin screen and every
 * write refuses it. REAL guards; only the session (who, which codenames) is faked. No database:
 * a request that passes the permission guard reaches `withDb` and answers 503
 * `site_database_disabled`, one that does not answers 403 `forbidden`.
 */
const access = vi.hoisted(() => ({permissions: [] as string[]}));

vi.mock('../src/platform/auth/session', async orig => ({
  ...(await orig<typeof import('../src/platform/auth/session')>()),
  getViewer: async () => ({state: 'user', id: 7, name: 'Demo', email: 'demo@example.com', emailVerified: true}),
  getAccess: async () => ({roles: ['demo-read-only'], permissions: access.permissions}),
}));

import {requireAnyPermission} from '../src/server/guards-ext';
import {adminEventRoutes} from '../src/server/routes/admin-events';
import {adminRefundRoutes} from '../src/server/routes/admin-refunds';
import {adminWebhookRoutes} from '../src/server/routes/admin-webhooks';
import {eventSettingsRoutes} from '../src/server/routes/event-settings';
import {adminCheckinRoutes} from '../src/server/routes/admin-checkin';
import {adminGuestRoutes} from '../src/server/routes/admin-guests';
import {adminInviteRoutes} from '../src/server/routes/admin-invites';
import {adminMessageRoutes} from '../src/server/routes/admin-messages';
import {adminPollRoutes} from '../src/server/routes/admin-polls';
import {adminAnalyticsRoutes} from '../src/server/routes/admin-analytics';
import {adminOverviewRoutes} from '../src/server/routes/admin-overview';

const app = new Hono()
  .route('/admin-events', adminEventRoutes)
  .route('/refunds', adminRefundRoutes)
  .route('/webhook-endpoints', adminWebhookRoutes)
  .route('/event-settings', eventSettingsRoutes)
  .route('/checkin', adminCheckinRoutes)
  .route('/event-admin', adminGuestRoutes)
  .route('/event-admin', adminInviteRoutes)
  .route('/event-admin', adminMessageRoutes)
  .route('/polls', adminPollRoutes)
  .route('/analytics', adminAnalyticsRoutes)
  .route('/overview', adminOverviewRoutes);

const ID = '0192f0a1-0000-7000-8000-000000000001';
const call = (method: string, path: string) =>
  app.request(path, {method, headers: {'content-type': 'application/json'}, body: method === 'GET' || method === 'DELETE' ? undefined : '{}'});

beforeEach(() => {
  access.permissions = ['site:user:read', 'site:role:read', 'site:audit:read', 'site:event:read'];
});

describe('requireAnyPermission', () => {
  const probe = new Hono().get('/', requireAnyPermission('site:event:read', 'site:event:manage'), c => c.text('in'));

  it('lets in a holder of any one codename (wildcards too) and refuses the rest with the standard 403', async () => {
    expect((await probe.request('/')).status).toBe(200);
    access.permissions = ['site:event:*'];
    expect((await probe.request('/')).status).toBe(200);
    access.permissions = ['site:event:checkin'];
    const refused = await probe.request('/');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({error: 'forbidden', message: 'You do not have access to this.'});
  });
});

describe('the see-only events admin', () => {
  it.each([
    ['GET', '/admin-events'],
    ['GET', `/admin-events/${ID}`],
    ['GET', `/admin-events/${ID}/ticket-types`],
    ['GET', '/refunds'],
    ['GET', '/refunds/count'],
    ['GET', '/event-settings'],
    ['GET', '/webhook-endpoints'],
    ['GET', '/checkin/events'],
    ['GET', `/checkin/events/${ID}/attendees`],
    ['GET', `/event-admin/contacts/detail?key=${ID}`],
    ['GET', '/event-admin/contacts'],
    ['GET', `/event-admin/events/${ID}/guests`],
    ['GET', `/event-admin/events/${ID}/guests/${ID}`],
    ['GET', `/event-admin/events/${ID}/invites`],
    ['GET', `/event-admin/events/${ID}/invites/resend-preview`],
    ['GET', `/event-admin/events/${ID}/share-kit`],
    ['GET', `/event-admin/events/${ID}/messages`],
    ['GET', `/event-admin/events/${ID}/messages/rules`],
    ['GET', `/polls/event/${ID}`],
    ['GET', `/polls/${ID}/results`],
    ['GET', `/analytics/events/${ID}`],
    ['GET', '/overview'],
    ['GET', '/event-settings/payments'],
  ])('passes the guard on %s %s', async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({error: 'site_database_disabled'});
  });

  it.each([
    ['POST', '/admin-events'],
    ['PATCH', `/admin-events/${ID}`],
    ['DELETE', `/admin-events/${ID}`],
    ['POST', `/admin-events/${ID}/cancel`],
    ['POST', `/admin-events/${ID}/ticket-types`],
    ['POST', `/refunds/${ID}/mark-refunded`],
    ['PATCH', '/event-settings'],
    ['POST', '/webhook-endpoints'],
    ['POST', '/checkin/codes/ABCDEFGH'],
    ['PATCH', `/event-admin/events/${ID}/guests/${ID}`],
    ['DELETE', `/event-admin/events/${ID}/guests/${ID}`],
    ['POST', `/event-admin/events/${ID}/guests/bulk`],
    ['POST', `/event-admin/events/${ID}/invites`],
    ['DELETE', `/event-admin/events/${ID}/invites/${ID}`],
    ['POST', `/event-admin/events/${ID}/messages/broadcast`],
    ['DELETE', `/event-admin/events/${ID}/messages/rules/${ID}`],
    ['POST', `/polls/event/${ID}`],
    ['DELETE', `/polls/${ID}`],
    ['POST', '/event-settings/logo'],
    ['POST', '/event-settings/logo/complete'],
    ['DELETE', '/event-settings/logo'],
    // Personal-data exports stay manage-only: the demo sees the lists but never downloads them.
    ['GET', `/event-admin/events/${ID}/guests/export.csv`],
    ['GET', `/event-admin/events/${ID}/guests/${ID}/data`],
    ['GET', '/event-admin/contacts/export.csv'],
    ['GET', `/polls/${ID}/results.csv`],
  ])('is refused on %s %s', async (method, path) => {
    const res = await call(method, path);
    // A validator may refuse a malformed body first (422); it must never get through (503) or succeed.
    expect([403, 422]).toContain(res.status);
  });

  it('a manager still writes (passes the guard to the database)', async () => {
    access.permissions = ['site:event:manage'];
    expect((await call('POST', `/refunds/${ID}/mark-refunded`)).status).toBe(503);
    expect((await call('DELETE', `/admin-events/${ID}`)).status).toBe(503);
  });
});
