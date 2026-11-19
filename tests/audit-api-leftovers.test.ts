import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/** Audit follow-ups L-5 (door window), L-8 (pageview beacon), L-10 (unlisted cache), L-14 (webhook URL guard). */

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
vi.mock('../src/platform/config', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/config')>('../src/platform/config');
  return {...actual, config: new Proxy(actual.config, {get: (t, k) => (k === 'jwtSecret' ? 'test-secret' : Reflect.get(t, k))})};
});
vi.mock('../src/server/webhook-emit', async () => {
  const actual = await vi.importActual<typeof import('../src/server/webhook-emit')>('../src/server/webhook-emit');
  return {...actual, emitWebhook: vi.fn()};
});

import {adminCheckinRoutes, DOOR_WINDOW_MS, inDoorWindow} from '../src/server/routes/admin-checkin';
import {eventRoutes} from '../src/server/routes/events';
import {dailySalt, pageViewRoutes, resetSaltMemo, SALT_KEEP_DAYS, visitorHash} from '../src/server/routes/pageviews';
import {attemptDelivery, webhookUrlProblem} from '../src/server/webhook-delivery';

const app = new Hono().route('/checkin', adminCheckinRoutes).route('/pageviews', pageViewRoutes).route('/events', eventRoutes);
const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {method, headers: {'content-type': 'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});

const EV = '0192f0a1-0000-7000-8000-000000000001';
const longAgo = () => new Date(Date.now() - 3 * 24 * 3_600_000);
const event = (endAt: Date) => ({id: EV, title: 'T', startAt: new Date(endAt.getTime() - 3_600_000), endAt, timezone: 'UTC', format: 'in_person', status: 'published', deletedAt: null});
let rsvp: Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  state.manage = false;
  rsvp = {id: 'r1', eventId: EV, name: 'G', ticketCode: 'ABCD2345', seats: 1, status: 'confirmed', response: 'going', checkedInAt: null, event: event(longAgo())};
  state.db = {
    event: {findFirst: vi.fn(async () => null), findMany: vi.fn(async () => [])},
    rsvp: {
      findUnique: vi.fn(async () => rsvp),
      findUniqueOrThrow: vi.fn(async () => rsvp),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({count: 1})),
    },
    pageView: {createMany: vi.fn(async () => ({count: 1}))},
    $queryRaw: vi.fn(async () => [{checkedInSeats: 0, expectedSeats: 1, checkedInGuests: 0, expectedGuests: 1}]),
  };
});

describe('L-5: door ticket codes only inside the door window', () => {
  it('inDoorWindow matches the picker (ended within a day, or later)', () => {
    const now = Date.now();
    expect(inDoorWindow(new Date(now - DOOR_WINDOW_MS + 1000), now)).toBe(true);
    expect(inDoorWindow(new Date(now + 3_600_000), now)).toBe(true);
    expect(inDoorWindow(new Date(now - DOOR_WINDOW_MS - 1000), now)).toBe(false);
  });

  it('door staff get 404 for a code of a past event, on lookup and on check-in', async () => {
    expect((await call('/checkin/codes/ABCD2345')).status).toBe(404);
    expect((await call('/checkin/codes/ABCD2345', 'POST', {checkedIn: true})).status).toBe(404);
    expect(state.db.rsvp.updateMany).not.toHaveBeenCalled();
  });

  it('door staff can use a code of an event inside the window', async () => {
    rsvp.event = event(new Date(Date.now() + 3_600_000));
    expect((await call('/checkin/codes/ABCD2345')).status).toBe(200);
    expect((await call('/checkin/codes/ABCD2345', 'POST', {checkedIn: true})).status).toBe(200);
  });

  it('managers may still fix a past event', async () => {
    state.manage = true;
    expect((await call('/checkin/codes/ABCD2345')).status).toBe(200);
    expect((await call('/checkin/codes/ABCD2345', 'POST', {checkedIn: false})).status).toBe(200);
  });

  it('the door list asks for the window for staff, not for managers', async () => {
    await call(`/checkin/events/${EV}`);
    expect(state.db.event.findFirst.mock.calls[0][0].where.endAt).toBeDefined();
    state.manage = true;
    await call(`/checkin/events/${EV}`);
    expect(state.db.event.findFirst.mock.calls[1][0].where.endAt).toBeUndefined();
  });
});

