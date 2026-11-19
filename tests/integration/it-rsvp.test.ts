import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {ticketCode} from '../../src/domain/codes';
import {hashToken, newToken} from '../../src/domain/secureToken';
import {setPaidCheckoutHook} from '../../src/server/routes/rsvp';
import {createEvent, eventsApp, resetEvents, rsvpBody, userWith} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

/**
 * Audit fixes in the public RSVP routes: open paid-waitlist claims hold seats (M-10), a failed checkout
 * start discards the new row (M-1), re-RSVP after declining or cancelling (M-11), private invites bound
 * to their email (M-5), promotion keeps a working link without a mail provider (M-8), and no manage
 * link in the Google Calendar URL of a private event.
 */
const R = '/site-api/rsvp/events';
const M = '/site-api/rsvp/manage';
const MINUTE = 60_000;
let n = 10;
const guest = () => new Browser(eventsApp, `198.51.100.${n++ % 250}`);

const row = (email: string) => db.rsvp.findFirstOrThrow({where: {email}});
/** Gives the guest a manage token we know (only its hash is stored, as the route stores it). */
async function tokenFor(email: string) {
  const token = newToken();
  await db.rsvp.update({where: {id: (await row(email)).id}, data: {manageToken: hashToken(token)}});
  return token;
}
let inviteN = 0;
const mkInvite = (eventId: string, email: string, status: 'queued' | 'sent' | 'bounced' | 'responded' = 'sent', sentAt: Date | null = new Date()) =>
  db.invite.create({data: {eventId, email, token: `inv-it-${Date.now()}-${inviteN++}-${newToken().slice(0, 10)}`, status, sentAt}});

type View = {seatsLeft: number | null; ticketTypes: {id: string; name: string; remaining: number | null}[]};
const viewOf = async (slug: string, query = '') => {
  const res = await guest().get(`${R}/${slug}${query}`);
  expect(res.status).toBe(200);
  return res.json.event as View;
};

/** A waitlisted guest holding an open (or expired) paid-waitlist claim, seeded straight in the table. */
const seedClaim = (eventId: string, email: string, over: {seats?: number; ticketTypeId?: string | null; claimExpiresAt: Date; position?: number}) =>
  db.rsvp.create({
    data: {
      eventId,
      email,
      name: email.split('@')[0],
      response: 'going',
      status: 'waitlisted',
      seats: over.seats ?? 1,
      plusOnes: (over.seats ?? 1) - 1,
      ticketTypeId: over.ticketTypeId ?? null,
      waitlistPosition: over.position ?? 1,
      claimExpiresAt: over.claimExpiresAt,
      ticketCode: ticketCode(),
      manageToken: hashToken(newToken()),
    },
  });

