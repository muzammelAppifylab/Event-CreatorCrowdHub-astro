import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The admin events and settings routes driven with the guards stubbed (the
 * permission and auth checks have their own tests) and a recording fake
 * database: what the validators refuse, and exactly which columns reach the
 * database. A real-Postgres run belongs in tests/integration.
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

import {audit} from '../src/platform/auth';
import {adminEventRoutes} from '../src/server/routes/admin-events';
import {eventSettingsRoutes} from '../src/server/routes/event-settings';

const app = new Hono().route('/admin-events', adminEventRoutes).route('/event-settings', eventSettingsRoutes);
const json = (path: string, method: string, body?: unknown) =>
  app.request(path, {method, headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});

const ID = '0192f0a1-0000-7000-8000-000000000001';
const TICKET = '0192f0a1-0000-7000-8000-000000000002';
const row = (patch: Record<string, unknown> = {}) => ({
  id: ID, slug: 'launch', title: 'Launch', description: '', coverImageUrl: null, coverPoster: null, coverStyle: null,
  startAt: new Date('2026-11-20T18:00:00Z'), endAt: new Date('2026-11-20T20:00:00Z'), timezone: 'UTC', format: 'in_person',
  venueName: 'Hall', venueAddress: 'Street', mapUrl: null, joinUrl: null, visibility: 'public', status: 'draft', capacity: null,
  rsvpDeadline: null, waitlistEnabled: true, approvalRequired: false, allowMaybe: true, maxPlusOnes: 0, showGuestList: false,
  pollJoinCode: 'ABCDEF', thankYouLink: null, createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-02T00:00:00Z'),
  ...patch,
});

const body = {title: 'Launch', startAt: '2026-11-20T18:00:00Z', endAt: '2026-11-20T20:00:00Z', timezone: 'UTC', format: 'in_person', venueName: 'Hall', venueAddress: 'Street'};

let calls: {event: Record<string, unknown>[]; ticket: Record<string, unknown>[]; settings: Record<string, unknown>[]};
let stored: ReturnType<typeof row> | null;

beforeEach(() => {
  calls = {event: [], ticket: [], settings: []};
  stored = row();
  state.db = {
    event: {
      findFirst: vi.fn(async () => stored),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        calls.event.push(args);
        return [];
      }),
      create: vi.fn(async (args: {data: Record<string, unknown>}) => {
        calls.event.push(args.data);
        return {id: args.data.id};
      }),
      update: vi.fn(async (args: {data: Record<string, unknown>}) => {
        calls.event.push(args.data);
        return {id: ID};
      }),
      updateMany: vi.fn(async (args: {data: Record<string, unknown>}) => {
        calls.event.push(args.data);
        return {count: 1};
      }),
    },
    ticketOrder: {updateMany: vi.fn(async (args: Record<string, unknown>) => { calls.event.push({orders: args}); return {count: 2}; })},
    eventSettings: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (args: {update: Record<string, unknown>}) => {
        calls.settings.push(args.update);
        return {brandColor: '#aabbcc', fontPreset: 'inter', defaultTimezone: 'UTC', senderName: 'Me', replyToEmail: 'a@b.co', defaultReminderRules: [], allowMaybeDefault: true, showGuestListDefault: false, defaultCoverPoster: null, updatedAt: new Date('2026-10-03T00:00:00Z')};
      }),
    },
    reminderRule: {findMany: vi.fn(async () => [])},
    poll: {
      findMany: vi.fn(async () => [
        {question: 'Best slot?', type: 'single', anonymous: true, showResultsToVoters: true, sortOrder: 0, pollOptions: [{label: 'Morning', sortOrder: 0}, {label: 'Evening', sortOrder: 1}]},
      ]),
    },
    rsvpQuestion: {findMany: vi.fn(async () => []), deleteMany: vi.fn(), updateMany: vi.fn(), create: vi.fn()},
    rsvp: {groupBy: vi.fn(async () => []), count: vi.fn(async () => 0), findFirst: vi.fn(async () => null)},
    ticketType: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({id: TICKET, eventId: ID, name: 'GA', priceCents: 0, currency: 'USD', quantity: null, salesEndAt: null})),
      create: vi.fn(async (args: {data: Record<string, unknown>}) => {
        calls.ticket.push(args.data);
        return {...args.data, salesEndAt: null};
      }),
      aggregate: vi.fn(async () => ({_max: {sortOrder: 4}})),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    // An interactive transaction runs its callback on the same fake; a batch resolves to [].
    $transaction: vi.fn(async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(state.db) : [])),
    // lockEvent ignores the rows; the H-1 probe reads {held, paid}.
    $queryRaw: vi.fn(async () => [{held: false, paid: false}]),
  };
});

