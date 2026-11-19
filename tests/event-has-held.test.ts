import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The dashboard offers Unpublish / Delete only when the server will accept them: the event payload's
 * `hasHeld` is the server's own rule (held or awaiting-payment guests, or a paid order), read in the
 * same query as the guest counts. Guards stubbed, a fake database (real Postgres: tests/integration).
 */
const state = vi.hoisted(() => ({db: {} as Record<string, unknown>}));

vi.mock('../src/platform/guards', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/guards')>('../src/platform/guards');
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    ...actual,
    withViewer: async (c: {set: (k: string, v: unknown) => void}, next: () => Promise<void>) => {
      c.set('viewer', {state: 'user', id: 7});
      await next();
    },
    requireAuth: pass,
    requirePermission: () => pass,
    withDb: async (c: {set: (k: string, v: unknown) => void}, next: () => Promise<void>) => {
      c.set('db', state.db);
      await next();
    },
  };
});
vi.mock('../src/platform/auth', () => ({audit: vi.fn(async () => undefined)}));

import {canCancel, canDelete, canUnpublish, hasGuests} from '../src/portal/screens/event-hub-actions';
import {adminEventRoutes} from '../src/server/routes/admin-events';

const app = new Hono().route('/admin-events', adminEventRoutes);
const ID = '0192f0a1-0000-7000-8000-000000000001';
const row = {
  id: ID, slug: 'launch', title: 'Launch', description: '', coverImageUrl: null, coverPoster: null, coverStyle: null,
  startAt: new Date('2030-11-20T18:00:00Z'), endAt: new Date('2030-11-20T20:00:00Z'), timezone: 'UTC', format: 'in_person',
  venueName: 'Hall', venueAddress: 'Street', mapUrl: null, joinUrl: null, visibility: 'public', status: 'draft', capacity: null,
  rsvpDeadline: null, waitlistEnabled: true, approvalRequired: false, allowMaybe: true, maxPlusOnes: 0, showGuestList: false,
  pollJoinCode: 'ABCDEF', thankYouLink: null, createdAt: new Date('2030-10-01T00:00:00Z'), updatedAt: new Date('2030-10-02T00:00:00Z'),
};

let queryRaw: ReturnType<typeof vi.fn>;
beforeEach(() => {
  queryRaw = vi.fn(async () => [{eventId: ID, confirmed: 0, waitlisted: 0, pending: 0, hasHeld: true}]);
  state.db = {
    event: {findFirst: vi.fn(async () => row), findMany: vi.fn(async () => [row])},
    rsvpQuestion: {findMany: vi.fn(async () => [])},
    rsvp: {groupBy: vi.fn(async () => [])},
    $queryRaw: queryRaw,
  };
});

describe('event payload: hasHeld', () => {
  it('a draft with only an awaiting-payment guest or a paid order reads hasHeld, zero counts', async () => {
    const res = await app.request(`/admin-events/${ID}`);
    expect(res.status).toBe(200);
    const {event} = await res.json();
    expect(event.counts).toEqual({confirmed: 0, waitlisted: 0, pending: 0});
    expect(event.hasHeld).toBe(true);
    // One statement for counts and the rule: the same probes as the server's 409 check.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = (queryRaw.mock.calls[0]![0] as string[]).join('?');
    expect(sql).toContain("'awaiting_payment'");
    expect(sql).toContain("o.status = 'paid'");
  });

  it('lists a page with counts and hasHeld from one query', async () => {
    queryRaw.mockResolvedValueOnce([{eventId: ID, confirmed: 3, waitlisted: 1, pending: 0, hasHeld: true}]);
    const res = await app.request('/admin-events?tab=drafts');
    const {events} = await res.json();
    expect(events[0]).toMatchObject({counts: {confirmed: 3, waitlisted: 1, pending: 0}, hasHeld: true});
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('defaults to no guests when the event has none', async () => {
    queryRaw.mockResolvedValueOnce([{eventId: ID, confirmed: 0, waitlisted: 0, pending: 0, hasHeld: false}]);
    const {event} = await (await app.request(`/admin-events/${ID}`)).json();
    expect(event.hasHeld).toBe(false);
  });
});

describe('dashboard lifecycle actions follow the server rule', () => {
  const none = {confirmed: 0, waitlisted: 0, pending: 0};
  it('hides Delete and offers Cancel for a draft the server would refuse to delete', () => {
    const draft = {status: 'draft' as const, counts: none, hasHeld: true};
    expect(hasGuests(draft)).toBe(true);
    expect(canDelete(draft)).toBe(false);
    expect(canCancel(draft)).toBe(true);
  });
  it('offers Delete for an empty draft', () => {
    const draft = {status: 'draft' as const, counts: none, hasHeld: false};
    expect(canDelete(draft)).toBe(true);
    expect(canCancel(draft)).toBe(false);
  });
  it('offers Unpublish only for a published event nobody holds a place in', () => {
    expect(canUnpublish({status: 'published', counts: none, hasHeld: false})).toBe(true);
    expect(canUnpublish({status: 'published', counts: none, hasHeld: true})).toBe(false);
    expect(canCancel({status: 'published', counts: none, hasHeld: false})).toBe(true);
  });
  it('falls back to the counts when the payload has no hasHeld', () => {
    expect(hasGuests({counts: {confirmed: 1, waitlisted: 0, pending: 0}})).toBe(true);
    expect(hasGuests({counts: none})).toBe(false);
    expect(hasGuests({})).toBe(false);
  });
});
