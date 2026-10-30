import {Hono} from 'hono';
import {describe, expect, it} from 'vitest';

import {adminEventRoutes} from '../src/server/routes/admin-events';
import {eventSettingsRoutes} from '../src/server/routes/event-settings';

/** Deny by default: with the REAL guards, a visitor with no session reaches nothing. */
const app = new Hono().route('/admin-events', adminEventRoutes).route('/event-settings', eventSettingsRoutes);

describe('admin events need a signed-in user', () => {
  const ID = '0192f0a1-0000-7000-8000-000000000001';
  const calls: [string, string][] = [
    ['GET', '/admin-events'],
    ['POST', '/admin-events'],
    ['GET', `/admin-events/${ID}`],
    ['PATCH', `/admin-events/${ID}`],
    ['DELETE', `/admin-events/${ID}`],
    ['POST', `/admin-events/${ID}/publish`],
    ['POST', `/admin-events/${ID}/unpublish`],
    ['POST', `/admin-events/${ID}/cancel`],
    ['POST', `/admin-events/${ID}/duplicate`],
    ['GET', `/admin-events/${ID}/ticket-types`],
    ['POST', `/admin-events/${ID}/ticket-types`],
    ['DELETE', `/admin-events/${ID}/ticket-types/${ID}`],
    ['GET', '/event-settings'],
    ['PATCH', '/event-settings'],
  ];

  it.each(calls)('%s %s answers 401 to a visitor', async (method, path) => {
    const res = await app.request(path, {method, headers: {'content-type': 'application/json'}, body: method === 'GET' || method === 'DELETE' ? undefined : '{}'});
    expect(res.status).toBe(401);
  });
});