describe('GET /admin-events', () => {
  it('refuses an unknown tab', async () => {
    const res = await json('/admin-events?tab=everything', 'GET');
    expect(res.status).toBe(422);
    expect((await res.json()).fields.tab).toBeTruthy();
  });

  it('lists a tab, never soft-deleted rows, with a keyset page', async () => {
    const res = await json('/admin-events?tab=drafts', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({events: [], nextBefore: null});
    const where = JSON.stringify(calls.event[0]!.where);
    expect(where).toContain('"deletedAt":null');
    expect(where).toContain('"status":"draft"');
    expect(calls.event[0]!.take).toBe(21);
  });
});

describe('POST /admin-events', () => {
  it('answers 422 with the fields', async () => {
    const res = await json('/admin-events', 'POST', {title: '', format: 'online'});
    expect(res.status).toBe(422);
    const out = await res.json();
    expect(out.error).toBe('invalid_input');
    expect(Object.keys(out.fields)).toEqual(expect.arrayContaining(['title', 'startAt', 'endAt']));
  });

  it('applies the cross-field rules (online needs a join link)', async () => {
    const res = await json('/admin-events', 'POST', {...body, format: 'online'});
    expect(res.status).toBe(422);
    expect((await res.json()).fields.joinUrl).toBeTruthy();
  });

  it('creates a draft with a generated slug and ignores smuggled columns', async () => {
    stored = null; // slug free
    const res = await json('/admin-events', 'POST', {...body, status: 'published', deletedAt: '2020-01-01T00:00:00Z', pollJoinCode: 'ZZZZZZ', id: 'x'});
    expect(res.status).toBe(201);
    const data = calls.event[0]!;
    expect(data.status).toBe('draft');
    expect(data.slug).toBe('launch');
    expect(data.pollJoinCode).not.toBe('ZZZZZZ');
    expect(data.deletedAt).toBeUndefined();
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers 422 when the chosen link is taken', async () => {
    const res = await json('/admin-events', 'POST', {...body, slug: 'launch'});
    expect(res.status).toBe(422);
    expect((await res.json()).fields.slug).toMatch(/already uses/);
  });
});

describe('/:id', () => {
  it('404s a malformed id without touching the database', async () => {
    const res = await json('/admin-events/not-a-uuid', 'GET');
    expect(res.status).toBe(404);
    expect((state.db.event as {findFirst: ReturnType<typeof vi.fn>}).findFirst).not.toHaveBeenCalled();
  });

  it('PATCH validates only what was sent and merges onto the stored event', async () => {
    const bad = await json(`/admin-events/${ID}`, 'PATCH', {endAt: '2026-11-20T17:00:00Z'});
    expect(bad.status).toBe(422);
    expect((await bad.json()).fields.endAt).toBeTruthy();
    const ok = await json(`/admin-events/${ID}`, 'PATCH', {title: 'Renamed', status: 'cancelled'});
    expect(ok.status).toBe(200);
    expect(calls.event.at(-1)).toMatchObject({title: 'Renamed', venueName: 'Hall'});
    expect(calls.event.at(-1)).not.toHaveProperty('status');
  });

  it('only drafts can be deleted', async () => {
    stored = row({status: 'published'});
    expect((await json(`/admin-events/${ID}`, 'DELETE')).status).toBe(409);
    stored = row();
    expect((await json(`/admin-events/${ID}`, 'DELETE')).status).toBe(200);
    expect(calls.event.at(-1)!.deletedAt).toBeInstanceOf(Date);
  });

  it('refuses unpublish and delete while guests hold places or orders are paid (H-1)', async () => {
    vi.mocked(audit).mockClear();
    const probe = state.db.$queryRaw as ReturnType<typeof vi.fn>;
    stored = row({status: 'published'});
    probe.mockResolvedValue([{held: true, paid: false}]);
    const unpublish = await json(`/admin-events/${ID}/unpublish`, 'POST');
    expect(unpublish.status).toBe(409);
    expect(await unpublish.json()).toMatchObject({error: 'event_has_guests'});
    stored = row();
    probe.mockResolvedValue([{held: false, paid: true}]);
    expect((await json(`/admin-events/${ID}`, 'DELETE')).status).toBe(409);
    expect(calls.event.some(c => 'deletedAt' in c || c.status === 'draft')).toBe(false);
    expect(audit).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({action: 'event_deleted'}));
  });

  it('will not publish an event that already ended, or reopen a cancelled one', async () => {
    stored = row({endAt: new Date('2020-01-01T00:00:00Z'), startAt: new Date('2019-12-31T00:00:00Z')});
    expect((await json(`/admin-events/${ID}/publish`, 'POST')).status).toBe(409);
    stored = row({status: 'cancelled'});
    expect((await json(`/admin-events/${ID}/publish`, 'POST')).status).toBe(409);
    expect((await json(`/admin-events/${ID}/unpublish`, 'POST')).status).toBe(409);
  });

  it('cancel marks paid orders refund_due and audits the count', async () => {
    stored = row({status: 'published'});
    const res = await json(`/admin-events/${ID}/cancel`, 'POST');
    expect(res.status).toBe(200);
    expect(calls.event).toContainEqual({orders: {where: {status: 'paid', rsvp: {eventId: ID}}, data: {status: 'refund_due'}}});
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({action: 'event_cancelled', meta: {refundDue: 2}}));
  });

  it('refuses http: and javascript: links', async () => {
    for (const field of ['coverImageUrl', 'mapUrl', 'thankYouLink']) {
      for (const bad of ['http://example.com/a', 'javascript:alert(1)', 'data:text/html,x']) {
        const res = await json(`/admin-events/${ID}`, 'PATCH', {[field]: bad});
        expect(res.status, `${field} ${bad}`).toBe(422);
      }
    }
  });

  it('duplicate needs valid new dates', async () => {
    const res = await json(`/admin-events/${ID}/duplicate`, 'POST', {startAt: '2026-12-01T10:00:00Z', endAt: '2026-12-01T09:00:00Z'});
    expect(res.status).toBe(422);
    expect((await res.json()).fields.endAt).toBeTruthy();
  });
});

