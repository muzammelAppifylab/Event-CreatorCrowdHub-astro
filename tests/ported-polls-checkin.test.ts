import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({db: {} as Record<string, any>, manage: true}));

vi.mock('../src/platform/guards', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/guards')>('../src/platform/guards');
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    ...actual,
    withViewer: async (c: any, next: () => Promise<void>) => { c.set('viewer', {state: 'user', id: 7}); await next(); },
    requireAuth: pass,
    requirePermission: () => pass,
    can: vi.fn(async (_c: unknown, perm: string) => (String(perm).includes('manage') ? state.manage : true)),
    withDb: async (c: any, next: () => Promise<void>) => { c.set('db', state.db); await next(); },
  };
});
vi.mock('../src/server/webhook-emit', async () => {
  const actual = await vi.importActual<typeof import('../src/server/webhook-emit')>('../src/server/webhook-emit');
  return {...actual, emitWebhook: vi.fn()};
});

import {adminCheckinRoutes} from '../src/server/routes/admin-checkin';
import {emitWebhook} from '../src/server/webhook-emit';

const app = new Hono().route('/checkin', adminCheckinRoutes);
const call = (path: string, method = 'GET', body?: unknown) =>
  app.request(path, {method, headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
const EV = '0192f0a1-0000-7000-8000-000000000001';
const counts = {checkedInSeats: 1, expectedSeats: 2, checkedInGuests: 1, expectedGuests: 2};
const guest = {name: 'G', ticketCode: 'ABCD2345', seats: 1, status: 'confirmed', checkedInAt: new Date('2026-10-30T18:00:00Z')};

let rsvp: Record<string, any>;
beforeEach(() => {
  vi.clearAllMocks();
  state.manage = true;
  rsvp = {id: 'r1', eventId: EV, status: 'confirmed', response: 'going', checkedInAt: null, event: {status: 'published', deletedAt: null}};
  state.db = {
    event: {findFirst: vi.fn(async () => ({id: EV, title: 'T', startAt: new Date(), endAt: new Date(), timezone: 'UTC', format: 'in_person'})), findMany: vi.fn(async () => [])},
    rsvp: {
      findUnique: vi.fn(async () => rsvp),
      findUniqueOrThrow: vi.fn(async () => guest),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({count: 1})),
    },
    $queryRaw: vi.fn(async () => [counts]),
  };
});

describe('door check-in routes', () => {
  it('a malformed code looks like an unknown one', async () => {
    expect((await call('/checkin/codes/!!')).status).toBe(404);
    expect(state.db.rsvp.findUnique).not.toHaveBeenCalled();
  });
  it('check-in only admits confirmed+going (409 otherwise)', async () => {
    for (const patch of [{status: 'waitlisted'}, {status: 'pending'}, {response: 'maybe'}, {response: 'declined'}, {status: 'cancelled'}]) {
      Object.assign(rsvp, {status: 'confirmed', response: 'going'}, patch);
      expect((await call('/checkin/codes/abcd2345', 'POST', {checkedIn: true})).status).toBe(409);
    }
    expect(state.db.rsvp.updateMany).not.toHaveBeenCalled();
  });
  it('undo is allowed for any status', async () => {
    rsvp.status = 'cancelled';
    expect((await call('/checkin/codes/ABCD2345', 'POST', {checkedIn: false})).status).toBe(200);
    expect(state.db.rsvp.updateMany.mock.calls[0][0]).toMatchObject({data: {checkedInAt: null}});
  });
  it('unpublished or deleted events 404; bad toggle body 422', async () => {
    expect((await call('/checkin/codes/ABCD2345', 'POST', {checkedIn: 'yes'})).status).toBe(422);
    rsvp.event = {status: 'draft', deletedAt: null};
    expect((await call('/checkin/codes/ABCD2345', 'POST', {checkedIn: true})).status).toBe(404);
    expect((await call('/checkin/codes/ABCD2345')).status).toBe(404);
  });
  it('check-in writes conditionally, emits webhook only when it changed, never exposes email', async () => {
    const res = await call('/checkin/codes/ABCD2345', 'POST', {checkedIn: true});
    expect(res.status).toBe(200);
    expect(state.db.rsvp.updateMany.mock.calls[0][0].where).toMatchObject({id: 'r1', checkedInAt: null});
    expect(emitWebhook).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await res.json())).not.toContain('email');
    vi.mocked(emitWebhook).mockClear();
    state.db.rsvp.updateMany.mockResolvedValue({count: 0});
    await call('/checkin/codes/ABCD2345', 'POST', {checkedIn: true});
    expect(emitWebhook).not.toHaveBeenCalled();
  });
  it('door list scopes to going+confirmed (or checked in); email search is manager-only', async () => {
    state.manage = false;
    await call(`/checkin/events/${EV}?q=gin`);
    const first = state.db.rsvp.findMany.mock.calls[0][0];
    expect(first.take).toBe(200);
    expect(JSON.stringify(first.where)).toContain('"response":"going"');
    expect(JSON.stringify(first.where)).not.toContain('"email"');
    state.manage = true;
    await call(`/checkin/events/${EV}?q=gin`);
    expect(JSON.stringify(state.db.rsvp.findMany.mock.calls[1][0].where)).toContain('"email"');
  });
  it('event param must be a uuid and event must be published', async () => {
    expect((await call('/checkin/events/nope')).status).toBe(404);
    state.db.event.findFirst.mockResolvedValue(null);
    expect((await call(`/checkin/events/${EV}`)).status).toBe(404);
  });
  it('attendance validates ids and scopes writes to the event', async () => {
    expect((await call(`/checkin/events/${EV}/attendance`, 'POST', {rsvpIds: [], attended: true})).status).toBe(422);
    expect((await call(`/checkin/events/${EV}/attendance`, 'POST', {rsvpIds: ['x'], attended: true})).status).toBe(422);
    expect((await call(`/checkin/events/${EV}/attendance`, 'POST', {rsvpIds: [EV], attended: 1})).status).toBe(422);
    const res = await call(`/checkin/events/${EV}/attendance`, 'POST', {rsvpIds: [EV, EV.toUpperCase()], attended: true});
    expect(await res.json()).toEqual({updated: 1});
    expect(state.db.rsvp.updateMany.mock.calls[0][0].where).toMatchObject({eventId: EV, id: {in: [EV]}, status: 'confirmed'});
  });
  it('import matches by email and reports unmatched', async () => {
    expect((await call(`/checkin/events/${EV}/attendance/import`, 'POST', {emails: ['nope']})).status).toBe(422);
    state.db.rsvp.findMany.mockResolvedValue([{id: 'r1', email: 'a@x.com'}]);
    const res = await call(`/checkin/events/${EV}/attendance/import`, 'POST', {emails: [' A@x.com ', 'b@x.com', 5]});
    expect(await res.json()).toEqual({matched: 1, unmatched: ['b@x.com']});
  });
  it('attendees page keyset', async () => {
    const rows = Array.from({length: 51}, (_, i) => ({id: `id${i}`, name: 'n', email: 'e', seats: 1, attended: false, checkedInAt: null}));
    state.db.rsvp.findMany.mockResolvedValue(rows);
    const body = await (await call(`/checkin/events/${EV}/attendees`)).json();
    expect(body.attendees).toHaveLength(50);
    expect(body.nextBefore).toBe('id49');
  });
});
