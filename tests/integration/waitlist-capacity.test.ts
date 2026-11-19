import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {hashToken, newToken} from '../../src/domain/secureToken';
import {setPaidCheckoutHook} from '../../src/server/routes/rsvp';
import {eventsApp, resetEvents, rsvpBody} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

/**
 * Waitlist and capacity core against the real Postgres (audit H-2, M-1, M-2, M-5, M-8, M-10, M-11).
 * Events are created straight in the database: only the guest routes are under test.
 */
const R = '/site-api/rsvp/events';
const M = '/site-api/rsvp/manage';
const DAY = 86_400_000;
let n = 10;
const guest = () => new Browser(eventsApp, `198.51.100.${n++}`);
let seq = 0;
const code = () => `W${String(seq++).padStart(7, '0')}`;

async function mkEvent(over: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 7 * DAY);
  const slug = `wl-${seq++}`;
  return db.event.create({
    data: {
      slug, title: 'Waitlist Night', startAt: start, endAt: new Date(start.getTime() + 3_600_000), timezone: 'UTC',
      format: 'online', status: 'published', pollJoinCode: `P${String(seq++).padStart(5, '0')}`, capacity: 1, ...over,
    },
  });
}

/** A guest row with a known manage token. */
async function mkGuest(eventId: string, email: string, over: Record<string, unknown> = {}) {
  const token = newToken();
  const rsvp = await db.rsvp.create({
    data: {eventId, name: email.split('@')[0]!, email, response: 'going', status: 'confirmed', seats: 1, ticketCode: code(), manageToken: hashToken(token), ...over},
  });
  return {rsvp, token};
}

