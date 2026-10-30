import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {createEvent, eventsApp, resetEvents, rsvpBody, userWith} from './support/events-fixtures';
import {hashToken, newToken} from '../../src/domain/secureToken';
import {setPaidCheckoutHook} from '../../src/server/routes/rsvp';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

const R = '/site-api/rsvp/events';
let n = 30;

/** The manage token is stored hashed and mailed, never returned: tests install a known one. */
async function tokenFor(email: string) {
  const token = newToken();
  await db.rsvp.update({where: {eventId_email: {eventId: (await db.rsvp.findFirstOrThrow({where: {email}})).eventId, email}}, data: {manageToken: hashToken(token)}});
  return token;
}
const guest = () => new Browser(eventsApp, `203.0.113.${n++}`);

describe.skipIf(!DATABASE_URL)('events guest flows (integration, real Postgres)', () => {
  let admin: Browser;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    await userWith('first@example.test', ['owner'], '203.0.113.1');
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
  });

  it('RSVP fills capacity then waitlists, and a cancel promotes the waitlisted guest', async () => {
    const ev = await createEvent(admin, {capacity: 2, waitlistEnabled: true});
    const a = await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'));
    const b = await guest().post(`${R}/${ev.slug}`, rsvpBody('b@example.test'));
    const c = await guest().post(`${R}/${ev.slug}`, rsvpBody('c@example.test'));
    expect([a.status, b.status, c.status]).toEqual([202, 202, 202]);
    // Same answer for everyone, and no manage link in it: no way to tell a new email from an existing one.
    for (const r of [a, b, c]) expect(r.json).toEqual({status: 'check_email', checkoutUrl: null, message: expect.any(String)});
    expect((await db.rsvp.findFirstOrThrow({where: {email: 'c@example.test'}})).status).toBe('waitlisted');

    const token = await tokenFor('a@example.test');
    const cancel = await guest().post(`/site-api/rsvp/manage/${token}/cancel`);
    expect(cancel.status).toBe(200);
    const promoted = await db.rsvp.findFirstOrThrow({where: {email: 'c@example.test'}});
    expect(promoted.status).toBe('confirmed');
  });

  it('without a waitlist a full event refuses, and a duplicate email creates no second RSVP', async () => {
    const ev = await createEvent(admin, {capacity: 1, waitlistEnabled: false});
    expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('a@example.test'))).status).toBe(202);
    const full = await guest().post(`${R}/${ev.slug}`, rsvpBody('b@example.test'));
    expect(full.status).toBeGreaterThanOrEqual(400);
    expect(await db.rsvp.count({where: {email: 'b@example.test'}})).toBe(0);
    const dup = await guest().post(`${R}/${ev.slug}`, rsvpBody('A@example.test'));
    expect(dup.status).toBe(202);
    expect(dup.json.status).toBe('check_email');
    expect(await db.rsvp.count()).toBe(1);
  });

  it('validates the RSVP and 404s for unpublished events', async () => {
    const draft = await createEvent(admin, {}, false);
    expect((await guest().post(`${R}/${draft.slug}`, rsvpBody('a@example.test'))).status).toBe(404);
    const ev = await createEvent(admin, {title: 'Second'});
    const bad = await guest().post(`${R}/${ev.slug}`, {name: '', email: 'nope', response: 'going'});
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.json.fields as object)).toEqual(expect.arrayContaining(['name', 'email']));
    expect((await guest().post(`${R}/${ev.slug}`, rsvpBody('x@example.test', {plusOnes: 3}))).status).toBe(422);
  });

  it('polls: one open per event, voting, and no votes once closed', async () => {
    const ev = await createEvent(admin);
    const P = '/site-api/admin-polls';
    type PollDto = {id: string; options: {id: string}[]};
    const mk = async (q: string) =>
      (await admin.post(`${P}/event/${ev.id}`, {question: q, type: 'single_choice', options: ['Yes', 'No']})).json.poll as PollDto;
    const p1 = await mk('One?');
    const p2 = await mk('Two?');
    expect((await new Browser(eventsApp, '203.0.113.9').post(`${P}/event/${ev.id}`, {})).status).toBe(401);
    expect((await admin.post(`${P}/${p1.id}/open`)).status).toBe(200);
    expect((await admin.post(`${P}/${p2.id}/open`)).status).toBe(200);
    const rows = await db.poll.findMany({where: {eventId: ev.id}, select: {id: true, status: true}});
    expect(rows.filter(s => s.status === 'open').map(s => s.id)).toEqual([p2.id]);

    const code = (await db.event.findUniqueOrThrow({where: {id: ev.id}})).pollJoinCode;
    const V = `/site-api/polls-public/${code}`;
    const voter = guest();
    expect((await voter.get(`${V}/active`)).json.status).toBe('open');
    const vote = await voter.post(`${V}/votes`, {pollId: p2.id, optionIds: [p2.options[0]!.id]});
    expect(vote.status).toBe(200);
    expect(await db.pollVote.count({where: {pollId: p2.id}})).toBe(1);
    const late = await voter.post(`${V}/votes`, {pollId: p1.id, optionIds: [p1.options[0]!.id]});
    expect(late.status).toBe(409);
    expect((await voter.post('/site-api/polls-public/NOSUCH/votes', {pollId: p2.id})).status).toBe(404);
    expect((await admin.post(`${P}/${p2.id}/close`)).status).toBe(200);
    const after = await voter.post(`${V}/votes`, {pollId: p2.id, optionIds: [p2.options[1]!.id]});
    expect(after.status).toBe(409);
  });

  it('privacy: manage token reads, exports and erases; a bad token is a 404; unsubscribe works', async () => {
    const ev = await createEvent(admin);
    const made = await guest().post(`${R}/${ev.slug}`, rsvpBody('p@example.test', {marketingConsent: true}));
    expect(made.status).toBe(202);
    expect(made.json.managePath).toBeUndefined();
    const token = await tokenFor('p@example.test');
    const g = guest();
    const PR = '/site-api/privacy';
    expect((await g.get(`${PR}/guest/${'x'.repeat(40)}`)).status).toBe(404);
    expect((await g.get(`${PR}/guest/${token}`)).status).toBe(200);
    const exp = await g.get(`${PR}/guest/${token}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-disposition')).toContain('attachment');
    expect((await g.get(`${PR}/unsubscribe/${token}`)).status).toBe(200);
    expect((await g.post(`${PR}/unsubscribe/${token}`)).status).toBe(200);
    expect((await g.post(`${PR}/guest/${token}/erase`, {confirm: 'no'})).status).toBe(422);
    expect(await db.rsvp.count()).toBe(1);
    expect((await g.post(`${PR}/guest/${token}/erase`, {confirm: 'erase'})).status).toBe(200);
    // Erasure anonymises the row (kept for counts): the address and the token no longer match.
    expect(await db.rsvp.count({where: {email: 'p@example.test'}})).toBe(0);
    expect((await g.get(`${PR}/guest/${token}`)).status).toBe(404);
  });

  describe('paid tickets and Maybe', () => {
    afterAll(() => setPaidCheckoutHook(null));
    const paidEvent = async () => {
      setPaidCheckoutHook(async ({rsvp}) => ({checkoutUrl: `/pay/${rsvp.id}`}));
      const ev = await createEvent(admin, {capacity: 5, allowMaybe: true});
      const ticket = await db.ticketType.create({data: {eventId: ev.id, name: 'VIP', priceCents: 5000, currency: 'USD'}});
      return {ev, ticket};
    };

    it('H1: Maybe then Going on a paid ticket does NOT skip payment', async () => {
      const {ev, ticket} = await paidEvent();
      const maybe = await guest().post(`${R}/${ev.slug}`, rsvpBody('m@example.test', {response: 'maybe', ticketTypeId: ticket.id}));
      expect(maybe.status).toBe(202);
      expect(maybe.json.checkoutUrl).toBeNull();
      const token = await tokenFor('m@example.test');
      const row = () => db.rsvp.findFirstOrThrow({where: {email: 'm@example.test'}});
      expect((await row()).ticketTypeId).toBeNull(); // a Maybe implies no ticket

      const g = guest();
      // No ticket chosen: refused, still a Maybe.
      const noTicket = await g.request('PATCH', `/site-api/rsvp/manage/${token}`, rsvpBody('m@example.test', {response: 'going'}));
      expect(noTicket.status).toBe(422);
      expect((await row()).response).toBe('maybe');

      const going = await g.request('PATCH', `/site-api/rsvp/manage/${token}`, rsvpBody('m@example.test', {response: 'going', ticketTypeId: ticket.id}));
      expect(going.status).toBe(200);
      expect(going.json.status).toBe('awaiting_payment');
      expect(going.json.checkoutUrl).toMatch(/^[/]pay[/]/);
      expect((await row()).status).toBe('awaiting_payment');
    });

    it('H1: if checkout cannot start, the edit is reverted to the Maybe', async () => {
      const {ev, ticket} = await paidEvent();
      await guest().post(`${R}/${ev.slug}`, rsvpBody('r@example.test', {response: 'maybe'}));
      const token = await tokenFor('r@example.test');
      setPaidCheckoutHook(async () => null);
      const res = await guest().request('PATCH', `/site-api/rsvp/manage/${token}`, rsvpBody('r@example.test', {response: 'going', ticketTypeId: ticket.id}));
      expect(res.status).toBe(409);
      const row = await db.rsvp.findFirstOrThrow({where: {email: 'r@example.test'}});
      expect([row.response, row.status, row.ticketTypeId]).toEqual(['maybe', 'confirmed', null]);
    });

    it('a Maybe sees no ticket code and no join link in the manage view', async () => {
      const ev = await createEvent(admin, {allowMaybe: true, format: 'online', joinUrl: 'https://meet.example.test/x'});
      await guest().post(`${R}/${ev.slug}`, rsvpBody('v@example.test', {response: 'maybe'}));
      const token = await tokenFor('v@example.test');
      const view = await guest().get(`/site-api/rsvp/manage/${token}`);
      expect((view.json.rsvp as {ticketCode: unknown}).ticketCode).toBeNull();
      expect((view.json.event as {joinUrl: unknown}).joinUrl).toBeNull();
      await guest().request('PATCH', `/site-api/rsvp/manage/${token}`, rsvpBody('v@example.test', {response: 'going'}));
      const going = await guest().get(`/site-api/rsvp/manage/${token}`);
      expect((going.json.rsvp as {ticketCode: unknown}).ticketCode).toEqual(expect.any(String));
    });
  });
});