describe.skipIf(!DATABASE_URL)('RSVP audit fixes (integration, real Postgres)', () => {
  let admin: Browser;
  beforeAll(configureEnv);
  afterAll(async () => {
    setPaidCheckoutHook(null);
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
  });
  afterEach(() => setPaidCheckoutHook(null));

  describe('seats left and ticket remaining count open paid-waitlist claims (M-10)', () => {
    it('subtracts an open claim from seatsLeft and from its ticket type; an expired claim holds nothing', async () => {
      const ev = await createEvent(admin, {capacity: 10, maxPlusOnes: 3});
      const vip = await db.ticketType.create({data: {eventId: ev.id, name: 'VIP', quantity: 5, priceCents: 2000}});
      const std = await db.ticketType.create({data: {eventId: ev.id, name: 'Std', quantity: 4}});
      expect(await viewOf(ev.slug)).toMatchObject({seatsLeft: 10});

      await seedClaim(ev.id, 'claim@example.test', {seats: 2, ticketTypeId: vip.id, claimExpiresAt: new Date(Date.now() + 30 * MINUTE)});
      const v1 = await viewOf(ev.slug);
      expect(v1.seatsLeft).toBe(8);
      const by1 = Object.fromEntries(v1.ticketTypes.map(t => [t.name, t.remaining]));
      expect(by1).toEqual({VIP: 3, Std: 4});

      // An expired claim and a plain waitlisted guest (no claim) hold no seat.
      await seedClaim(ev.id, 'old@example.test', {seats: 3, ticketTypeId: vip.id, claimExpiresAt: new Date(Date.now() - MINUTE), position: 2});
      const v2 = await viewOf(ev.slug);
      expect(v2.seatsLeft).toBe(8);
      expect(Object.fromEntries(v2.ticketTypes.map(t => [t.name, t.remaining]))).toEqual({VIP: 3, Std: 4});

      // A confirmed guest on Std adds to it; the claim on VIP stays counted.
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('s@example.test', {ticketTypeId: std.id, plusOnes: 1}))).status).toBe(202);
      const v3 = await viewOf(ev.slug);
      expect(v3.seatsLeft).toBe(6);
      expect(Object.fromEntries(v3.ticketTypes.map(t => [t.name, t.remaining]))).toEqual({VIP: 3, Std: 2});
    });

    it('a claim that holds the last seats makes a new RSVP wait, not take them', async () => {
      const ev = await createEvent(admin, {capacity: 2, waitlistEnabled: true});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      await seedClaim(ev.id, 'claim@example.test', {seats: 1, claimExpiresAt: new Date(Date.now() + 30 * MINUTE)});
      expect((await viewOf(ev.slug)).seatsLeft).toBe(0);
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('late@example.test'))).status).toBe(202);
      expect((await row('late@example.test')).status).toBe('waitlisted');
      expect(await db.rsvp.count({where: {eventId: ev.id, status: 'confirmed'}})).toBe(1);
    });

    it('never reports a negative seatsLeft or remaining when claims exceed what is free', async () => {
      const ev = await createEvent(admin, {capacity: 1});
      const t = await db.ticketType.create({data: {eventId: ev.id, name: 'One', quantity: 1, priceCents: 1000}});
      await seedClaim(ev.id, 'c1@example.test', {seats: 2, ticketTypeId: t.id, claimExpiresAt: new Date(Date.now() + MINUTE)});
      const v = await viewOf(ev.slug);
      expect(v.seatsLeft).toBe(0);
      expect(v.ticketTypes[0]!.remaining).toBe(0);
    });
  });

  describe('a failed checkout start discards the new RSVP (M-1)', () => {
    it('deletes the row, frees the seat, and a retry with working payments succeeds', async () => {
      const ev = await createEvent(admin, {capacity: 1});
      const t = await db.ticketType.create({data: {eventId: ev.id, name: 'VIP', priceCents: 5000}});

      setPaidCheckoutHook(async () => null);
      const first = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {ticketTypeId: t.id}));
      expect([first.status, first.json.error]).toEqual([409, 'payments_unavailable']);
      expect(await db.rsvp.count({where: {email: 'a@example.test'}})).toBe(0);
      expect((await viewOf(ev.slug)).seatsLeft).toBe(1);

      // A hook that throws is the same failure.
      setPaidCheckoutHook(async () => {
        throw new Error('platform blip');
      });
      const second = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {ticketTypeId: t.id}));
      expect(second.status).toBe(409);
      expect(await db.rsvp.count({where: {email: 'a@example.test'}})).toBe(0);

      setPaidCheckoutHook(async ({rsvp}) => ({checkoutUrl: `/pay/${rsvp.id}`}));
      const retry = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {ticketTypeId: t.id}));
      expect(retry.status).toBe(202);
      expect(retry.json.checkoutUrl).toEqual(expect.stringMatching(/^\/pay\//));
      expect(await row('a@example.test')).toMatchObject({status: 'awaiting_payment', seats: 1});
      expect((await viewOf(ev.slug)).seatsLeft).toBe(0);
    });

    it('puts a private invite back to its earlier status (sent / queued), and the invite still works for a retry', async () => {
      const ev = await createEvent(admin, {capacity: 5, visibility: 'private'});
      const t = await db.ticketType.create({data: {eventId: ev.id, name: 'VIP', priceCents: 5000}});
      const sent = await mkInvite(ev.id, 'sent@example.test', 'sent');
      const queued = await mkInvite(ev.id, 'queued@example.test', 'queued', null);

      setPaidCheckoutHook(async () => null);
      for (const inv of [sent, queued]) {
        const res = await guest().post(`${R}/${ev.slug}`, rsvpBody(inv.email, {ticketTypeId: t.id, inviteToken: inv.token}));
        expect([res.status, res.json.error]).toEqual([409, 'payments_unavailable']);
      }
      expect((await db.invite.findUniqueOrThrow({where: {id: sent.id}})).status).toBe('sent');
      expect((await db.invite.findUniqueOrThrow({where: {id: queued.id}})).status).toBe('queued');
      expect(await db.rsvp.count({where: {eventId: ev.id}})).toBe(0);
      // The invite landing does not claim the guest already responded.
      expect((await guest().get(`/site-api/rsvp/invite/${sent.token}`)).json.alreadyResponded).toBe(false);

      setPaidCheckoutHook(async ({rsvp}) => ({checkoutUrl: `/pay/${rsvp.id}`}));
      const retry = await guest().post(`${R}/${ev.slug}`, rsvpBody(sent.email, {ticketTypeId: t.id, inviteToken: sent.token}));
      expect(retry.status).toBe(202);
      expect(await row(sent.email)).toMatchObject({status: 'awaiting_payment', inviteId: sent.id});
      expect((await db.invite.findUniqueOrThrow({where: {id: sent.id}})).status).toBe('responded');
    });

    it('leaves neither an awaiting_payment nor a cancelled row behind', async () => {
      const ev = await createEvent(admin, {capacity: 1});
      const t = await db.ticketType.create({data: {eventId: ev.id, name: 'VIP', priceCents: 5000}});
      setPaidCheckoutHook(async () => null);
      expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {ticketTypeId: t.id}))).status).toBe(409);
      expect(await db.rsvp.count({where: {eventId: ev.id, status: {in: ['awaiting_payment', 'cancelled']}}})).toBe(0);
    });
  });

  describe('a declined or cancelled guest can RSVP again from the manage page (M-11)', () => {
    it('declined -> going confirms again and takes a seat', async () => {
      const ev = await createEvent(admin, {capacity: 2});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {response: 'not_going'}));
      const token = await tokenFor('a@example.test');
      const view = await guest().get(`${M}/${token}`);
      expect(view.json.rsvp).toMatchObject({status: 'declined', canEdit: true});
      const res = await guest().request('PATCH', `${M}/${token}`, rsvpBody('a@example.test'));
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ok: true, status: 'confirmed'});
      expect(await row('a@example.test')).toMatchObject({status: 'confirmed', response: 'going', seats: 1});
      expect((await viewOf(ev.slug)).seatsLeft).toBe(1);
    });

    it('cancelled -> going confirms again; on a full event it joins the back of the waitlist', async () => {
      const ev = await createEvent(admin, {capacity: 1, waitlistEnabled: true});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      const token = await tokenFor('a@example.test');
      expect((await guest().post(`${M}/${token}/cancel`)).status).toBe(200);
      expect((await guest().get(`${M}/${token}`)).json.rsvp).toMatchObject({status: 'cancelled', canEdit: true});
      const again = await guest().request('PATCH', `${M}/${token}`, rsvpBody('a@example.test'));
      expect([again.status, again.json.status]).toEqual([200, 'confirmed']);

      // a holds the seat; b and c wait; a cancels again (b promoted), then a re-RSVPs and waits behind c.
      await guest().post(`${R}/${ev.slug}`, rsvpBody('b@example.test'));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('c@example.test'));
      expect((await guest().post(`${M}/${token}/cancel`)).status).toBe(200);
      expect((await row('b@example.test')).status).toBe('confirmed');
      const back = await guest().request('PATCH', `${M}/${token}`, rsvpBody('a@example.test'));
      expect([back.status, back.json.status]).toEqual([200, 'waitlisted']);
      expect((await row('c@example.test')).waitlistPosition).toBe(1);
      expect((await row('a@example.test')).waitlistPosition).toBe(2);
    });

    it('with approval on, a declined or cancelled guest who RSVPs again goes back to pending', async () => {
      const ev = await createEvent(admin, {capacity: 5, approvalRequired: true});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('d@example.test', {response: 'not_going'}));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('c@example.test'));
      // The host approved c; c then cancelled.
      await db.rsvp.update({where: {id: (await row('c@example.test')).id}, data: {status: 'confirmed', confirmedAt: new Date()}});
      const ct = await tokenFor('c@example.test');
      expect((await guest().post(`${M}/${ct}/cancel`)).status).toBe(200);

      for (const email of ['d@example.test', 'c@example.test']) {
        const token = email === 'c@example.test' ? ct : await tokenFor(email);
        const res = await guest().request('PATCH', `${M}/${token}`, rsvpBody(email));
        expect([email, res.status, res.json.status]).toEqual([email, 200, 'pending']);
        expect(await row(email)).toMatchObject({status: 'pending', response: 'going'});
      }
      expect((await viewOf(ev.slug)).seatsLeft).toBe(5);
    });

    it('re-RSVP is refused once the event is cancelled', async () => {
      const ev = await createEvent(admin);
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test', {response: 'not_going'}));
      const token = await tokenFor('a@example.test');
      await db.event.update({where: {id: ev.id}, data: {status: 'cancelled'}});
      expect(((await guest().get(`${M}/${token}`)).json.rsvp as {canEdit: boolean}).canEdit).toBe(false);
      const res = await guest().request('PATCH', `${M}/${token}`, rsvpBody('a@example.test'));
      expect([res.status, res.json.error]).toEqual([409, 'event_cancelled']);
      expect((await row('a@example.test')).status).toBe('declined');
    });
  });

  describe('a private invite is bound to its email (M-5)', () => {
    it('rejects a different email with 422 on the email field and stores nothing', async () => {
      const ev = await createEvent(admin, {visibility: 'private'});
      const inv = await mkInvite(ev.id, 'Invited@Example.test');
      const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('stranger@example.test', {inviteToken: inv.token}));
      expect(res.status).toBe(422);
      expect(res.json.fields).toHaveProperty('email');
      expect(await db.rsvp.count({where: {eventId: ev.id}})).toBe(0);
      expect((await db.invite.findUniqueOrThrow({where: {id: inv.id}})).status).toBe('sent');
    });

    it('accepts the invited email in any case and links the RSVP to the invite', async () => {
      const ev = await createEvent(admin, {visibility: 'private'});
      const inv = await mkInvite(ev.id, 'Invited@Example.test');
      const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('  INVITED@example.TEST ', {inviteToken: inv.token}));
      expect(res.status).toBe(202);
      expect(await row('invited@example.test')).toMatchObject({inviteId: inv.id, source: 'invite', status: 'confirmed'});
      expect((await db.invite.findUniqueOrThrow({where: {id: inv.id}})).status).toBe('responded');
      // A second person forwarding the same link is still refused.
      const fwd = await guest().post(`${R}/${ev.slug}`, rsvpBody('friend@example.test', {inviteToken: inv.token}));
      expect(fwd.status).toBe(422);
      expect(await db.rsvp.count({where: {eventId: ev.id}})).toBe(1);
    });

    it('on a public event a different email still RSVPs, just not credited to the invite', async () => {
      const ev = await createEvent(admin);
      const inv = await mkInvite(ev.id, 'invited@example.test');
      const res = await guest().post(`${R}/${ev.slug}`, rsvpBody('other@example.test', {inviteToken: inv.token}));
      expect(res.status).toBe(202);
      expect(await row('other@example.test')).toMatchObject({inviteId: null, source: 'direct'});
      expect((await db.invite.findUniqueOrThrow({where: {id: inv.id}})).status).toBe('sent');
    });
  });

  describe('a promoted guest keeps a working link with no mail provider (M-8)', () => {
    it('after a cancel promotes them, their old manage link still opens their (now confirmed) RSVP', async () => {
      const ev = await createEvent(admin, {capacity: 1});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('b@example.test'));
      const bToken = await tokenFor('b@example.test');
      const bHash = (await row('b@example.test')).manageToken;
      expect((await guest().get(`${M}/${bToken}`)).json.rsvp).toMatchObject({status: 'waitlisted'});

      expect((await guest().post(`${M}/${await tokenFor('a@example.test')}/cancel`)).status).toBe(200);
      const view = await guest().get(`${M}/${bToken}`);
      expect(view.status).toBe(200);
      expect(view.json.rsvp).toMatchObject({status: 'confirmed', ticketCode: expect.any(String)});
      expect((await row('b@example.test')).manageToken).toBe(bHash);
    });

    it('after a decline frees the seat and promotes them, their old link and .ics still work', async () => {
      const ev = await createEvent(admin, {capacity: 1});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
      await guest().post(`${R}/${ev.slug}`, rsvpBody('b@example.test'));
      const bToken = await tokenFor('b@example.test');
      // A seat frees when another guest declines through the manage page (a PATCH, not a cancel).
      const aToken = await tokenFor('a@example.test');
      expect((await guest().request('PATCH', `${M}/${aToken}`, rsvpBody('a@example.test', {response: 'not_going'}))).status).toBe(200);
      expect((await row('b@example.test')).status).toBe('confirmed');
      expect((await guest().get(`${M}/${bToken}`)).status).toBe(200);
      expect((await guest().get(`${M}/${bToken}/calendar.ics`)).status).toBe(200);
    });
  });

  describe('Google Calendar link', () => {
    it('never contains /r/ (the manage link) for a private event; a public one links its event page', async () => {
      const priv = await createEvent(admin, {title: 'Secret', visibility: 'private'});
      const inv = await mkInvite(priv.id, 'p@example.test');
      expect((await guest().post(`${R}/${priv.slug}`, rsvpBody('p@example.test', {inviteToken: inv.token}))).status).toBe(202);
      const pToken = await tokenFor('p@example.test');
      const pView = await guest().get(`${M}/${pToken}`);
      expect(pView.status).toBe(200);
      const pUrl = (pView.json.calendar as {googleUrl: string}).googleUrl;
      expect(pUrl).toEqual(expect.any(String));
      expect(pUrl).not.toContain('/r/');
      expect(decodeURIComponent(pUrl)).not.toContain('/r/');
      expect(decodeURIComponent(pUrl)).not.toContain(pToken);
      expect(decodeURIComponent(pUrl)).not.toContain(`/events/${priv.slug}`);

      const pub = await createEvent(admin, {title: 'Open'});
      await guest().post(`${R}/${pub.slug}`, rsvpBody('o@example.test'));
      const oToken = await tokenFor('o@example.test');
      const oUrl = decodeURIComponent(((await guest().get(`${M}/${oToken}`)).json.calendar as {googleUrl: string}).googleUrl);
      expect(oUrl).not.toContain('/r/');
      expect(oUrl).not.toContain(oToken);
      expect(oUrl).toContain(`/events/${pub.slug}/`);
    });
  });
});
