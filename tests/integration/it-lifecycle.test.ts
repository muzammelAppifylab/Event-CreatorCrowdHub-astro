import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {hashToken, newToken} from '../../src/domain/secureToken';
import {cache, setCacheModeForTests} from '../../src/platform/cache';
import {createEvent, eventsApp, resetEvents, rsvpBody, userWith} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

/**
 * Event lifecycle against the real Postgres (audit H-1, M-29, L-10, L-15): unpublish and delete refuse
 * while anyone holds a place or paid; the RSVP / unpublish race; `hasHeld` in the admin list and detail;
 * the public event detail cache cleared by every event write; unlisted events never cached; a
 * ticket-type delete racing a booking.
 */
const A = '/site-api/admin-events';
const P = '/site-api/events';
const R = '/site-api/rsvp/events';
const DAY = 86_400_000;
const HELD_STATUSES = ['pending', 'confirmed', 'waitlisted', 'awaiting_payment'] as const;

let ipSeq = 0;
/** A fresh guest browser with its own IP (the RSVP limit is per IP). */
const guest = () => {
  const n = ipSeq++;
  return new Browser(eventsApp, `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`);
};
let seq = 0;
const code = (prefix: string, len: number) => `${prefix}${String(seq++).padStart(len - prefix.length, '0')}`;

/** An event straight in the database (no admin route), for the races. */
async function mkEvent(over: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 7 * DAY);
  return db.event.create({
    data: {
      slug: `lc-${seq++}`, title: 'Lifecycle Night', startAt: start, endAt: new Date(start.getTime() + 3_600_000), timezone: 'UTC',
      format: 'online', status: 'published', pollJoinCode: code('L', 6), ...over,
    },
    select: {id: true, slug: true},
  });
}

