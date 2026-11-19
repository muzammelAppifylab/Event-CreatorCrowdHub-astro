import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {sameSitePath} from '../../src/lib/safe-path';
import {getDb} from '../../src/platform/db';
import {inRequestScope} from '../../src/platform/request-scope';
import {app} from '../../src/server/app';
import {createEvent, resetEvents, setRoles} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, ORIGIN, resetDatabase, signedIn} from './support/harness';

/**
 * HTTP input hygiene through the REAL Site API (`src/server/app.ts`, its full middleware chain:
 * sameOrigin, the checkout router before csrf, csrf, bodyLimit, inputGuard, the signed-in gates on
 * /event-admin and /checkin, onError), against real Postgres. Audit M-6, L-2, L-4, L-12, M-16.
 */

const NOT_UUID_36 = 'z'.repeat(8) + '-' + 'z'.repeat(4) + '-' + 'z'.repeat(4) + '-' + 'z'.repeat(4) + '-' + 'z'.repeat(12);
const DASHES_36 = '-'.repeat(36);
const PLAIN_36 = 'a'.repeat(36);
const VALID_UUID = '0192f0a1-0000-7000-8000-000000000001';

type Answer = {status: number; text: string; json: Record<string, unknown>; headers: Headers};

/** A request with a raw body and content type, carrying the browser's cookies and CSRF token. */
async function raw(b: Browser, method: string, path: string, body?: string, extra: Record<string, string> = {}): Promise<Answer> {
  if (method !== 'GET' && !b.cookie('site_csrf')) await b.get('/site-api/auth/csrf');
  const headers = new Headers({origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': b.ip, 'user-agent': 'integration-test'});
  if (method !== 'GET') headers.set('x-csrf-token', b.cookie('site_csrf') ?? '');
  if (b.jar.size) headers.set('cookie', [...b.jar].map(([k, v]) => `${k}=${v}`).join('; '));
  for (const [k, v] of Object.entries(extra)) {
    if (v === '') headers.delete(k);
    else headers.set(k, v);
  }
  const res = await inRequestScope(async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = {waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {}};
    const response = await app.request(`${ORIGIN}${path}`, {method, headers, body}, {}, ctx as never);
    while (pending.length) await pending.shift();
    await getDb()?.$disconnect();
    return response;
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return {status: res.status, text, json, headers: res.headers};
}

const JSON_TYPE = {'content-type': 'application/json'};

describe.skipIf(!DATABASE_URL)('HTTP input hygiene (integration, real app, real Postgres)', () => {
  let admin: Browser;
  let event: {id: string; slug: string};
  let logs: string[];

  beforeAll(() => configureEnv());
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    admin = await signedIn(app, 'http-admin@example.test', undefined, '203.0.113.40');
    await setRoles('http-admin@example.test', 'admin');
    event = await createEvent(admin, {title: 'Hygiene night'});
    logs = [];
    for (const level of ['error', 'warn', 'log', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(a => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------- M-6: malformed JSON → 400

  describe('malformed JSON', () => {
    it('a signed-in admin write with broken JSON answers 400 bad_request and writes nothing', async () => {
      const before = await db.event.count();
      const res = await raw(admin, 'POST', '/site-api/admin-events', '{"title": "x", ', JSON_TYPE);
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({error: 'bad_request'});
      expect(await db.event.count()).toBe(before);

      const patch = await raw(admin, 'PATCH', `/site-api/admin-events/${event.id}`, '{title:', JSON_TYPE);
      expect(patch.status).toBe(400);
      expect((await db.event.findUniqueOrThrow({where: {id: event.id}, select: {title: true}})).title).toBe('Hygiene night');
    });

    it('a guest RSVP with broken JSON answers 400, never 500', async () => {
      const guest = new Browser(app, '198.51.100.40');
      const res = await raw(guest, 'POST', `/site-api/rsvp/events/${event.slug}`, '{"email":', JSON_TYPE);
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({error: 'bad_request'});
      expect(await db.rsvp.count()).toBe(0);
    });

    it('a JSON body that is valid but not an object reaches the route validator (422), not 500', async () => {
      const guest = new Browser(app, '198.51.100.41');
      const res = await raw(guest, 'POST', `/site-api/rsvp/events/${event.slug}`, '[1,2]', JSON_TYPE);
      expect(res.status).toBe(422);
    });
  });

  // ---------------------------------------------------------------- L-2: non-JSON content type → 415

  describe('non-JSON content type on writes', () => {
    it('a JSON body labelled text/plain on PATCH is 415 and the event is unchanged (no silent empty PATCH)', async () => {
      const res = await raw(admin, 'PATCH', `/site-api/admin-events/${event.id}`, JSON.stringify({title: 'Hacked'}), {'content-type': 'text/plain'});
      expect(res.status).toBe(415);
      expect(res.json).toMatchObject({error: 'unsupported_media_type'});
      expect((await db.event.findUniqueOrThrow({where: {id: event.id}, select: {title: true}})).title).toBe('Hygiene night');
    });

    it('a form-encoded RSVP is 415, a missing content type is 415, application/json; charset and +json pass', async () => {
      const guest = new Browser(app, '198.51.100.42');
      const path = `/site-api/rsvp/events/${event.slug}`;
      const form = await raw(guest, 'POST', path, 'name=a&email=a%40example.test&response=going', {'content-type': 'application/x-www-form-urlencoded'});
      expect(form.status).toBe(415);
      const none = await raw(guest, 'POST', path, JSON.stringify({name: 'a'}), {'content-type': ''});
      expect(none.status).toBe(415);
      const lookalike = await raw(guest, 'POST', path, JSON.stringify({name: 'a'}), {'content-type': 'application/jsonx'});
      expect(lookalike.status).toBe(415);
      expect(await db.rsvp.count()).toBe(0);

      const ok = await raw(admin, 'PATCH', `/site-api/admin-events/${event.id}`, JSON.stringify({title: 'Renamed'}), {
        'content-type': 'application/json; charset=utf-8',
      });
      expect(ok.status).toBe(200);
      const merge = await raw(admin, 'PATCH', `/site-api/admin-events/${event.id}`, JSON.stringify({title: 'Renamed twice'}), {
        'content-type': 'application/merge-patch+json',
      });
      expect(merge.status).toBe(200);
      expect((await db.event.findUniqueOrThrow({where: {id: event.id}, select: {title: true}})).title).toBe('Renamed twice');
    });

    it('a write with no body needs no content type (publish/unpublish style actions still work)', async () => {
      const draft = await createEvent(admin, {title: 'Draft one'}, false);
      const res = await raw(admin, 'POST', `/site-api/admin-events/${draft.id}/publish`, undefined, {'content-type': ''});
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- M-6: NUL → 422

  describe('NUL characters', () => {
    it('a NUL in a JSON body field is 422 and nothing reaches Postgres', async () => {
      const before = await db.event.count();
      const body = JSON.stringify({title: 'Bad\u0000title', startAt: new Date(Date.now() + 864e6).toISOString(), endAt: new Date(Date.now() + 865e6).toISOString(), timezone: 'UTC', format: 'online'});
      const res = await raw(admin, 'POST', '/site-api/admin-events', body, JSON_TYPE);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({error: 'invalid_input'});
      expect(await db.event.count()).toBe(before);
    });

    it('a NUL nested in a guest RSVP body is 422 and stores no row; an escaped "\\\\u0000" is ordinary text', async () => {
      const guest = new Browser(app, '198.51.100.43');
      const path = `/site-api/rsvp/events/${event.slug}`;
      const res = await raw(guest, 'POST', path, JSON.stringify({name: 'Ann', email: 'ann@example.test', response: 'going', answers: {x: 'a\u0000'}}), JSON_TYPE);
      expect(res.status).toBe(422);
      expect(await db.rsvp.count()).toBe(0);
      // A literal backslash + "u0000" in a name is text, not a NUL: the route decides (never a 500 or the NUL 422).
      const literal = await raw(guest, 'POST', path, JSON.stringify({name: 'C:\\u0000', email: 'lit@example.test', response: 'going'}), JSON_TYPE);
      expect(literal.status).toBeLessThan(500);
      expect(literal.json.error).not.toBe('invalid_input');
    });

    it('a NUL in the query is 422 on public and admin lists', async () => {
      const guest = new Browser(app, '198.51.100.44');
      expect((await raw(guest, 'GET', '/site-api/events?q=a%00b')).status).toBe(422);
      expect((await raw(admin, 'GET', '/site-api/admin-events?q=a%00b')).status).toBe(422);
      expect((await raw(admin, 'GET', `/site-api/event-admin/events/${event.id}/guests?q=%00`)).status).toBe(422);
    });

    it('a NUL in a path segment is 422 (slug, token, id), never a 500', async () => {
      const guest = new Browser(app, '198.51.100.45');
      expect((await raw(guest, 'GET', `/site-api/events/${event.slug}%00`)).status).toBe(422);
      expect((await raw(guest, 'GET', `/site-api/rsvp/manage/${'a'.repeat(40)}%00`)).status).toBe(422);
      expect((await raw(admin, 'GET', `/site-api/admin-events/${event.id}%00`)).status).toBe(422);
      expect((await raw(guest, 'POST', `/site-api/rsvp/events/${event.slug}%00`, '{}', JSON_TYPE)).status).toBe(422);
    });
  });

  // ---------------------------------------------------------------- cursors on /site-api/events

  describe('/site-api/events cursor', () => {
    it('crafted cursors answer 400 bad_cursor (never a 500 from a uuid cast)', async () => {
      const guest = new Browser(app, '198.51.100.46');
      const crafted = [
        PLAIN_36,
        NOT_UUID_36,
        `2026-01-01T00:00:00.000Z_${DASHES_36}`,
        `2026-01-01T00:00:00.000Z_${NOT_UUID_36}`,
        `not-a-date_${VALID_UUID}`,
        `_${VALID_UUID}`,
        `2026-01-01T00:00:00.000Z_${VALID_UUID}'--`,
        `2026-01-01T00:00:00.000Z_${VALID_UUID}`.padEnd(81, 'x'),
        'x'.repeat(5000),
      ];
      for (const before of crafted) {
        const res = await raw(guest, 'GET', `/site-api/events?before=${encodeURIComponent(before)}`);
        expect(res.status, before.slice(0, 60)).toBe(400);
        expect(res.json).toMatchObject({error: 'bad_cursor'});
      }
    });

    it('a well-formed cursor (also upper-case) pages past the cursor row', async () => {
      const second = await createEvent(admin, {title: 'Second night', startAt: new Date(Date.now() + 20 * 864e5).toISOString(), endAt: new Date(Date.now() + 20.1 * 864e5).toISOString()});
      const guest = new Browser(app, '198.51.100.47');
      const first = await raw(guest, 'GET', '/site-api/events');
      expect(first.status).toBe(200);
      const list = first.json.events as {id: string; startAt: string}[];
      expect(list.map(e => e.id)).toEqual([event.id, second.id]);
      const cursor = `${list[0]!.startAt}_${list[0]!.id}`;
      for (const before of [cursor, cursor.toUpperCase()]) {
        const next = await raw(guest, 'GET', `/site-api/events?before=${encodeURIComponent(before)}`);
        expect(next.status, before).toBe(200);
        expect((next.json.events as {id: string}[]).map(e => e.id)).toEqual([second.id]);
      }
      // An empty cursor is the first page.
      expect((await raw(guest, 'GET', '/site-api/events?before=')).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- L-4: 401 before validation

  describe('anonymous callers to /event-admin and /checkin', () => {
    const anonymousCalls: [string, string, string | undefined][] = [
      ['GET', `/site-api/event-admin/events/${NOT_UUID_36}/guests`, undefined],
      ['GET', `/site-api/event-admin/events/${VALID_UUID}/guests?before=garbage&status=nope`, undefined],
      ['POST', `/site-api/event-admin/events/${VALID_UUID}/guests/bulk`, JSON.stringify({action: 'nonsense', ids: 'x'})],
      ['POST', `/site-api/event-admin/events/${VALID_UUID}/guests/bulk`, '{broken json'],
      ['PATCH', `/site-api/event-admin/events/${VALID_UUID}/guests/${NOT_UUID_36}`, JSON.stringify({status: 42})],
      ['POST', `/site-api/event-admin/events/${VALID_UUID}/invites`, JSON.stringify({})],
      ['POST', `/site-api/event-admin/events/${VALID_UUID}/messages/broadcast`, '{"subject":'],
      ['GET', '/site-api/event-admin/contacts?after=%%%', undefined],
      ['GET', `/site-api/checkin/events/${NOT_UUID_36}`, undefined],
      ['GET', '/site-api/checkin/codes/!!', undefined],
      ['POST', '/site-api/checkin/codes/!!', JSON.stringify({checkedIn: 'maybe'})],
      ['POST', '/site-api/checkin/codes/ABCD1234', '{nope'],
      ['POST', `/site-api/checkin/events/${NOT_UUID_36}/attendance`, JSON.stringify({})],
    ];
    it.each(anonymousCalls)('%s %s answers 401', async (method, path, body) => {
      const anon = new Browser(app, '198.51.100.48');
      const res = await raw(anon, method, path, body, body === undefined ? {} : JSON_TYPE);
      expect(res.status).toBe(401);
    });

    it('an anonymous non-JSON write is 401, not the 415 of the content-type guard', async () => {
      const anon = new Browser(app, '198.51.100.50');
      const text = {'content-type': 'text/plain'};
      expect((await raw(anon, 'POST', `/site-api/event-admin/events/${VALID_UUID}/guests/bulk`, 'hello', text)).status).toBe(401);
      expect((await raw(anon, 'PATCH', `/site-api/event-admin/events/${VALID_UUID}/guests/${VALID_UUID}`, 'x', {'content-type': ''})).status).toBe(401);
      expect((await raw(anon, 'POST', '/site-api/checkin/codes/ABCD1234', 'hello', text)).status).toBe(401);
      // Signed in, the same write still meets the 415.
      expect((await raw(admin, 'POST', `/site-api/event-admin/events/${event.id}/guests/bulk`, 'hello', text)).status).toBe(415);
    });

    it('anonymous callers to the router-gated admin routes get 401 too', async () => {
      const anon = new Browser(app, '198.51.100.49');
      expect((await raw(anon, 'GET', `/site-api/admin-events/${NOT_UUID_36}`)).status).toBe(401);
      expect((await raw(anon, 'PATCH', `/site-api/admin-events/${event.id}`, '{"title":', JSON_TYPE)).status).toBe(401);
    });

    const organiserWrites = [
      '/site-api/admin-events',
      `/site-api/admin-events/${VALID_UUID}/publish`,
      '/site-api/overview',
      '/site-api/analytics/anything',
      `/site-api/polls/event/${VALID_UUID}`,
      `/site-api/refunds/${VALID_UUID}/mark-refunded`,
      '/site-api/webhook-endpoints',
      `/site-api/webhook-endpoints/${VALID_UUID}/test`,
    ];
    it.each(organiserWrites)('an anonymous text/plain POST to %s is 401, and a signed-in admin gets 415', async path => {
      const text = {'content-type': 'text/plain'};
      const anon = new Browser(app, '198.51.100.51');
      expect((await raw(anon, 'POST', path, 'hello', text)).status).toBe(401);
      expect((await raw(admin, 'POST', path, 'hello', text)).status).toBe(415);
    });

    it('GET /site-api/event-settings/brand stays public (not behind a sign-in gate)', async () => {
      const anon = new Browser(app, '198.51.100.52');
      const res = await raw(anon, 'GET', '/site-api/event-settings/brand');
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- 36-char non-UUID → 404

  describe('a 36-character id that is not a UUID', () => {
    const shapes = [NOT_UUID_36, DASHES_36, PLAIN_36];
    it('answers 404 (never a 500 from a Postgres uuid cast) on every id route an admin can reach', async () => {
      const paths = (bad: string): [string, string, string | undefined][] => [
        ['GET', `/site-api/admin-events/${bad}`, undefined],
        ['PATCH', `/site-api/admin-events/${bad}`, JSON.stringify({title: 'x'})],
        ['POST', `/site-api/admin-events/${bad}/publish`, undefined],
        ['POST', `/site-api/admin-events/${bad}/unpublish`, undefined],
        ['POST', `/site-api/admin-events/${bad}/cancel`, undefined],
        ['GET', `/site-api/admin-events/${bad}/cancel-preview`, undefined],
        ['DELETE', `/site-api/admin-events/${bad}`, undefined],
        ['GET', `/site-api/admin-events/${bad}/ticket-types`, undefined],
        ['DELETE', `/site-api/admin-events/${event.id}/ticket-types/${bad}`, undefined],
        ['GET', `/site-api/event-admin/events/${bad}/guests`, undefined],
        ['GET', `/site-api/event-admin/events/${event.id}/guests/${bad}`, undefined],
        ['GET', `/site-api/event-admin/events/${event.id}/guests/${bad}/data`, undefined],
        ['DELETE', `/site-api/event-admin/events/${event.id}/guests/${bad}`, undefined],
        ['GET', `/site-api/event-admin/events/${bad}/invites`, undefined],
        ['DELETE', `/site-api/event-admin/events/${event.id}/invites/${bad}`, undefined],
        ['GET', `/site-api/event-admin/events/${bad}/messages/rules`, undefined],
        ['DELETE', `/site-api/event-admin/events/${event.id}/messages/rules/${bad}`, undefined],
        ['GET', `/site-api/checkin/events/${bad}`, undefined],
        ['GET', `/site-api/checkin/events/${bad}/attendees`, undefined],
        ['GET', `/site-api/polls/event/${bad}`, undefined],
        ['GET', `/site-api/polls/${bad}/results`, undefined],
        ['DELETE', `/site-api/polls/${bad}`, undefined],
        ['POST', `/site-api/refunds/${bad}/mark-refunded`, undefined],
      ];
      const failures: string[] = [];
      for (const bad of shapes) {
        for (const [method, path, body] of paths(bad)) {
          const res = await raw(admin, method, path, body, body === undefined ? {} : JSON_TYPE);
          if (res.status !== 404) failures.push(`${method} ${path} -> ${res.status} ${res.text.slice(0, 80)}`);
        }
      }
      expect(failures).toEqual([]);
      expect(logs.filter(l => /site-api .*:/.test(l))).toEqual([]);
    });

    it('an upper-case valid UUID still finds the event', async () => {
      const res = await raw(admin, 'GET', `/site-api/admin-events/${event.id.toUpperCase()}`);
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- L-12: no tokens echoed

  describe('error responses never echo tokens', () => {
    it('unknown manage, invite, privacy and ticket-code tokens answer without the token in body, headers or logs', async () => {
      const guest = new Browser(app, '198.51.100.50');
      const manage = 'MANAGEtok_' + 'q'.repeat(30);
      const invite = 'INVITEtok.' + 'w'.repeat(30);
      const privacy = 'PRIVtok_' + 'e'.repeat(40);
      const calls: [Browser, string, string, string | undefined][] = [
        [guest, 'GET', `/site-api/rsvp/manage/${manage}`, undefined],
        [guest, 'PATCH', `/site-api/rsvp/manage/${manage}`, JSON.stringify({name: 'x'})],
        [guest, 'POST', `/site-api/rsvp/manage/${manage}/cancel`, undefined],
        [guest, 'GET', `/site-api/rsvp/manage/${manage}/calendar.ics`, undefined],
        [guest, 'GET', `/site-api/rsvp/invite/${invite}`, undefined],
        [guest, 'GET', `/site-api/rsvp/events/${event.slug}?invite=${invite}`, undefined],
        [guest, 'GET', `/site-api/privacy/guest/${privacy}`, undefined],
        [guest, 'POST', `/site-api/privacy/unsubscribe/${privacy}`, undefined],
        [guest, 'GET', `/site-api/privacy/consent/${privacy}`, undefined],
        [guest, 'GET', `/site-api/polls-public/guest-link/${privacy}`, undefined],
        // Malformed bodies on token routes: the 400/415/422 must not echo the token either.
        [guest, 'PATCH', `/site-api/rsvp/manage/${manage}`, '{"name":'],
        [guest, 'PATCH', `/site-api/rsvp/manage/${manage}`, 'name=x'],
        [guest, 'GET', `/site-api/rsvp/manage/${manage}%00`, undefined],
        [admin, 'GET', '/site-api/checkin/codes/ZZZZ9999', undefined],
        [admin, 'POST', '/site-api/checkin/codes/ZZZZ9999', JSON.stringify({checkedIn: true})],
      ];
      for (const [b, method, path, body] of calls) {
        const type = body === undefined ? {} : body.startsWith('{') ? JSON_TYPE : {'content-type': 'application/x-www-form-urlencoded'};
        const res = await raw(b, method, path, body, type);
        // A public event with an unknown invite is still a 200 (the page shows); everything else is a 4xx.
        if (!path.includes('?invite=')) expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
        expect(res.status, `${method} ${path}`).toBeLessThan(500);
        const everything = res.text + JSON.stringify([...res.headers]);
        for (const secret of [manage, invite, privacy, 'ZZZZ9999']) expect(everything, `${method} ${path}`).not.toContain(secret);
      }
      for (const secret of [manage, invite, privacy]) expect(logs.join('\n')).not.toContain(secret);
    });

    it('a malformed JSON body does not echo what was sent', async () => {
      const marker = 'SECRET-BODY-MARKER-1234567890';
      const res = await raw(admin, 'PATCH', `/site-api/admin-events/${event.id}`, `{"title": "${marker}`, JSON_TYPE);
      expect(res.status).toBe(400);
      expect(res.text).not.toContain(marker);
    });
  });

  // ---------------------------------------------------------------- the Buy button as a plain form

  describe('POST /site-api/checkout as a form (the Buy button without JavaScript)', () => {
    const form = (b: Browser, body: string, extra: Record<string, string> = {}) =>
      raw(b, 'POST', '/site-api/checkout', body, {'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': '', ...extra});

    it('a same-origin form post is not 415: it reaches the checkout and is answered with a 303', async () => {
      const buyer = new Browser(app, '198.51.100.51');
      await buyer.get('/site-api/auth/csrf');
      const res = await form(buyer, 'price=test-price&quantity=1&successPath=%2Fthanks%2F&cancelPath=%2F');
      expect(res.status).not.toBe(415);
      // No real payments in the test platform: the form lands on the checkout page with an error code.
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toMatch(/^\/checkout\/\?/);
    });

    it('a multipart form post is not 415 either', async () => {
      const buyer = new Browser(app, '198.51.100.52');
      const fd = new FormData();
      fd.set('price', 'test-price');
      const encoded = new Response(fd);
      const type = encoded.headers.get('content-type')!;
      const res = await raw(buyer, 'POST', '/site-api/checkout', await encoded.text(), {'content-type': type, 'x-csrf-token': ''});
      expect(res.status).not.toBe(415);
      expect(res.status).toBe(303);
    });

    it('a form post reaches the checkout validation: bad price, bad quantity, an off-site return path are 422', async () => {
      const buyer = new Browser(app, '198.51.100.53');
      for (const body of [
        'price=NOT%20A%20KEY',
        'price=test-price&quantity=0',
        'price=test-price&quantity=abc',
        'price=test-price&successPath=%2F%2Fevil.example%2F',
        'price=test-price&cancelPath=%2F%5Cevil.example',
        'price=test-price&email=not-an-email',
      ]) {
        const res = await form(buyer, body);
        expect(res.status, body).toBe(422);
        expect(res.json, body).toMatchObject({error: 'invalid_input'});
      }
    });

    it('a cross-site form post without the token is refused (403), and JSON checkout keeps its 400 for broken JSON', async () => {
      const buyer = new Browser(app, '198.51.100.54');
      // A cross-site form: sameOrigin refuses it outright, before formCsrf.
      const cross = await form(buyer, 'price=test-price', {'sec-fetch-site': 'cross-site', origin: 'https://evil.example'});
      expect(cross.status).toBe(403);
      // Same-origin, but not a form and no token: formCsrf refuses.
      const noToken = await raw(buyer, 'POST', '/site-api/checkout', JSON.stringify({price: 'test-price'}), {...JSON_TYPE, 'x-csrf-token': ''});
      expect(noToken.status).toBe(403);
      const broken = await raw(buyer, 'POST', '/site-api/checkout', '{"price":', JSON_TYPE);
      expect(broken.status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------- the checkout page's return paths (M-16)

describe('sameSitePath (the checkout page return paths)', () => {
  it('rejects //, /\\ and their encoded and control-character variants', () => {
    const evil = [
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/%2Fevil.example',
      '/%2fevil.example',
      '%2F%2Fevil.example',
      '/%5Cevil.example',
      '/%5cevil.example',
      '/\tevil',
      '/%09/evil.example',
      '/ok\\..\\evil',
      '/%00',
      'https://evil.example/',
      'evil.example',
      'javascript:alert(1)',
      '/%E0%A4%A', // malformed escape
      '',
      'x'.repeat(10) + '/'.repeat(600),
    ];
    for (const value of evil) expect(sameSitePath(value, '/thanks/'), JSON.stringify(value)).toBe('/thanks/');
    for (const value of [null, undefined, 42, {}, ['/a']]) expect(sameSitePath(value)).toBe('/');
  });

  it('keeps an ordinary same-site path, with its query and encoded characters, as given', () => {
    for (const value of ['/', '/thanks/', '/events/launch/?checkout=1', '/a%20b/', '/search/?q=%2Fx']) {
      expect(sameSitePath(value, '/fallback/')).toBe(value);
    }
  });
});
