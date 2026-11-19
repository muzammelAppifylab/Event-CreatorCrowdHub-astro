import {createHash} from 'node:crypto';

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {hashToken, newToken} from '../../src/domain/secureToken';
import {setPaidCheckoutHook} from '../../src/server/routes/rsvp';
import {createEvent, eventsApp, resetEvents, rsvpBody, userWith} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

/** Ported from CreatorCrowdHub `routes/public.test.ts` (public RSVP, manage, invite landing, ICS, manage-link). */
const R = '/site-api/rsvp/events';
const M = '/site-api/rsvp/manage';
let n = 10;
const guest = () => new Browser(eventsApp, `198.51.100.${n++}`);
const DAY = 86_400_000;

async function tokenFor(email: string) {
  const token = newToken();
  const row = await db.rsvp.findFirstOrThrow({where: {email}});
  await db.rsvp.update({where: {id: row.id}, data: {manageToken: hashToken(token)}});
  return token;
}
const row = (email: string) => db.rsvp.findFirstOrThrow({where: {email}});
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let inviteN = 0;
const mkInvite = (eventId: string, email: string, status: 'queued' | 'sent' | 'bounced' | 'responded' = 'sent') =>
  db.invite.create({data: {eventId, email, token: `inv-${Date.now()}-${inviteN++}-${newToken().slice(0, 10)}`, status}});

