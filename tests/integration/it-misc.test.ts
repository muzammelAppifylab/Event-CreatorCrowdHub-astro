import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {hashToken, newToken} from '../../src/domain/secureToken';
import {app} from '../../src/server/app';
import {dailySalt, resetSaltMemo, utcDay, visitorHash} from '../../src/server/routes/pageviews';
import {resetEvents, setRoles} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, ownerSignedIn, resetDatabase, signedIn} from './support/harness';

/**
 * Misc audit fixes against the real Postgres, through the full Site API (`src/server/app.ts`):
 * L-8 page-view beacon, L-43 daily salt, L-5 door window, M-20 deep health, L-14 webhook hosts.
 */
const DAY = 86_400_000;
let seq = 0;
let ipN = 1;
const ip = () => `198.51.100.${(ipN++ % 250) + 1}`;
const code = () => `M${String(seq++).padStart(7, '0')}`;

async function mkEvent(over: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 7 * DAY);
  const n = seq++;
  return db.event.create({
    data: {
      slug: `misc-${n}`, title: 'Misc Night', startAt: start, endAt: new Date(start.getTime() + 3_600_000), timezone: 'UTC',
      format: 'online', status: 'published', pollJoinCode: `Q${String(n).padStart(5, '0')}`, ...over,
    },
  });
}

async function mkGuest(eventId: string, email: string, over: Record<string, unknown> = {}) {
  return db.rsvp.create({
    data: {eventId, name: email.split('@')[0]!, email, response: 'going', status: 'confirmed', seats: 1, ticketCode: code(), manageToken: hashToken(newToken()), ...over},
  });
}

async function withRoles(email: string, roles: string[]) {
  const b = await signedIn(app, email, undefined, ip());
  await setRoles(email, ...roles);
  return b;
}

const beacon = (slug: string, b = new Browser(app, ip())) => b.post(`/site-api/pageviews/${slug}`, {});