/** A guest row with a known status. */
async function mkGuest(eventId: string, email: string, over: Record<string, unknown> = {}) {
  return db.rsvp.create({
    data: {
      eventId, name: email.split('@')[0]!, email, response: 'going', status: 'confirmed', seats: 1,
      ticketCode: code('G', 8), manageToken: hashToken(newToken()), ...over,
    },
    select: {id: true},
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const statusOf =async (id: string) => db.event.findUniqueOrThrow({where: {id}, select: {status: true, deletedAt: true}});

describe.skipIf(!DATABASE_URL)('event lifecycle (integration, real Postgres)', () => {
  let admin: Browser;

  beforeAll(configureEnv);
  afterAll(async () => {
    setCacheModeForTests(null);
    await db.$disconnect();
  });
  beforeEach(async () => {
    setCacheModeForTests('memory');
    await resetDatabase();
    await resetEvents();
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
  });

  // ------------------------------------------------------------ H-1: 409 matrix --
  describe('unpublish and delete refuse while someone holds a place or paid', () => {
    it.each(HELD_STATUSES)('unpublish answers 409 event_has_guests with a %s guest, and the event stays published', async status => {
      const ev = await mkEvent();
      await mkGuest(ev.id, `${status}@example.test`, {status, ...(status === 'waitlisted' ? {waitlistPosition: 1} : {})});
      const res = await admin.post(`${A}/${ev.id}/unpublish`);
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('event_has_guests');
      expect((await statusOf(ev.id)).status).toBe('published');
      expect((await guest().get(`${P}/${ev.slug}`)).status).toBe(200);
    });

    it.each(HELD_STATUSES)('delete answers 409 event_has_guests on a draft with a %s guest, and nothing is deleted', async status => {
      const ev = await mkEvent({status: 'draft'});
      await mkGuest(ev.id, `${status}@example.test`, {status, ...(status === 'waitlisted' ? {waitlistPosition: 1} : {})});
      const res = await admin.delete(`${A}/${ev.id}`);
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('event_has_guests');
      expect((await statusOf(ev.id)).deletedAt).toBeNull();
    });

    it('a paid order alone (its guest cancelled) blocks both unpublish and delete', async () => {
      const pub = await mkEvent();
      const draft = await mkEvent({status: 'draft'});
      for (const ev of [pub, draft]) {
        const r = await mkGuest(ev.id, `paid-${ev.slug}@example.test`, {status: 'cancelled'});
        await db.ticketOrder.create({data: {rsvpId: r.id, checkoutId: `cs_${ev.slug}`, amountCents: 2500, currency: 'USD', status: 'paid'}});
      }
      const un = await admin.post(`${A}/${pub.id}/unpublish`);
      expect([un.status, un.json.error]).toEqual([409, 'event_has_guests']);
      expect((await statusOf(pub.id)).status).toBe('published');
      const del = await admin.delete(`${A}/${draft.id}`);
      expect([del.status, del.json.error]).toEqual([409, 'event_has_guests']);
      expect((await statusOf(draft.id)).deletedAt).toBeNull();
    });

    it('both succeed when nobody holds a place and nothing was paid (declined, cancelled, unpaid or refunded orders)', async () => {
      const ev = await mkEvent();
      await mkGuest(ev.id, 'no@example.test', {response: 'not_going', status: 'declined'});
      const gone = await mkGuest(ev.id, 'gone@example.test', {status: 'cancelled'});
      await db.ticketOrder.create({data: {rsvpId: gone.id, checkoutId: 'cs_refunded', amountCents: 2500, currency: 'USD', status: 'refunded'}});
      await db.ticketOrder.create({data: {rsvpId: gone.id, checkoutId: 'cs_expired', amountCents: 2500, currency: 'USD', status: 'expired'}});

      const un = await admin.post(`${A}/${ev.id}/unpublish`);
      expect(un.status).toBe(200);
      expect((await statusOf(ev.id)).status).toBe('draft');
      const del = await admin.delete(`${A}/${ev.id}`);
      expect(del.status).toBe(200);
      expect((await statusOf(ev.id)).deletedAt).not.toBeNull();

      // An empty event too.
      const empty = await mkEvent();
      expect((await admin.post(`${A}/${empty.id}/unpublish`)).status).toBe(200);
      expect((await admin.delete(`${A}/${empty.id}`)).status).toBe(200);
    });
  });

  // ------------------------------------------------- H-1: RSVP vs unpublish race --
  it('concurrent RSVPs vs unpublish never leave an unpublished event with a held RSVP', async () => {
    const ROUNDS = 30;
    let unpublished = 0;
    let refused = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const ev = await mkEvent();
      // Alternate who starts first, with a varying head start, so both orders (and true overlaps) happen; 1 to 3 RSVPs per round.
      const headStart = [0, 3, 8, 15, 30][round % 5]!;
      const unpublishFirst = round % 2 === 1;
      const start = <T>(first: boolean, run: () => Promise<T>) => (first ? run() : sleep(headStart).then(run));
      const un = start(unpublishFirst, () => admin.post(`${A}/${ev.id}/unpublish`));
      const rsvps = Array.from({length: 1 + (round % 3)}, (_, i) =>
        start(!unpublishFirst, () => guest().post(`${R}/${ev.slug}`, rsvpBody(`r${round}-${i}@example.test`)))
      );
      const [unRes, ...rsvpRes] = await Promise.all([un, ...rsvps]);

      expect([200, 409]).toContain(unRes.status);
      for (const r of rsvpRes) expect([202, 404]).toContain(r.status);
      const [event, held] = await Promise.all([
        statusOf(ev.id),
        db.rsvp.count({where: {eventId: ev.id, status: {in: [...HELD_STATUSES]}}}),
      ]);
      if (event.status === 'draft') {
        unpublished++;
        expect(held).toBe(0);
        expect(unRes.status).toBe(200);
        // Any RSVP that answered 202 must have landed before the unpublish, which is impossible here.
        expect(rsvpRes.every(r => r.status === 404)).toBe(true);
      } else {
        refused++;
        expect(event.status).toBe('published');
        expect(unRes.json.error).toBe('event_has_guests');
        expect(held).toBeGreaterThan(0);
      }
    }
    // Seen locally: both outcomes occur (most rounds the RSVP wins); the invariant above is what must hold.
    expect(unpublished + refused).toBe(ROUNDS);
  });

  // ---------------------------------------------------------------- hasHeld --
  it('hasHeld in the admin list matches the detail, for every tab', async () => {
    const confirmed = await mkEvent({title: 'Confirmed'});
    await mkGuest(confirmed.id, 'c@example.test');
    const waitlisted = await mkEvent({title: 'Waitlisted'});
    await mkGuest(waitlisted.id, 'w@example.test', {status: 'waitlisted', waitlistPosition: 1});
    const paidOnly = await mkEvent({title: 'Paid only'});
    const r = await mkGuest(paidOnly.id, 'p@example.test', {status: 'cancelled'});
    await db.ticketOrder.create({data: {rsvpId: r.id, checkoutId: 'cs_paid_only', amountCents: 1000, currency: 'USD', status: 'paid'}});
    const declined = await mkEvent({title: 'Declined'});
    await mkGuest(declined.id, 'd@example.test', {response: 'not_going', status: 'declined'});
    const empty = await mkEvent({title: 'Empty'});
    const draftHeld = await mkEvent({title: 'Draft held', status: 'draft'});
    await mkGuest(draftHeld.id, 'dh@example.test', {status: 'pending'});
    const draftEmpty = await mkEvent({title: 'Draft empty', status: 'draft'});

    const expected = new Map<string, boolean>([
      [confirmed.id, true], [waitlisted.id, true], [paidOnly.id, true], [declined.id, false], [empty.id, false],
      [draftHeld.id, true], [draftEmpty.id, false],
    ]);

    const [upcoming, drafts] = await Promise.all([admin.get(`${A}?tab=upcoming`), admin.get(`${A}?tab=drafts`)]);
    expect([upcoming.status, drafts.status]).toEqual([200, 200]);
    const listed = new Map(
      [...(upcoming.json.events as {id: string; hasHeld: boolean}[]), ...(drafts.json.events as {id: string; hasHeld: boolean}[])].map(e => [e.id, e.hasHeld])
    );
    for (const [id, want] of expected) {
      expect(listed.get(id), `list hasHeld for ${id}`).toBe(want);
      const detail = await admin.get(`${A}/${id}`);
      expect(detail.status).toBe(200);
      expect((detail.json.event as {hasHeld: boolean}).hasHeld, `detail hasHeld for ${id}`).toBe(want);
    }

    // The flag agrees with what unpublish / delete actually do.
    expect((await admin.post(`${A}/${confirmed.id}/unpublish`)).status).toBe(409);
    expect((await admin.post(`${A}/${declined.id}/unpublish`)).status).toBe(200);
    expect((await admin.delete(`${A}/${draftHeld.id}`)).status).toBe(409);
    expect((await admin.delete(`${A}/${draftEmpty.id}`)).status).toBe(200);
  });

  // ----------------------------------------------------- M-29: public detail cache --
  describe('public event detail cache (M-29, L-10)', () => {
    const title = (res: {json: Record<string, unknown>}) => (res.json.event as {title: string}).title;

    it('is really cached: a change behind the routes is not seen until an event write clears it', async () => {
      const ev = await createEvent(admin, {title: 'Original'});
      const visitor = guest();
      expect(title(await visitor.get(`${P}/${ev.slug}`))).toBe('Original');
      expect(await cache.get(`event:slug:${ev.slug}`)).not.toBeNull();
      await db.event.update({where: {id: ev.id}, data: {title: 'Behind the back'}});
      // Served from the cache: this is what makes the clearing tests below meaningful.
      expect(title(await visitor.get(`${P}/${ev.slug}`))).toBe('Original');
    });

    it('PATCH (title and slug) shows at once; the old slug is gone', async () => {
      const ev = await createEvent(admin, {title: 'Before'});
      const visitor = guest();
      expect(title(await visitor.get(`${P}/${ev.slug}`))).toBe('Before');

      const patched = await admin.request('PATCH', `${A}/${ev.id}`, {title: 'After'});
      expect(patched.status).toBe(200);
      expect(title(await visitor.get(`${P}/${ev.slug}`))).toBe('After');

      const newSlug = `${ev.slug}-moved`;
      expect((await admin.request('PATCH', `${A}/${ev.id}`, {slug: newSlug})).status).toBe(200);
      expect((await visitor.get(`${P}/${ev.slug}`)).status).toBe(404);
      const moved = await visitor.get(`${P}/${newSlug}`);
      expect([moved.status, title(moved)]).toEqual([200, 'After']);
    });

    it('unpublish, publish and cancel show at once', async () => {
      const ev = await createEvent(admin);
      const visitor = guest();
      expect((await visitor.get(`${P}/${ev.slug}`)).status).toBe(200);

      expect((await admin.post(`${A}/${ev.id}/unpublish`)).status).toBe(200);
      expect((await visitor.get(`${P}/${ev.slug}`)).status).toBe(404);

      expect((await admin.post(`${A}/${ev.id}/publish`)).status).toBe(200);
      const back = await visitor.get(`${P}/${ev.slug}`);
      expect([back.status, (back.json.event as {status: string}).status]).toEqual([200, 'published']);

      expect((await admin.post(`${A}/${ev.id}/cancel`)).status).toBe(200);
      const cancelled = await visitor.get(`${P}/${ev.slug}`);
      expect(cancelled.status).toBe(200);
      expect((cancelled.json.event as {status: string}).status).toBe('cancelled');
      expect(cancelled.headers.get('x-robots-tag')).toBe('noindex');
    });

    it('delete clears a cached detail (a stale entry left behind is not served after the delete)', async () => {
      const ev = await createEvent(admin);
      const visitor = guest();
      expect((await visitor.get(`${P}/${ev.slug}`)).status).toBe(200);
      // A draft whose old public detail is still cached (as if a clear had failed).
      await db.event.update({where: {id: ev.id}, data: {status: 'draft'}});
      expect((await visitor.get(`${P}/${ev.slug}`)).status).toBe(200);
      expect((await admin.delete(`${A}/${ev.id}`)).status).toBe(200);
      expect((await visitor.get(`${P}/${ev.slug}`)).status).toBe(404);
      expect(await cache.get(`event:slug:${ev.slug}`)).toBeNull();
    });

    it('an unlisted event is never served from or stored in the cache, and is private, no-store', async () => {
      const ev = await createEvent(admin, {title: 'Secret', visibility: 'unlisted'});
      const visitor = guest();
      const first = await visitor.get(`${P}/${ev.slug}`);
      expect([first.status, title(first)]).toEqual([200, 'Secret']);
      expect(first.headers.get('cache-control')).toContain('no-store');
      expect(await cache.get(`event:slug:${ev.slug}`)).toBeNull();
      await db.event.update({where: {id: ev.id}, data: {title: 'Changed directly'}});
      expect(title(await visitor.get(`${P}/${ev.slug}`))).toBe('Changed directly');
      expect(await cache.get(`event:slug:${ev.slug}`)).toBeNull();
    });

    it('a public event made unlisted drops its cached copy and is not cached again', async () => {
      const ev = await createEvent(admin, {title: 'Open'});
      const visitor = guest();
      expect((await visitor.get(`${P}/${ev.slug}`)).status).toBe(200);
      expect(await cache.get(`event:slug:${ev.slug}`)).not.toBeNull();
      expect((await admin.request('PATCH', `${A}/${ev.id}`, {visibility: 'unlisted'})).status).toBe(200);
      const res = await visitor.get(`${P}/${ev.slug}`);
      expect((res.json.event as {visibility: string}).visibility).toBe('unlisted');
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(await cache.get(`event:slug:${ev.slug}`)).toBeNull();
    });
  });

  // ------------------------------------------------- L-15: ticket delete vs booking --
  it('a ticket-type delete racing a booking: either the delete wins and nobody holds that ticket, or the booking wins and the delete is refused', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 20; round++) {
      const ev = await createEvent(admin, {title: `Tickets ${round}`});
      const made = await admin.post(`${A}/${ev.id}/ticket-types`, {name: 'Free pass', priceCents: 0, currency: 'USD'});
      expect(made.status, JSON.stringify(made.json)).toBe(201);
      const ticketId = (made.json.ticketType as {id: string}).id;

      // Alternate who starts first, with a varying head start, so both outcomes and true overlaps happen.
      const headStart = [0, 3, 8, 15, 30][round % 5]!;
      const deleteFirst = round % 2 === 1;
      const start = <T>(first: boolean, run: () => Promise<T>) => (first ? run() : sleep(headStart).then(run));
      const [delRes, bookRes] = await Promise.all([
        start(deleteFirst, () => admin.delete(`${A}/${ev.id}/ticket-types/${ticketId}`)),
        start(!deleteFirst, () => guest().post(`${R}/${ev.slug}`, rsvpBody(`t${round}@example.test`, {ticketTypeId: ticketId}))),
      ]);

      const [ticket, rows] = await Promise.all([
        db.ticketType.findUnique({where: {id: ticketId}, select: {id: true}}),
        db.rsvp.findMany({where: {eventId: ev.id}, select: {ticketTypeId: true, status: true}}),
      ]);
      if (delRes.status === 200) {
        outcomes.add('delete-won');
        expect(ticket).toBeNull();
        expect(bookRes.status).not.toBe(202);
        expect(rows).toEqual([]);
      } else {
        outcomes.add('booking-won');
        expect(delRes.status).toBe(409);
        expect(bookRes.status).toBe(202);
        expect(ticket).not.toBeNull();
        expect(rows).toEqual([{ticketTypeId: ticketId, status: 'confirmed'}]);
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });
});