describe.skipIf(!DATABASE_URL)('waitlist and capacity (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
  });
  afterEach(() => setPaidCheckoutHook(null));

  it('H-2: a cancel with 1,000 waitlisted promotes the first and renumbers the rest in one statement, inside the time limit', async () => {
    const ev = await mkEvent({capacity: 1});
    const {token} = await mkGuest(ev.id, 'holder@example.test');
    const base = Date.now() - DAY;
    // Positions with gaps (2, 4, 6, …), so every remaining row must be rewritten.
    await db.rsvp.createMany({
      data: Array.from({length: 1000}, (_, i) => ({
        eventId: ev.id, name: `w${i}`, email: `w${i}@example.test`, response: 'going' as const, status: 'waitlisted' as const,
        seats: 1, ticketCode: code(), manageToken: hashToken(newToken()), waitlistPosition: (i + 1) * 2, createdAt: new Date(base + i),
      })),
    });

    const started = Date.now();
    const res = await guest().post(`${M}/${token}/cancel`);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);

    expect((await db.rsvp.findFirstOrThrow({where: {email: 'w0@example.test'}})).status).toBe('confirmed');
    const line = await db.rsvp.findMany({
      where: {eventId: ev.id, status: 'waitlisted'},
      select: {email: true, waitlistPosition: true},
      orderBy: {waitlistPosition: 'asc'},
    });
    expect(line).toHaveLength(999);
    expect(line.map(r => r.waitlistPosition)).toEqual(Array.from({length: 999}, (_, i) => i + 1));
    expect(line[0]!.email).toBe('w1@example.test');
    expect(line[998]!.email).toBe('w999@example.test');
  });

  it('M-2: promotion never oversells a limited ticket type', async () => {
    const ev = await mkEvent({capacity: 10});
    const vip = await db.ticketType.create({data: {eventId: ev.id, name: 'VIP', priceCents: 0, currency: 'USD', quantity: 1}});
    const general = await db.ticketType.create({data: {eventId: ev.id, name: 'General', priceCents: 0, currency: 'USD'}});
    const {token} = await mkGuest(ev.id, 'vip@example.test', {ticketTypeId: vip.id});
    for (const [i, email] of ['v1', 'v2', 'v3'].entries()) {
      await mkGuest(ev.id, `${email}@example.test`, {ticketTypeId: vip.id, status: 'waitlisted', waitlistPosition: i + 1});
    }
    await mkGuest(ev.id, 'g1@example.test', {ticketTypeId: general.id, status: 'waitlisted', waitlistPosition: 4});

    expect((await guest().post(`${M}/${token}/cancel`)).status).toBe(200);

    const vipHeld = await db.rsvp.count({where: {ticketTypeId: vip.id, status: 'confirmed'}});
    expect(vipHeld).toBe(1);
    expect((await db.rsvp.findFirstOrThrow({where: {email: 'v1@example.test'}})).status).toBe('confirmed');
    expect((await db.rsvp.findFirstOrThrow({where: {email: 'g1@example.test'}})).status).toBe('confirmed');
    const left = await db.rsvp.findMany({where: {eventId: ev.id, status: 'waitlisted'}, select: {email: true, waitlistPosition: true}, orderBy: {waitlistPosition: 'asc'}});
    expect(left).toEqual([
      {email: 'v2@example.test', waitlistPosition: 1},
      {email: 'v3@example.test', waitlistPosition: 2},
    ]);
  });

  it('M-10: a seat under an open paid-waitlist claim is not sold to a new guest', async () => {
    const ev = await mkEvent({capacity: 1});
    const t = await db.ticketType.create({data: {eventId: ev.id, name: 'Paid', priceCents: 1500, currency: 'USD'}});
    await mkGuest(ev.id, 'claimant@example.test', {
      ticketTypeId: t.id, status: 'waitlisted', waitlistPosition: 1, claimExpiresAt: new Date(Date.now() + 3_600_000),
    });
    setPaidCheckoutHook(async () => ({checkoutUrl: 'https://pay.example.test/x'}));

    const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('late@example.test', {ticketTypeId: t.id}));
    expect(res.status).toBe(202);
    expect(res.json.checkoutUrl).toBeNull();
    const late = await db.rsvp.findFirstOrThrow({where: {email: 'late@example.test'}});
    expect(late.status).toBe('waitlisted');
    expect(late.waitlistPosition).toBe(2);
  });

  it('M-8: a promoted guest keeps a working manage link when no email can carry a new one', async () => {
    const ev = await mkEvent({capacity: 1});
    const holder = await mkGuest(ev.id, 'holder@example.test');
    const next = await mkGuest(ev.id, 'next@example.test', {status: 'waitlisted', waitlistPosition: 1});

    expect((await guest().post(`${M}/${holder.token}/cancel`)).status).toBe(200);

    const view = await guest().get(`${M}/${next.token}`);
    expect(view.status).toBe(200);
    expect(view.json.rsvp).toMatchObject({status: 'confirmed'});
  });

  it('M-11: a declined or cancelled guest can RSVP again from their manage link', async () => {
    const ev = await mkEvent({capacity: 2});
    const declined = await mkGuest(ev.id, 'no@example.test', {response: 'not_going', status: 'declined'});
    const cancelled = await mkGuest(ev.id, 'gone@example.test', {status: 'cancelled'});

    const view = await guest().get(`${M}/${cancelled.token}`);
    expect(view.json.rsvp).toMatchObject({status: 'cancelled', canEdit: true});

    for (const {token} of [declined, cancelled]) {
      const res = await guest().request('PATCH', `${M}/${token}`, rsvpBody('ignored@example.test', {response: 'going'}));
      expect([res.status, res.json.status]).toEqual([200, 'confirmed']);
    }
    // Re-opened rows take seats like new guests: the event is now full.
    const third = await mkGuest(ev.id, 'third@example.test', {response: 'not_going', status: 'declined'});
    const res = await guest().request('PATCH', `${M}/${third.token}`, rsvpBody('x@example.test', {response: 'going'}));
    expect([res.status, res.json.status]).toEqual([200, 'waitlisted']);
  });

  it('M-1: a paid checkout that fails to start leaves nothing behind, so the same email can try again', async () => {
    const ev = await mkEvent({capacity: 5});
    const t = await db.ticketType.create({data: {eventId: ev.id, name: 'Paid', priceCents: 1500, currency: 'USD'}});
    setPaidCheckoutHook(async () => null);
    const first = await guest().post(`${R}/${ev.slug}`, rsvpBody('buyer@example.test', {ticketTypeId: t.id}));
    expect([first.status, first.json.error]).toEqual([409, 'payments_unavailable']);
    expect(await db.rsvp.count({where: {email: 'buyer@example.test'}})).toBe(0);

    setPaidCheckoutHook(async () => ({checkoutUrl: 'https://pay.example.test/ok'}));
    const second = await guest().post(`${R}/${ev.slug}`, rsvpBody('buyer@example.test', {ticketTypeId: t.id}));
    expect([second.status, second.json.checkoutUrl]).toEqual([202, 'https://pay.example.test/ok']);
    expect((await db.rsvp.findFirstOrThrow({where: {email: 'buyer@example.test'}})).status).toBe('awaiting_payment');
  });

  it('M-5: a private-event invite admits only the email it was sent to', async () => {
    const ev = await mkEvent({capacity: 10, visibility: 'private'});
    const invite = await db.invite.create({data: {eventId: ev.id, email: 'invited@example.test', token: `inv-${newToken().slice(0, 20)}`, status: 'sent'}});

    const other = await guest().post(`${R}/${ev.slug}`, rsvpBody('friend@example.test', {inviteToken: invite.token}));
    expect(other.status).toBe(422);
    expect(other.json.fields).toMatchObject({email: expect.any(String)});
    expect(await db.rsvp.count({where: {eventId: ev.id}})).toBe(0);

    const own = await guest().post(`${R}/${ev.slug}`, rsvpBody('Invited@Example.test', {inviteToken: invite.token}));
    expect(own.status).toBe(202);
    expect(await db.rsvp.findFirstOrThrow({where: {eventId: ev.id}})).toMatchObject({email: 'invited@example.test', inviteId: invite.id});
  });

  it('L-1: a private event links its guests to their manage page, never to the 404 event page', async () => {
    const ev = await mkEvent({capacity: 10, visibility: 'private'});
    const {token} = await mkGuest(ev.id, 'priv@example.test');
    const view = await guest().get(`${M}/${token}`);
    expect((view.json.event as {pageUrl: string}).pageUrl.endsWith(`/r/${token}/`)).toBe(true);
    const ics = await eventsApp.request(`${M}/${token}/calendar.ics`);
    const text = (await ics.text()).replace(/\r\n[ \t]/g, '');
    expect(text).toContain(`/r/${token}/`);
    expect(text).not.toContain(`/events/${ev.slug}/`);
  });

  it('L-6: a new and a repeat RSVP answer with the same status, body and headers', async () => {
    const ev = await mkEvent({capacity: 10});
    const first = await guest().post(`${R}/${ev.slug}`, rsvpBody('same@example.test'));
    const again = await guest().post(`${R}/${ev.slug}`, rsvpBody('same@example.test'));
    expect(again.status).toBe(first.status);
    expect(again.json).toEqual(first.json);
    for (const h of ['cache-control', 'referrer-policy', 'x-robots-tag']) expect([h, again.headers.get(h)]).toEqual([h, first.headers.get(h)]);
  });

  it('L-7: a full-length signed invite token opens a private event', async () => {
    const ev = await mkEvent({capacity: 10, visibility: 'private'});
    const token = `${'a'.repeat(150)}.${'b'.repeat(52)}`;
    await db.invite.create({data: {eventId: ev.id, email: 'long@example.test', token, status: 'sent'}});
    expect((await guest().get(`${R}/${ev.slug}?invite=${token}`)).status).toBe(200);
  });
});