describe.skipIf(!DATABASE_URL)('ported RSVP routes (integration, real Postgres)', () => {
  let admin: Browser;
  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
  });

  describe('GET /rsvp/events/:slug', () => {
    it('returns the public view and never the join link', async () => {
      const ev = await createEvent(admin, {format: 'online', joinUrl: 'https://meet.example.test/x', capacity: 5});
      const res = await guest().get(`${R}/${ev.slug}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(JSON.stringify(res.json)).not.toContain('meet.example.test');
      expect(res.json.event).toMatchObject({slug: ev.slug, seatsLeft: 5, closed: false, status: 'published'});
    });

    it('404s for drafts, soft-deleted, unknown and malformed slugs', async () => {
      const draft = await createEvent(admin, {}, false);
      expect((await guest().get(`${R}/${draft.slug}`)).status).toBe(404);
      expect((await guest().get(`${R}/no-such-event`)).status).toBe(404);
      expect((await guest().get(`${R}/${'x'.repeat(130)}`)).status).toBe(404);
      const ev = await createEvent(admin, {title: 'Gone'});
      await db.event.update({where: {id: ev.id}, data: {deletedAt: new Date()}});
      expect((await guest().get(`${R}/${ev.slug}`)).status).toBe(404);
    });

    it('gates private events behind a live invite for that event, same 404 as a missing one', async () => {
      const ev = await createEvent(admin, {visibility: 'private'});
      const other = await createEvent(admin, {title: 'Other', visibility: 'private'});
      const g = guest();
      const missing = await g.get(`${R}/no-such-event`);
      const blocked = await g.get(`${R}/${ev.slug}`);
      expect(blocked.status).toBe(404);
      expect(blocked.json).toEqual(missing.json);
      const good = await mkInvite(ev.id, 'i@example.test');
      expect((await g.get(`${R}/${ev.slug}?invite=${good.token}`)).status).toBe(200);
      expect((await g.get(`${R}/${other.slug}?invite=${good.token}`)).status).toBe(404); // another event's invite
      const bounced = await mkInvite(ev.id, 'b@example.test', 'bounced');
      expect((await g.get(`${R}/${ev.slug}?invite=${bounced.token}`)).status).toBe(404);
      expect((await g.get(`${R}/${ev.slug}?invite=nonexistent-token-123`)).status).toBe(404);
      await db.event.update({where: {id: ev.id}, data: {startAt: new Date(Date.now() - 2 * DAY), endAt: new Date(Date.now() - DAY)}});
      expect((await g.get(`${R}/${ev.slug}?invite=${good.token}`)).status).toBe(404); // event is over
    });

    it('shows unlisted events without a token', async () => {
      const ev = await createEvent(admin, {visibility: 'unlisted'});
      expect((await guest().get(`${R}/${ev.slug}`)).status).toBe(200);
    });

    it('counts seats from confirmed and awaiting_payment going guests only; Maybe holds none', async () => {
      const ev = await createEvent(admin, {capacity: 10, allowMaybe: true, maxPlusOnes: 3});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {plusOnes: 2})); // 3 seats
      await guest().post(`${R}/${ev.slug}`, rsvpBody('m@example.test', {response: 'maybe'}));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('d@example.test', {response: 'not_going'}));
      const res = await guest().get(`${R}/${ev.slug}`);
      expect((res.json.event as {seatsLeft: number}).seatsLeft).toBe(7);
      await db.rsvp.update({where: {id: (await row('m@example.test')).id}, data: {response: 'going', status: 'awaiting_payment', seats: 1}});
      expect(((await guest().get(`${R}/${ev.slug}`)).json.event as {seatsLeft: number}).seatsLeft).toBe(6);
    });

    it('reports unlimited capacity as seatsLeft null, and closed past the deadline', async () => {
      const ev = await createEvent(admin, {capacity: null});
      expect((await guest().get(`${R}/${ev.slug}`)).json.event).toMatchObject({seatsLeft: null, closed: false});
      await db.event.update({where: {id: ev.id}, data: {rsvpDeadline: new Date(Date.now() - 1000)}});
      expect((await guest().get(`${R}/${ev.slug}`)).json.event).toMatchObject({closed: true});
    });

    it('marks ticket types sold out and sales ended', async () => {
      const ev = await createEvent(admin, {capacity: 20});
      const open = await db.ticketType.create({data: {eventId: ev.id, name: 'Open', quantity: 5}});
      const sold = await db.ticketType.create({data: {eventId: ev.id, name: 'Sold', quantity: 1}});
      await db.ticketType.create({data: {eventId: ev.id, name: 'Ended', salesEndAt: new Date(Date.now() - 1000)}});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {ticketTypeId: sold.id}));
      const tickets = ((await guest().get(`${R}/${ev.slug}`)).json.event as {ticketTypes: {name: string; remaining: number | null; salesEnded: boolean}[]}).ticketTypes;
      const by = Object.fromEntries(tickets.map(t => [t.name, t]));
      expect(by.Open).toMatchObject({remaining: 5, salesEnded: false});
      expect(by.Sold).toMatchObject({remaining: 0});
      expect(by.Ended).toMatchObject({salesEnded: true});
      expect(open.id).toBeTruthy();
    });
  });

  describe('POST /rsvp/events/:slug', () => {
    it('creates a lower-cased guest with a ticket code and a random manage token stored only as its sha256', async () => {
      const ev = await createEvent(admin);
      const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('  Ada@Example.TEST ', {name: ' Ada '}));
      expect(res.status).toBe(202);
      expect(res.json).toEqual({status: 'check_email', checkoutUrl: null, message: expect.any(String)});
      expect(res.headers.get('cache-control')).toContain('no-store');
      const r = await row('ada@example.test');
      expect(r).toMatchObject({name: 'Ada', response: 'going', status: 'confirmed', seats: 1});
      expect(r.ticketCode).toBeTruthy();
      expect(r.manageToken).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(res.json)).not.toContain(r.manageToken!);
      expect(JSON.stringify(res.json)).not.toContain(r.ticketCode!);
      // the emailed link carries the raw token whose sha256 is what is stored
      const token = await tokenFor('ada@example.test');
      expect((await row('ada@example.test')).manageToken).toBe(sha(token));
    });

    it('a repeat RSVP changes nothing, returns the same body and never the manage token', async () => {
      const ev = await createEvent(admin, {capacity: 10});
      const first = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {name: 'Ada'}));
      const before = await row('a@example.test');
      const again = await guest().post(`${R}/${ev.slug}`, rsvpBody('A@Example.test', {name: 'Mallory', response: 'not_going', plusOnes: 0}));
      expect(again.status).toBe(202);
      expect(again.json).toEqual(first.json);
      const after = await row('a@example.test');
      expect(after).toMatchObject({name: 'Ada', response: 'going', status: 'confirmed'});
      expect(after.manageToken).toBe(before.manageToken);
      expect(await db.rsvp.count()).toBe(1);
      expect(JSON.stringify(again.json)).not.toContain(before.manageToken!);
    });

    it('drops a filled honeypot with the same 202 and stores nothing', async () => {
      const ev = await createEvent(admin);
      const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('bot@example.test', {website: 'http://spam.test'}));
      expect(res.status).toBe(202);
      expect(res.json.status).toBe('check_email');
      expect(await db.rsvp.count()).toBe(0);
    });

    it('records not_going as declined without a seat; Maybe confirms without a seat even when full', async () => {
      const ev = await createEvent(admin, {capacity: 1, allowMaybe: true});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('d@example.test', {response: 'not_going'}));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('m@example.test', {response: 'maybe'}));
      expect(await row('d@example.test')).toMatchObject({status: 'declined'});
      expect(await row('m@example.test')).toMatchObject({status: 'confirmed', response: 'maybe'});
      expect(((await guest().get(`${R}/${ev.slug}`)).json.event as {seatsLeft: number}).seatsLeft).toBe(0);
    });

    it('rejects Maybe when the event does not allow it', async () => {
      const ev = await createEvent(admin, {allowMaybe: false});
      const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('m@example.test', {response: 'maybe'}));
      expect(res.status).toBe(422);
      expect(res.json.fields).toHaveProperty('response');
    });

    it('waitlists in arrival order when full', async () => {
      const ev = await createEvent(admin, {capacity: 1, waitlistEnabled: true});
      for (const e of ['a', 'b', 'c', 'd']) await guest().post(`${R}/${ev.slug}`, rsvpBody(`${e}@example.test`));
      expect((await row('a@example.test')).status).toBe('confirmed');
      expect([await row('b@example.test'), await row('c@example.test'), await row('d@example.test')].map(r => [r.status, r.waitlistPosition])).toEqual([
        ['waitlisted', 1],
        ['waitlisted', 2],
        ['waitlisted', 3],
      ]);
    });

    it('409s with event_full / rsvps_closed / event_cancelled', async () => {
      const full = await createEvent(admin, {title: 'Full', capacity: 1, waitlistEnabled: false});
      await guest().post(`${R}/${full.slug}`, rsvpBody('a@example.test'));
      const r1 = await guest().post(`${R}/${full.slug}`, rsvpBody('b@example.test'));
      expect([r1.status, r1.json.error]).toEqual([409, 'event_full']);

      const closed = await createEvent(admin, {title: 'Closed'});
      await db.event.update({where: {id: closed.id}, data: {rsvpDeadline: new Date(Date.now() - 1000)}});
      const r2 = await guest().post(`${R}/${closed.slug}`, rsvpBody('a@example.test'));
      expect([r2.status, r2.json.error]).toEqual([409, 'rsvps_closed']);

      const cancelled = await createEvent(admin, {title: 'Cancelled'});
      await db.event.update({where: {id: cancelled.id}, data: {status: 'cancelled'}});
      const r3 = await guest().post(`${R}/${cancelled.slug}`, rsvpBody('a@example.test'));
      expect([r3.status, r3.json.error]).toEqual([409, 'event_cancelled']);
    });

    it('rejects a party larger than the whole capacity as event_full', async () => {
      const ev = await createEvent(admin, {capacity: 2, maxPlusOnes: 5, waitlistEnabled: true});
      const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {plusOnes: 3}));
      expect([res.status, res.json.error]).toEqual([409, 'event_full']);
    });

    it('caps plus-ones at maxPlusOnes and counts seats as 1 + plus-ones', async () => {
      const ev = await createEvent(admin, {capacity: 10, maxPlusOnes: 2});
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('x@example.test', {plusOnes: 3}))).status).toBe(422);
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {plusOnes: 2}))).status).toBe(202);
      expect(await row('a@example.test')).toMatchObject({plusOnes: 2, seats: 3});
    });

    it('enforces required questions except for a decline, and stores answers', async () => {
      const ev = await createEvent(admin);
      const q = await db.rsvpQuestion.create({data: {eventId: ev.id, label: 'Diet', type: 'single_choice', options: ['veg', 'meat'], required: true}});
      const missing = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      expect(missing.status).toBe(422);
      expect(missing.json.fields).toHaveProperty(`answers.${q.id}`);
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('d@example.test', {response: 'not_going'}))).status).toBe(202);
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('ok@example.test', {answers: {[q.id]: 'veg'}}))).status).toBe(202);
      const answers = await db.rsvpAnswer.findMany({where: {rsvpId: (await row('ok@example.test')).id}});
      expect(answers.map(a => a.value)).toEqual(['veg']);
    });

    it('holds guests as pending under approval mode, with no seat', async () => {
      const ev = await createEvent(admin, {capacity: 5, approvalRequired: true});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      expect((await row('a@example.test')).status).toBe('pending');
      expect(((await guest().get(`${R}/${ev.slug}`)).json.event as {seatsLeft: number}).seatsLeft).toBe(5);
    });

    it('rejects an unknown or foreign ticket type', async () => {
      const ev = await createEvent(admin);
      const other = await createEvent(admin, {title: 'Other'});
      const foreign = await db.ticketType.create({data: {eventId: other.id, name: 'X'}});
      for (const id of ['33333333-3333-4333-8333-333333333333', foreign.id]) {
        const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {ticketTypeId: id}));
        expect(res.status).toBe(422);
        expect(res.json.fields).toHaveProperty('ticketTypeId');
      }
    });

    it('ticket quantity: sold out and sales ended are 409', async () => {
      const ev = await createEvent(admin, {capacity: 20});
      const one = await db.ticketType.create({data: {eventId: ev.id, name: 'One', quantity: 1}});
      const ended = await db.ticketType.create({data: {eventId: ev.id, name: 'Ended', salesEndAt: new Date(Date.now() - 1000)}});
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {ticketTypeId: one.id}))).status).toBe(202);
      const soldOut = await guest().post(`${R}/${ev.slug}`, rsvpBody('b@example.test', {ticketTypeId: one.id}));
      expect([soldOut.status, soldOut.json.error]).toEqual([409, 'ticket_sold_out']);
      const late = await guest().post(`${R}/${ev.slug}`, rsvpBody('c@example.test', {ticketTypeId: ended.id}));
      expect([late.status, late.json.error]).toEqual([409, 'ticket_sales_ended']);
    });

    it('needs a live invite for a private event and records the invite as responded', async () => {
      const ev = await createEvent(admin, {visibility: 'private'});
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'))).status).toBe(404);
      const inv = await mkInvite(ev.id, 'a@example.test');
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {inviteToken: inv.token}))).status).toBe(202);
      const r = await row('a@example.test');
      expect(r.inviteId).toBe(inv.id);
      expect(r.source).toBe('invite');
      expect((await db.invite.findUniqueOrThrow({where: {id: inv.id}})).status).toBe('responded');
    });

    it('never confirms two guests for the last seat (US-3)', async () => {
      const ev = await createEvent(admin, {capacity: 1, waitlistEnabled: true});
      const results = await Promise.all(['a', 'b', 'c', 'd'].map(e => guest().post(`${R}/${ev.slug}`, rsvpBody(`${e}@example.test`))));
      expect(results.map(r => r.status)).toEqual([202, 202, 202, 202]);
      expect(await db.rsvp.count({where: {status: 'confirmed'}})).toBe(1);
      expect(await db.rsvp.count({where: {status: 'waitlisted'}})).toBe(3);
    });

    it('rate-limits to 10 RSVPs per minute per IP', async () => {
      const ev = await createEvent(admin, {capacity: null});
      const g = new Browser(eventsApp, '192.0.2.77');
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await g.post(`${R}/${ev.slug}`, rsvpBody(`r${i}@example.test`))).status);
      expect(codes.slice(0, 10).every(c => c === 202)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
      // another address is unaffected
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('other@example.test'))).status).toBe(202);
    });

    it('rejects a non-object body', async () => {
      const ev = await createEvent(admin);
      expect((await guest().post(`${R}/${ev.slug}`, [])).status).toBe(422);
    });
  });

  describe('manage RSVP', () => {
    it('404s for malformed, unknown, hashed and old-style tokens (same body)', async () => {
      const ev = await createEvent(admin);
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const stored = (await row('a@example.test')).manageToken!; // the hash must not work as a token
      const bodies: unknown[] = [];
      for (const t of ['short', 'x'.repeat(40), stored, `${'a'.repeat(30)}.${'b'.repeat(30)}`, 'x'.repeat(200)]) {
        const res = await guest().get(`${M}/${t}`);
        expect(res.status).toBe(404);
        bodies.push(res.json);
      }
      expect(new Set(bodies.map(b => JSON.stringify(b))).size).toBe(1);
      expect((await guest().get(`${M}/${stored}/calendar.ics`)).status).toBe(404);
    });

    it('serves the guest view with no-store, no-referrer headers; joinUrl and ticketCode only once confirmed Going', async () => {
      const ev = await createEvent(admin, {format: 'online', joinUrl: 'https://meet.example.test/x', approvalRequired: true});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const token = await tokenFor('a@example.test');
      const pending = await guest().get(`${M}/${token}`);
      expect(pending.headers.get('cache-control')).toContain('no-store');
      expect(pending.headers.get('referrer-policy')).toBe('no-referrer');
      expect(pending.headers.get('x-robots-tag')).toContain('noindex');
      expect((pending.json.event as {joinUrl: unknown}).joinUrl).toBeNull();
      expect((pending.json.rsvp as {ticketCode: unknown}).ticketCode).toBeNull();
      await db.rsvp.update({where: {id: (await row('a@example.test')).id}, data: {status: 'confirmed'}});
      const ok = await guest().get(`${M}/${token}`);
      expect((ok.json.event as {joinUrl: unknown}).joinUrl).toBe('https://meet.example.test/x');
      expect((ok.json.rsvp as {ticketCode: unknown}).ticketCode).toEqual(expect.any(String));
      expect((ok.json.rsvp as {canEdit: boolean}).canEdit).toBe(true);
      expect((ok.json.calendar as {icsPath: string}).icsPath).toBe(`${M}/${token}/calendar.ics`);
    });

    it('hides joinUrl for in-person events', async () => {
      const ev = await createEvent(admin, {format: 'in_person'});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const view = await guest().get(`${M}/${await tokenFor('a@example.test')}`);
      expect((view.json.event as {joinUrl: unknown}).joinUrl).toBeNull();
    });

    it('a waitlisted guest sees the position and no ticket code', async () => {
      const ev = await createEvent(admin, {capacity: 1});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('b@example.test'));
      const view = await guest().get(`${M}/${await tokenFor('b@example.test')}`);
      expect(view.json.rsvp).toMatchObject({status: 'waitlisted', waitlistPosition: 1, ticketCode: null});
    });

    it('PATCH that needs more seats than are free is event_full and keeps the existing seat', async () => {
      const ev = await createEvent(admin, {capacity: 3, maxPlusOnes: 5});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('b@example.test', {plusOnes: 1}));
      const token = await tokenFor('a@example.test');
      const res = await guest().request('PATCH', `${M}/${token}`, rsvpBody('a@example.test', {plusOnes: 2}));
      expect([res.status, res.json.error]).toEqual([409, 'event_full']);
      expect(await row('a@example.test')).toMatchObject({status: 'confirmed', seats: 1});
    });

    it('PATCH updates the RSVP and keeps the email', async () => {
      const ev = await createEvent(admin, {capacity: 10, maxPlusOnes: 2});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {name: 'Ada'}));
      const token = await tokenFor('a@example.test');
      const res = await guest().request('PATCH', `${M}/${token}`, rsvpBody('hijack@example.test', {name: 'Ada L', plusOnes: 2, marketingConsent: true}));
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ok: true, status: 'confirmed', checkoutUrl: null});
      expect(await row('a@example.test')).toMatchObject({name: 'Ada L', plusOnes: 2, seats: 3, email: 'a@example.test'});
      expect(await db.rsvp.count({where: {email: 'hijack@example.test'}})).toBe(0);
    });

    it('PATCH validates and 404s for a bad token', async () => {
      const ev = await createEvent(admin);
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const token = await tokenFor('a@example.test');
      expect((await guest().request('PATCH', `${M}/${token}`, {name: '', response: 'going'})).status).toBe(422);
      expect((await guest().request('PATCH', `${M}/${'z'.repeat(40)}`, rsvpBody('a@example.test'))).status).toBe(404);
    });

    it('going -> not_going frees the seat and promotes the waitlist', async () => {
      const ev = await createEvent(admin, {capacity: 1});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('b@example.test'));
      const res = await guest().request('PATCH', `${M}/${await tokenFor('a@example.test')}`, rsvpBody('a@example.test', {response: 'not_going'}));
      expect(res.status).toBe(200);
      expect((await row('a@example.test')).status).toBe('declined');
      expect((await row('b@example.test')).status).toBe('confirmed');
    });

    it('cancel on a free event frees the seats and confirms the next waitlisted guest; cancel is idempotent', async () => {
      const ev = await createEvent(admin, {capacity: 1});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('b@example.test'));
      const token = await tokenFor('a@example.test');
      const first = await guest().post(`${M}/${token}/cancel`);
      expect([first.status, first.json]).toEqual([200, {ok: true, status: 'cancelled'}]);
      expect((await row('b@example.test')).status).toBe('confirmed');
      expect((await guest().post(`${M}/${token}/cancel`)).status).toBe(200);
      expect((await row('a@example.test')).status).toBe('cancelled');
      expect((await row('b@example.test')).status).toBe('confirmed');
    });

    it('cancelling a waitlisted guest closes the gap in the line', async () => {
      const ev = await createEvent(admin, {capacity: 1});
      for (const e of ['a', 'b', 'c', 'd']) await guest().post(`${R}/${ev.slug}`, rsvpBody(`${e}@example.test`));
      await guest().post(`${M}/${await tokenFor('c@example.test')}/cancel`);
      expect([(await row('b@example.test')).waitlistPosition, (await row('d@example.test')).waitlistPosition]).toEqual([1, 2]);
      expect((await row('c@example.test')).waitlistPosition).toBeNull();
    });

    it('stops write access 90 days after the event and all access after 180', async () => {
      const ev = await createEvent(admin);
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const token = await tokenFor('a@example.test');
      const endAt = (days: number) => db.event.update({where: {id: ev.id}, data: {endAt: new Date(Date.now() - days * DAY), startAt: new Date(Date.now() - days * DAY - 3600_000)}});
      await endAt(30);
      expect((await guest().get(`${M}/${token}`)).status).toBe(200);
      const late = await guest().request('PATCH', `${M}/${token}`, rsvpBody('a@example.test')); // event over: edits are closed even inside the 90 days
      expect([late.status, late.json.error]).toEqual([409, 'rsvps_closed']);
      await endAt(100);
      expect((await guest().get(`${M}/${token}`)).status).toBe(200);
      expect(((await guest().get(`${M}/${token}`)).json.rsvp as {canEdit: boolean}).canEdit).toBe(false);
      expect((await guest().request('PATCH', `${M}/${token}`, rsvpBody('a@example.test'))).status).toBe(404);
      expect((await guest().post(`${M}/${token}/cancel`)).status).toBe(404);
      expect((await guest().get(`${M}/${token}/calendar.ics`)).status).toBe(200);
      await endAt(200);
      expect((await guest().get(`${M}/${token}`)).status).toBe(404);
      expect((await guest().get(`${M}/${token}/calendar.ics`)).status).toBe(404);
    });

    it('a cancelled event stays viewable but cannot be edited', async () => {
      const ev = await createEvent(admin);
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const token = await tokenFor('a@example.test');
      await db.event.update({where: {id: ev.id}, data: {status: 'cancelled'}});
      const view = await guest().get(`${M}/${token}`);
      expect(view.status).toBe(200);
      expect((view.json.rsvp as {canEdit: boolean}).canEdit).toBe(false);
    });

    it('serves an .ics attachment with UID = rsvp id; CANCEL once the RSVP is cancelled', async () => {
      const ev = await createEvent(admin, {title: 'Launch party'});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const token = await tokenFor('a@example.test');
      const id = (await row('a@example.test')).id;
      const res = await guest().get(`${M}/${token}/calendar.ics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/calendar');
      expect(res.headers.get('content-disposition')).toContain('attachment; filename="');
      const text = res.json.text as string;
      expect(text).toContain(`UID:${id}@events.ezystudio`);
      expect(text).toContain('SUMMARY:Launch party');
      expect(text).toContain('METHOD:PUBLISH');
      await guest().post(`${M}/${token}/cancel`);
      expect(((await guest().get(`${M}/${token}/calendar.ics`)).json.text as string)).toContain('METHOD:CANCEL');
    });

    it('keeps the manage token out of the .ics and the Google Calendar link', async () => {
      const ev = await createEvent(admin);
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const token = await tokenFor('a@example.test');
      const ics = (await guest().get(`${M}/${token}/calendar.ics`)).json.text as string;
      expect(ics).not.toContain(token);
      const view = await guest().get(`${M}/${token}`);
      expect((view.json.calendar as {googleUrl: string}).googleUrl).not.toContain(token);
    });

    it('opening the manage link never confirms marketing consent', async () => {
      const ev = await createEvent(admin);
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {marketingConsent: true}));
      const token = await tokenFor('a@example.test');
      await guest().get(`${M}/${token}`);
      expect(await row('a@example.test')).toMatchObject({marketingConsent: true});
      const r = (await row('a@example.test')) as unknown as Record<string, unknown>;
      if ('consentConfirmedAt' in r) expect(r.consentConfirmedAt).toBeNull();
    });
  });

  describe('POST /rsvp/events/:slug/manage-link', () => {
    it('always answers 202 with the same body, and never rotates without a mail provider (no dead links)', async () => {
      const ev = await createEvent(admin);
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const before = (await row('a@example.test')).manageToken;
      const known = await guest().post(`${R}/${ev.slug}/manage-link`, {email: 'A@Example.test'});
      const unknown = await guest().post(`${R}/${ev.slug}/manage-link`, {email: 'nobody@example.test'});
      const noEvent = await guest().post(`${R}/no-such-event/manage-link`, {email: 'a@example.test'});
      expect([known.status, unknown.status, noEvent.status]).toEqual([202, 202, 202]);
      expect(unknown.json).toEqual(known.json);
      expect(noEvent.json).toEqual(known.json);
      expect((await row('a@example.test')).manageToken).toBe(before); // no mail provider in tests: the working link is kept
      expect(await db.rsvp.count()).toBe(1);
    });

    it('422s a malformed email and rate-limits per IP', async () => {
      const ev = await createEvent(admin);
      expect((await guest().post(`${R}/${ev.slug}/manage-link`, {email: 'nope'})).status).toBe(422);
      expect((await guest().post(`${R}/${ev.slug}/manage-link`, {})).status).toBe(422);
      const g = new Browser(eventsApp, '192.0.2.88');
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await g.post(`${R}/${ev.slug}/manage-link`, {email: 'a@example.test'})).status);
      expect(codes.slice(10)).toEqual([429, 429]);
    });

    it('never rotates the link more than 3 times an hour per event+email', async () => {
      const ev = await createEvent(admin);
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const seen = new Set<string | null>();
      for (let i = 0; i < 6; i++) {
        await guest().post(`${R}/${ev.slug}/manage-link`, {email: 'a@example.test'});
        seen.add((await row('a@example.test')).manageToken);
      }
      // initial create counted 1 toward the cap: at most 3 distinct hashes overall after create
      expect(seen.size).toBeLessThanOrEqual(3);
    });
  });

  describe('GET /rsvp/invite/:token (landing)', () => {
    it('shows the invite and event, lower-cases the email, and flags a repeat responder without a manage token', async () => {
      const ev = await createEvent(admin, {visibility: 'private'});
      const inv = await mkInvite(ev.id, 'Guest@Example.test');
      const res = await guest().get(`/site-api/rsvp/invite/${inv.token}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.json).toMatchObject({invite: {email: 'guest@example.test', token: inv.token}, alreadyResponded: false, event: {slug: ev.slug}});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('guest@example.test', {inviteToken: inv.token}));
      const again = await guest().get(`/site-api/rsvp/invite/${inv.token}`);
      expect(again.json.alreadyResponded).toBe(true);
      expect(JSON.stringify(again.json)).not.toContain((await row('guest@example.test')).manageToken!);
    });

    it('404s for unknown, malformed, bounced and past-event invites', async () => {
      const ev = await createEvent(admin);
      const bounced = await mkInvite(ev.id, 'b@example.test', 'bounced');
      const live = await mkInvite(ev.id, 'l@example.test');
      expect((await guest().get('/site-api/rsvp/invite/nonexistent-invite')).status).toBe(404);
      expect((await guest().get('/site-api/rsvp/invite/x')).status).toBe(404);
      expect((await guest().get(`/site-api/rsvp/invite/${bounced.token}`)).status).toBe(404);
      await db.event.update({where: {id: ev.id}, data: {endAt: new Date(Date.now() - DAY), startAt: new Date(Date.now() - 2 * DAY)}});
      expect((await guest().get(`/site-api/rsvp/invite/${live.token}`)).status).toBe(404);
    });
  });

  describe('paid tickets (audit)', () => {
    afterAll(() => setPaidCheckoutHook(null));

    it('a paid ticket with no payment hook is 409 payments_unavailable and holds nothing', async () => {
      setPaidCheckoutHook(null);
      const ev = await createEvent(admin, {capacity: 5});
      const t = await db.ticketType.create({data: {eventId: ev.id, name: 'VIP', priceCents: 5000}});
      const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {ticketTypeId: t.id}));
      expect([res.status, res.json.error]).toEqual([409, 'payments_unavailable']);
      expect(await db.rsvp.count({where: {status: {in: ['confirmed', 'awaiting_payment']}}})).toBe(0);
    });

    it('with a hook: 202 check_email + checkoutUrl, seat held awaiting_payment, no ticket code revealed', async () => {
      setPaidCheckoutHook(async ({rsvp, manageToken}) => (manageToken.length >= 32 ? {checkoutUrl: `/pay/${rsvp.id}`} : null));
      const ev = await createEvent(admin, {capacity: 5});
      const t = await db.ticketType.create({data: {eventId: ev.id, name: 'VIP', priceCents: 5000}});
      const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {ticketTypeId: t.id}));
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({status: 'check_email', checkoutUrl: expect.stringMatching(/^\/pay\//)});
      expect((await row('a@example.test')).status).toBe('awaiting_payment');
      const view = await guest().get(`${R}/${ev.slug}`);
      expect((view.json.event as {seatsLeft: number}).seatsLeft).toBe(4);
      const manage = await guest().get(`${M}/${await tokenFor('a@example.test')}`);
      expect((manage.json.rsvp as {ticketCode: unknown}).ticketCode).toBeNull();
    });

    it('a failed checkout releases the held seat', async () => {
      setPaidCheckoutHook(async () => null);
      const ev = await createEvent(admin, {capacity: 1});
      const t = await db.ticketType.create({data: {eventId: ev.id, name: 'VIP', priceCents: 5000}});
      const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {ticketTypeId: t.id}));
      expect(res.status).toBe(409);
      expect(((await guest().get(`${R}/${ev.slug}`)).json.event as {seatsLeft: number}).seatsLeft).toBe(1);
    });
  });
});