describe('L-8: the pageview beacon reveals nothing and counts only visible events', () => {
  const beacon = (slug: string, ip: string) => call(`/pageviews/${slug}`, 'POST', {}, {'cf-connecting-ip': ip});

  it('answers 204 for unknown, malformed and hidden slugs, without counting', async () => {
    for (const [i, slug] of ['nope', 'BAD_slug!', 'private-one'].entries()) {
      const res = await beacon(slug, `10.0.0.${i + 1}`);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
    }
    expect(state.db.pageView.createMany).not.toHaveBeenCalled();
  });

  it('only looks up published, public or unlisted events', async () => {
    await beacon('some-event', '10.0.1.1');
    expect(state.db.event.findFirst.mock.calls[0][0].where).toMatchObject({slug: 'some-event', deletedAt: null, status: 'published', visibility: {in: ['public', 'unlisted']}});
  });

  it('counts a visible event with the same 204', async () => {
    state.db.event.findFirst.mockResolvedValue({id: EV});
    state.db.$queryRaw.mockResolvedValue([{salt: 'c'.repeat(64), inserted: false}]);
    const res = await beacon('some-event', '10.0.2.1');
    expect(res.status).toBe(204);
    expect(state.db.pageView.createMany).toHaveBeenCalledTimes(1);
    expect(state.db.pageView.createMany.mock.calls[0][0].data[0].visitorHash).toBe(
      await visitorHash({salt: 'c'.repeat(64), ip: '10.0.2.1', userAgent: '', eventId: EV}),
    );
  });
});

describe('L-43: a random salt per UTC day, kept in the database', () => {
  const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');
  beforeEach(() => resetSaltMemo());

  it('creates the day row with ON CONFLICT DO NOTHING and deletes salts older than 2 days', async () => {
    state.db.$queryRaw.mockResolvedValue([{salt: 'd'.repeat(64), inserted: true}]);
    state.db.$executeRaw = vi.fn(async () => 1);
    expect(await dailySalt(state.db as never, '2026-11-13')).toBe('d'.repeat(64));
    const [call] = state.db.$queryRaw.mock.calls;
    expect(sqlOf(call)).toMatch(/insert into page_view_salts[\s\S]*on conflict \(day\) do nothing/);
    expect(call[2]).toMatch(/^[0-9a-f]{64}$/); // a fresh random salt, not derived from anything
    expect(sqlOf(state.db.$executeRaw.mock.calls[0])).toMatch(/delete from page_view_salts where day < \?::date - \?::int/);
    expect(state.db.$executeRaw.mock.calls[0].slice(1)).toEqual(['2026-11-13', SALT_KEEP_DAYS]);
    // Memoized per isolate for the day: no second query.
    await dailySalt(state.db as never, '2026-11-13');
    expect(state.db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing row without deleting, and reads again after losing a race', async () => {
    state.db.$executeRaw = vi.fn(async () => 0);
    state.db.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{salt: 'e'.repeat(64), inserted: false}]);
    expect(await dailySalt(state.db as never, '2026-11-14')).toBe('e'.repeat(64));
    expect(state.db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(state.db.$executeRaw).not.toHaveBeenCalled();
  });

  it('each new day reads its own salt', async () => {
    state.db.$executeRaw = vi.fn(async () => 0);
    state.db.$queryRaw.mockResolvedValueOnce([{salt: '1'.repeat(64), inserted: true}]).mockResolvedValueOnce([{salt: '2'.repeat(64), inserted: true}]);
    expect(await dailySalt(state.db as never, '2026-11-15')).not.toBe(await dailySalt(state.db as never, '2026-11-16'));
  });
});

describe('L-10: an unlisted event is never kept by a shared cache', () => {
  const row = (visibility: string) => ({
    id: EV, slug: 's', title: 'T', startAt: new Date(), endAt: new Date(), visibility, status: 'published',
  });
  it('sends private, no-store for unlisted', async () => {
    state.db.event.findFirst.mockResolvedValue(row('unlisted'));
    const res = await call('/events/s');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });
});

describe('L-14: webhook URL guard', () => {
  it.each([
    'https://0177.0.0.1/',
    'https://0x7f000001/',
    'https://017700000001/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/',
    'https://[fe80::1%25eth0]/',
    'https://[::]/',
    'https://0/',
    'https://localhost./',
    'https://localhost.localdomain/',
    'https://ip6-localhost/',
    'https://api.localhost/',
    'https://metadata.google.internal/',
    'https://127.0.0.1.nip.io/',
    'https://10-0-0-1.sslip.io/',
    'https://app.lvh.me/',
    'https://localtest.me/',
    'https://127.0.0.1.attacker.example.com/',
    'https://a.svc/',
    'https://x.onion/',
    'https://-bad.example.com/',
  ])('refuses %s', url => {
    expect(webhookUrlProblem(url)).not.toBeNull();
  });

  it.each(['https://hooks.zapier.com/hooks/catch/1/abc/', 'https://hook.eu1.make.com/x', 'https://xn--bcher-kva.example.com.au/x', 'https://api.example.co.uk/hook', 'https://hooks.slack.com./x'])('accepts %s', url => {
    expect(webhookUrlProblem(url)).toBeNull();
  });

  it('never follows a redirect, and says so', async () => {
    const fetch = vi.fn(async () => new Response(null, {status: 307, headers: {location: 'https://169.254.169.254/'}}));
    const r = await attemptDelivery({url: 'https://hooks.example.com/x', secret: 's'}, 'e', 'd', '{}', {fetch});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
    expect(r).toMatchObject({ok: false, status: 307, retryable: false});
    expect(r.error).toMatch(/redirect/);
  });
});