describe('duplicate copies polls', () => {
  it('creates the polls as drafts with their options', async () => {
    // First lookup is the source event; every slug probe after it is free.
    const find = (state.db.event as {findFirst: ReturnType<typeof vi.fn>}).findFirst;
    find.mockResolvedValueOnce(stored).mockResolvedValue(null);
    const res = await json(`/admin-events/${ID}/duplicate`, 'POST', {startAt: '2026-12-01T10:00:00Z', endAt: '2026-12-01T12:00:00Z'});
    expect(res.status).toBe(201);
    const data = calls.event.find(d => 'polls' in d) as {polls: {create: {status: string; question: string; pollOptions: {create: {label: string}[]}}[]}};
    expect(data.polls.create).toHaveLength(1);
    expect(data.polls.create[0]!.status).toBe('draft');
    expect(data.polls.create[0]!.pollOptions.create.map(o => o.label)).toEqual(['Morning', 'Evening']);
  });
});

describe('ticket types', () => {
  it('validates the ticket and its price against the event', async () => {
    const bad = await json(`/admin-events/${ID}/ticket-types`, 'POST', {name: '', priceCents: -1});
    expect(bad.status).toBe(422);
    const cheap = await json(`/admin-events/${ID}/ticket-types`, 'POST', {name: 'Paid', priceCents: 10, currency: 'USD'});
    expect(cheap.status).toBe(422);
    expect((await cheap.json()).fields.priceCents).toBeTruthy();
  });

  it('creates a ticket scoped to the event, column by column', async () => {
    const res = await json(`/admin-events/${ID}/ticket-types`, 'POST', {name: 'GA', priceCents: 0, eventId: 'other', id: 'x'});
    expect(res.status).toBe(201);
    expect(calls.ticket[0]).toMatchObject({eventId: ID, name: 'GA', priceCents: 0, currency: 'USD', sortOrder: 5});
    expect(calls.ticket[0]!.id).not.toBe('x');
  });

  it('refuses to delete a ticket guests already chose', async () => {
    (state.db.rsvp as {findFirst: ReturnType<typeof vi.fn>}).findFirst.mockResolvedValue({id: 'r1'});
    const res = await json(`/admin-events/${ID}/ticket-types/${TICKET}`, 'DELETE');
    expect(res.status).toBe(409);
    expect((state.db.ticketType as {deleteMany: ReturnType<typeof vi.fn>}).deleteMany).not.toHaveBeenCalled();
  });
});

describe('event settings', () => {
  it('serves the public brand without a row', async () => {
    const res = await json('/event-settings/brand', 'GET');
    expect(await res.json()).toEqual({brandColor: null, fontPreset: 'inter', logoUrl: null});
  });

  it('returns defaults when nothing was saved', async () => {
    const out = await (await json('/event-settings', 'GET')).json();
    expect(out.settings).toMatchObject({fontPreset: 'inter', defaultTimezone: 'UTC', updatedAt: null});
    expect(out.settings.defaultReminderRules.map((r: {kind: string}) => r.kind)).toEqual(
      expect.arrayContaining(['confirmation', 'reminder', 'live_now', 'thank_you']),
    );
  });

  it('PATCH 422s bad values and saves only the keys sent', async () => {
    const bad = await json('/event-settings', 'PATCH', {brandColor: 'blue'});
    expect(bad.status).toBe(422);
    const ok = await json('/event-settings', 'PATCH', {brandColor: '#ABCDEF', id: 5, evil: true});
    expect(ok.status).toBe(200);
    expect(calls.settings[0]).toEqual({brandColor: '#abcdef'});
  });
});