describe.skipIf(!DATABASE_URL)('misc audit fixes (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    await db.$executeRawUnsafe('TRUNCATE "page_view_salts"');
    resetSaltMemo();
  });

  // --- L-8: the beacon ------------------------------------------------------

  it('L-8: the beacon answers an empty 204 for unknown, malformed, draft, private, cancelled, deleted and public slugs alike', async () => {
    const pub = await mkEvent();
    const draft = await mkEvent({status: 'draft'});
    const priv = await mkEvent({visibility: 'private'});
    const cancelled = await mkEvent({status: 'cancelled'});
    const deleted = await mkEvent({deletedAt: new Date()});
    const answers = [];
    for (const slug of [pub.slug, 'no-such-event', 'BAD_SLUG!', draft.slug, priv.slug, cancelled.slug, deleted.slug]) {
      const res = await beacon(slug);
      answers.push({status: res.status, body: JSON.stringify(res.json), type: res.headers.get('content-type')});
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(answers[0]!.status).toBe(204);
  });

  it('L-8: only published public and unlisted events are counted; one row per visitor per day', async () => {
    const pub = await mkEvent();
    const unlisted = await mkEvent({visibility: 'unlisted'});
    const draft = await mkEvent({status: 'draft'});
    const priv = await mkEvent({visibility: 'private'});
    const cancelled = await mkEvent({status: 'cancelled'});
    const deleted = await mkEvent({deletedAt: new Date()});
    const visitor = new Browser(app, '198.51.100.200');
    for (const ev of [pub, unlisted, draft, priv, cancelled, deleted]) expect((await beacon(ev.slug, visitor)).status).toBe(204);
    // A repeat visit by the same visitor is deduplicated.
    expect((await beacon(pub.slug, visitor)).status).toBe(204);
    // Another visitor counts again.
    expect((await beacon(pub.slug, new Browser(app, '198.51.100.201'))).status).toBe(204);

    const rows = await db.pageView.groupBy({by: ['eventId'], _count: {_all: true}});
    const counts = Object.fromEntries(rows.map(r => [r.eventId, r._count._all]));
    expect(counts).toEqual({[pub.id]: 2, [unlisted.id]: 1});
    // No IP is stored: the hash is a 64-char hex digest.
    const stored = await db.pageView.findMany({select: {visitorHash: true}});
    for (const r of stored) expect(r.visitorHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // --- L-43: the daily salt -------------------------------------------------

  it('L-43: concurrent first beacons of a new day create ONE salt row and all hash with it', async () => {
    const ev = await mkEvent();
    const browsers = Array.from({length: 12}, (_, i) => new Browser(app, `192.0.2.${i + 10}`));
    // Get CSRF cookies first, so the beacons themselves are what runs at once.
    await Promise.all(browsers.map(b => b.get('/site-api/auth/csrf')));
    await db.$executeRawUnsafe('TRUNCATE "page_view_salts"');
    resetSaltMemo();

    const results = await Promise.all(browsers.map(b => beacon(ev.slug, b)));
    for (const r of results) expect(r.status).toBe(204);

    const today = utcDay(new Date());
    const salts = await db.pageViewSalt.findMany({select: {day: true, salt: true}});
    expect(salts).toHaveLength(1);
    expect(salts[0]!.day.toISOString().slice(0, 10)).toBe(today);

    const views = await db.pageView.findMany({where: {eventId: ev.id}, select: {visitorHash: true}});
    expect(views).toHaveLength(12);
    const expected = await Promise.all(
      browsers.map(b => visitorHash({salt: salts[0]!.salt, ip: b.ip, userAgent: 'integration-test', eventId: ev.id}))
    );
    expect(new Set(views.map(v => v.visitorHash))).toEqual(new Set(expected));
  });

  it('L-43: dailySalt called concurrently on separate connections agrees on one value', async () => {
    const day = '2031-02-03';
    const {createDb} = await import('../../src/platform/db');
    const clients = Array.from({length: 6}, () => createDb(DATABASE_URL));
    try {
      const salts = await Promise.all(
        clients.map(async c => {
          resetSaltMemo();
          return dailySalt(c, day);
        })
      );
      expect(new Set(salts).size).toBe(1);
      expect(await db.pageViewSalt.count({where: {day: new Date(`${day}T00:00:00.000Z`)}})).toBe(1);
    } finally {
      await Promise.all(clients.map(c => c.$disconnect()));
      resetSaltMemo();
    }
  });

  it('L-43: the first beacon of a day deletes salts older than 2 days and keeps the last two', async () => {
    const ev = await mkEvent();
    const now = Date.now();
    const dayAgo = (n: number) => new Date(`${utcDay(new Date(now - n * DAY))}T00:00:00.000Z`);
    const old = (n: number) => ({day: dayAgo(n), salt: String(n).repeat(64).slice(0, 64)});
    await db.pageViewSalt.createMany({data: [old(1), old(2), old(3), old(10)]});
    resetSaltMemo();

    expect((await beacon(ev.slug)).status).toBe(204);

    const left = (await db.pageViewSalt.findMany({select: {day: true}, orderBy: {day: 'asc'}})).map(r => r.day.toISOString().slice(0, 10));
    expect(left).toEqual([dayAgo(2), dayAgo(1), dayAgo(0)].map(d => d.toISOString().slice(0, 10)));
  });

  // --- L-5: door window -----------------------------------------------------

  it('L-5: checkin-only staff look up and check in codes only inside the 24 h window; a manager always can', async () => {
    const staff = await withRoles('door@example.test', ['checkin-staff']);
    const admin = await withRoles('boss@example.test', ['admin']);

    const now = Date.now();
    // Ended 2 h ago: inside the window. Ended 3 days ago: outside.
    const recent = await mkEvent({startAt: new Date(now - 4 * 3_600_000), endAt: new Date(now - 2 * 3_600_000)});
    const past = await mkEvent({startAt: new Date(now - 3 * DAY - 3_600_000), endAt: new Date(now - 3 * DAY)});
    const upcoming = await mkEvent();
    const gIn = await mkGuest(recent.id, 'in@example.test');
    const gOut = await mkGuest(past.id, 'out@example.test');
    const gUp = await mkGuest(upcoming.id, 'up@example.test');

    // Inside the window (recent and upcoming): staff can look up and check in.
    for (const g of [gIn, gUp]) {
      expect((await staff.get(`/site-api/checkin/codes/${g.ticketCode}`)).status).toBe(200);
      const res = await staff.post(`/site-api/checkin/codes/${g.ticketCode}`, {checkedIn: true});
      expect(res.status).toBe(200);
      expect((res.json.guest as {checkedInAt: string | null}).checkedInAt).not.toBeNull();
    }

    // Outside: 404 like an unknown code, for lookup, check-in and the event door list; nothing changes.
    const unknown = await staff.get('/site-api/checkin/codes/ZZZZ9999');
    const outLookup = await staff.get(`/site-api/checkin/codes/${gOut.ticketCode}`);
    expect(outLookup.status).toBe(404);
    expect(outLookup.json).toEqual(unknown.json);
    expect((await staff.post(`/site-api/checkin/codes/${gOut.ticketCode}`, {checkedIn: true})).status).toBe(404);
    expect((await staff.get(`/site-api/checkin/events/${past.id}`)).status).toBe(404);
    expect((await db.rsvp.findUniqueOrThrow({where: {id: gOut.id}})).checkedInAt).toBeNull();
    // The picker lists only events inside the window.
    const picker = (await staff.get('/site-api/checkin/events')).json.events as {id: string}[];
    expect(picker.map(e => e.id).sort()).toEqual([recent.id, upcoming.id].sort());

    // A manager can still fix the past event.
    expect((await admin.get(`/site-api/checkin/codes/${gOut.ticketCode}`)).status).toBe(200);
    expect((await admin.get(`/site-api/checkin/events/${past.id}`)).status).toBe(200);
    const fix = await admin.post(`/site-api/checkin/codes/${gOut.ticketCode}`, {checkedIn: true});
    expect(fix.status).toBe(200);
    expect((await db.rsvp.findUniqueOrThrow({where: {id: gOut.id}})).checkedInAt).not.toBeNull();
    // ...and undo it, still outside the window; staff still cannot.
    expect((await staff.post(`/site-api/checkin/codes/${gOut.ticketCode}`, {checkedIn: false})).status).toBe(404);
    expect((await admin.post(`/site-api/checkin/codes/${gOut.ticketCode}`, {checkedIn: false})).status).toBe(200);
  });

  it('L-5: a member without check-in gets 403, and a guest 401', async () => {
    const member = await withRoles('member@example.test', ['member']);
    const ev = await mkEvent();
    const g = await mkGuest(ev.id, 'g@example.test');
    expect((await member.get(`/site-api/checkin/codes/${g.ticketCode}`)).status).toBe(403);
    expect((await new Browser(app, ip()).get(`/site-api/checkin/codes/${g.ticketCode}`)).status).toBe(401);
  });

  // --- M-20: deep health ----------------------------------------------------

  it('M-20: /site-api/health/deep answers 200 with the database, not cached by the browser', async () => {
    const res = await new Browser(app, ip()).get('/site-api/health/deep');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ok: true, database: true});
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // --- L-14: webhook hosts --------------------------------------------------

  it('L-14: webhook endpoint creation refuses private, loopback and IP-echo hosts, and accepts a public one', async () => {
    const owner = await ownerSignedIn(app, undefined, ip());
    const bad = [
      'https://localhost/hook',
      'https://localhost.localdomain/hook',
      'https://127.0.0.1/hook',
      'https://127.1/hook',
      'https://2130706433/hook',
      'https://0x7f.0.0.1/hook',
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://10.0.0.5/hook',
      'https://192.168.1.1/hook',
      'https://169.254.169.254/latest',
      'https://intranet/hook',
      'https://db.internal/hook',
      'https://printer.local/hook',
      'https://api.svc/hook',
      'https://127.0.0.1.nip.io/hook',
      'https://10-0-0-1.sslip.io/hook',
      'https://lvh.me/hook',
      'https://app.localtest.me/hook',
      'https://127.0.0.1.attacker.example.com/hook',
      'http://hooks.example.com/hook',
      'https://hooks.example.com:8443/hook',
      'https://user:pw@hooks.example.com/hook',
    ];
    for (const url of bad) {
      const res = await owner.post('/site-api/webhook-endpoints', {url, events: ['rsvp.created']});
      expect({url, status: res.status}).toEqual({url, status: 422});
      expect((res.json.fields as Record<string, string>).url).toBeTruthy();
    }
    expect(await db.webhookEndpoint.count()).toBe(0);

    const ok = await owner.post('/site-api/webhook-endpoints', {url: 'https://hooks.zapier.com/hooks/catch/1/abc/', events: ['rsvp.created']});
    expect(ok.status).toBe(201);
    expect(await db.webhookEndpoint.count()).toBe(1);

    // An update to a private host is refused too.
    const id = (ok.json.endpoint as {id: string}).id;
    const patch = await owner.request('PATCH', `/site-api/webhook-endpoints/${id}`, {url: 'https://127.0.0.1.nip.io/x'});
    expect(patch.status).toBe(422);
    expect((await db.webhookEndpoint.findUniqueOrThrow({where: {id}})).url).toBe('https://hooks.zapier.com/hooks/catch/1/abc/');
  });
});
