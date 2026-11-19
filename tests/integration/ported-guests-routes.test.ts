import {randomBytes, randomUUID} from 'node:crypto';

import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {hashToken, newToken} from '../../src/domain/secureToken';
import {authRoutes} from '../../src/platform/auth';
import {csrf, previewCookies, sameOrigin} from '../../src/platform/guards';
import {syncPermissions} from '../../src/platform/permission-sync';
import {authSettings} from '../../src/server/auth-settings';
import {CATALOGUE} from '../../src/server/permissions';
import {adminEventRoutes} from '../../src/server/routes/admin-events';
import {adminGuestRoutes} from '../../src/server/routes/admin-guests';
import {privacyRoutes} from '../../src/server/routes/privacy';
import {createEvent, resetEvents, setRoles} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

const app = new Hono()
  .basePath('/site-api')
  .use(previewCookies)
  .use(sameOrigin)
  .use(csrf)
  .use(bodyLimit({maxSize: 64 * 1024}))
  .use(syncPermissions(CATALOGUE))
  .route('/auth', authRoutes(authSettings))
  .route('/admin-events', adminEventRoutes)
  .route('/event-admin', adminGuestRoutes)
  .route('/privacy', privacyRoutes);

const G = '/site-api/event-admin';
const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 9, minute));
const csvLines = (text: string) => text.replace(/^﻿/, '').trim().split(/\r?\n/);

describe.skipIf(!DATABASE_URL)('ported guests routes (integration, real Postgres)', () => {
  let admin: Browser;
  let staff: Browser;
  let member: Browser;
  let adminId: number;

  async function userOnApp(email: string, roles: string[], ip: string) {
    const b = await signedIn(app, email, undefined, ip);
    await setRoles(email, ...roles);
    return b;
  }

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    admin = await userOnApp('admin@example.test', ['admin'], '203.0.113.2');
    staff = await userOnApp('staff@example.test', ['checkin-staff'], '203.0.113.3');
    member = await userOnApp('member@example.test', ['member'], '203.0.113.4');
    adminId = (await db.user.findFirstOrThrow({where: {email: 'admin@example.test'}})).id;
  });

  async function mkEvent(over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
    const ev = await createEvent(admin, over);
    if (Object.keys(settings).length) await db.event.update({where: {id: ev.id}, data: settings});
    return ev;
  }

  let seq = 0;
  async function seed(eventId: string, over: Record<string, unknown> = {}) {
    seq++;
    return db.rsvp.create({
      data: {
        eventId,
        name: `Guest ${seq}`,
        email: `guest${seq}@example.test`,
        response: 'going',
        status: 'confirmed',
        confirmedAt: new Date(),
        ticketCode: randomBytes(4).toString('hex').toUpperCase(),
        manageToken: hashToken(newToken()),
        ...over,
      } as never,
    });
  }

  const listOf = (eventId: string, qs = '') => admin.get(`${G}/events/${eventId}/guests${qs ? `?${qs}` : ''}`);
  const names = async (eventId: string, qs: string) => ((await listOf(eventId, qs)).json.items as {name: string}[]).map(g => g.name).sort();
  const bulk = (eventId: string, action: string, rsvpIds: string[]) => admin.post(`${G}/events/${eventId}/guests/bulk`, {action, rsvpIds});
  const patch = (eventId: string, id: string, body: unknown) => admin.request('PATCH', `${G}/events/${eventId}/guests/${id}`, body);
  const audits = (action: string) => db.auditEvent.findMany({where: {action}});

  it('gates on event manage: 401 anonymous, 403 staff and member, 200 admin, 404 bad event id', async () => {
    const ev = await mkEvent();
    const anon = new Browser(app, '203.0.113.9');
    const path = `${G}/events/${ev.id}/guests`;
    expect((await anon.get(path)).status).toBe(401);
    expect((await staff.get(path)).status).toBe(403);
    expect((await member.get(path)).status).toBe(403);
    expect((await staff.post(`${path}/bulk`, {action: 'remove', rsvpIds: [randomUUID()]})).status).toBe(403);
    expect((await anon.get(`${G}/contacts`)).status).toBe(401);
    expect((await staff.get(`${G}/contacts/export.csv`)).status).toBe(403);
    expect((await admin.get(path)).status).toBe(200);
    expect((await admin.get(`${G}/events/not-a-uuid/guests`)).status).toBe(404);
    expect((await admin.get(`${G}/events/${randomUUID()}/guests`)).status).toBe(404);
  });

  it('pages 50 at a time newest first with a keyset cursor', async () => {
    const ev = await mkEvent();
    await db.rsvp.createMany({
      data: Array.from({length: 60}, (_, i) => ({
        eventId: ev.id,
        name: `Guest ${i}`,
        email: `p${i}@example.test`,
        response: 'going' as const,
        status: 'confirmed' as const,
        ticketCode: `P${String(i).padStart(7, '0')}`,
        manageToken: hashToken(`t${i}`),
        createdAt: at(i),
      })),
    });
    const p1 = await listOf(ev.id);
    const items1 = p1.json.items as {name: string}[];
    expect(items1).toHaveLength(50);
    expect(items1[0]!.name).toBe('Guest 59');
    expect(p1.json.statusCounts).toEqual({confirmed: 60});
    const p2 = await listOf(ev.id, `before=${encodeURIComponent(p1.json.nextBefore as string)}`);
    expect((p2.json.items as {name: string}[]).map(g => g.name)).toEqual(Array.from({length: 10}, (_, i) => `Guest ${9 - i}`));
    expect(p2.json.nextBefore).toBeNull();
    expect(p2.json.statusCounts).toBeNull();
    expect((await listOf(ev.id, 'before=junk')).json.items as unknown[]).toHaveLength(50); // malformed cursor = first page
  });

  it('filters by status, response, ticket type and check-in; ignores empty params; rejects unknown values', async () => {
    const ev = await mkEvent();
    const ticket = await db.ticketType.create({data: {eventId: ev.id, name: 'VIP', priceCents: 0, currency: 'USD'}});
    await seed(ev.id, {name: 'Going In', checkedInAt: at(1), ticketTypeId: ticket.id});
    await seed(ev.id, {name: 'Maybe', response: 'maybe'});
    await seed(ev.id, {name: 'Waiting', status: 'waitlisted', waitlistPosition: 1, confirmedAt: null});
    expect(await names(ev.id, 'status=waitlisted')).toEqual(['Waiting']);
    expect(await names(ev.id, 'response=maybe')).toEqual(['Maybe']);
    expect(await names(ev.id, 'checkedIn=yes')).toEqual(['Going In']);
    expect(await names(ev.id, 'checkedIn=no')).toEqual(['Maybe', 'Waiting']);
    expect(await names(ev.id, `ticketTypeId=${ticket.id}`)).toEqual(['Going In']);
    expect(await names(ev.id, 'status=&q=')).toHaveLength(3);
    expect((await listOf(ev.id, 'status=bogus')).status).toBe(422);
    expect((await listOf(ev.id, 'ticketTypeId=nope')).status).toBe(422);
    const vip = (await listOf(ev.id, `ticketTypeId=${ticket.id}`)).json;
    expect((vip.items as {ticketTypeName: string}[])[0]!.ticketTypeName).toBe('VIP');
    expect(vip.ticketTypes).toEqual([{id: ticket.id, name: 'VIP', priceCents: 0, currency: 'USD'}]);
  });

  it('searches name, email and ticket code case-insensitively', async () => {
    const ev = await mkEvent();
    await seed(ev.id, {name: 'Ada Lovelace', email: 'ada@math.example'});
    const grace = await seed(ev.id, {name: 'Grace Hopper', email: 'grace@navy.example'});
    await seed(ev.id, {name: '100% Real', email: 'pct@example.test'});
    expect(await names(ev.id, 'q=lovel')).toEqual(['Ada Lovelace']);
    expect(await names(ev.id, 'q=NAVY.example')).toEqual(['Grace Hopper']);
    expect(await names(ev.id, `q=${grace.ticketCode.toLowerCase()}`)).toEqual(['Grace Hopper']);
    expect(await names(ev.id, 'q=nobody')).toEqual([]);
    // A literal '%' is escaped (escapeLike): it matches only the name that contains one.
    expect(await names(ev.id, `q=${encodeURIComponent('%')}`)).toEqual(['100% Real']);
  });

  it('lists answers keyed by question id, ordered questions, payment status; detail carries a timeline', async () => {
    const ev = await mkEvent();
    const q1 = await db.rsvpQuestion.create({data: {eventId: ev.id, label: 'Dietary needs', type: 'short_text', sortOrder: 1}});
    const q0 = await db.rsvpQuestion.create({data: {eventId: ev.id, label: 'Company', type: 'short_text', sortOrder: 0}});
    const r = await seed(ev.id, {checkedInAt: new Date('2026-11-01T18:02:00Z')});
    await db.rsvpAnswer.createMany({
      data: [
        {rsvpId: r.id, questionId: q0.id, value: 'Acme'},
        {rsvpId: r.id, questionId: q1.id, value: ['vegan', 'nut-free']},
      ],
    });
    await db.ticketOrder.create({data: {rsvpId: r.id, checkoutId: 'cs_1', amountCents: 1000, currency: 'USD', status: 'paid'}});
    const res = await listOf(ev.id);
    expect((res.json.questions as {label: string}[]).map(q => q.label)).toEqual(['Company', 'Dietary needs']);
    const g = (res.json.items as {answers: unknown; paymentStatus: string}[])[0]!;
    expect(g.answers).toEqual({[q0.id]: 'Acme', [q1.id]: ['vegan', 'nut-free']});
    expect(g.paymentStatus).toBe('paid');
    const detail = await admin.get(`${G}/events/${ev.id}/guests/${r.id}`);
    expect(detail.status).toBe(200);
    const kinds = (detail.json.timeline as {kind: string}[]).map(t => t.kind);
    expect(kinds).toContain('rsvped');
    expect(kinds).toContain('checked_in');
    expect(detail.json.ticketCode).toBe(r.ticketCode);
  });

  it('404s a guest of another event and a malformed id; writes on the wrong event do nothing', async () => {
    const ev = await mkEvent();
    const other = await mkEvent({title: 'Other'});
    const theirs = await seed(other.id);
    expect((await admin.get(`${G}/events/${ev.id}/guests/${theirs.id}`)).status).toBe(404);
    expect((await admin.get(`${G}/events/${ev.id}/guests/nope`)).status).toBe(404);
    expect((await patch(ev.id, theirs.id, {name: 'X'})).status).toBe(404);
    expect((await admin.delete(`${G}/events/${ev.id}/guests/${theirs.id}`)).status).toBe(404);
    expect((await bulk(ev.id, 'remove', [theirs.id])).json.failed).toEqual([{rsvpId: theirs.id, reason: 'not_found'}]);
    expect(await db.rsvp.count()).toBe(1);
  });

  describe('edit', () => {
    it('edits name and email; the host can switch consent off but never on', async () => {
      const ev = await mkEvent();
      const r = await seed(ev.id, {marketingConsent: true, consentConfirmedAt: new Date()});
      const res = await patch(ev.id, r.id, {name: '  New   Name ', email: 'NEW@Example.test'});
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({name: 'New Name', email: 'new@example.test'});
      expect((await patch(ev.id, r.id, {marketingConsent: false})).json.marketingConsent).toBe(false);
      expect((await db.rsvp.findUniqueOrThrow({where: {id: r.id}})).consentConfirmedAt).toBeNull();
      expect((await patch(ev.id, r.id, {marketingConsent: true})).json.marketingConsent).toBe(false);
    });

    it('validates fields, duplicate email (409), plus-one limit, and check-in of unconfirmed guests', async () => {
      const ev = await mkEvent({}, {maxPlusOnes: 1, capacity: 3});
      const a = await seed(ev.id, {email: 'a@example.test'});
      const b = await seed(ev.id, {email: 'b@example.test', status: 'pending', confirmedAt: null});
      expect((await patch(ev.id, a.id, {})).status).toBe(422);
      expect((await patch(ev.id, a.id, {email: 'nope'})).status).toBe(422);
      expect((await patch(ev.id, a.id, {name: ''})).status).toBe(422);
      expect((await patch(ev.id, a.id, {plusOnes: 2})).status).toBe(422);
      expect((await patch(ev.id, a.id, {email: 'b@example.test'})).status).toBe(409);
      expect((await patch(ev.id, b.id, {checkedIn: true})).status).toBe(409);
      const ok = await patch(ev.id, a.id, {checkedIn: true, attended: true});
      expect(ok.status).toBe(200);
      expect(ok.json.checkedInAt).not.toBeNull();
      expect((await patch(ev.id, a.id, {checkedIn: false})).json.checkedInAt).toBeNull();
    });

    it('refuses plus-ones that do not fit; shrinking them frees seats for the waitlist', async () => {
      const ev = await mkEvent({}, {maxPlusOnes: 2, capacity: 2});
      const a = await seed(ev.id);
      await seed(ev.id);
      expect((await patch(ev.id, a.id, {plusOnes: 1})).status).toBe(409);
      await db.rsvp.update({where: {id: a.id}, data: {plusOnes: 1, seats: 2}});
      await db.event.update({where: {id: ev.id}, data: {capacity: 3}});
      const w = await seed(ev.id, {status: 'waitlisted', waitlistPosition: 1, confirmedAt: null});
      expect((await patch(ev.id, a.id, {plusOnes: 0})).status).toBe(200);
      expect((await db.rsvp.findUniqueOrThrow({where: {id: w.id}})).status).toBe('confirmed');
    });
  });

  describe('remove', () => {
    it('DELETE removes the RSVP and answers, anonymises poll votes, frees the seat, audits', async () => {
      const ev = await mkEvent({}, {capacity: 1});
      const gone = await seed(ev.id);
      const next = await seed(ev.id, {status: 'waitlisted', waitlistPosition: 1, confirmedAt: null});
      const q = await db.rsvpQuestion.create({data: {eventId: ev.id, label: 'Q', type: 'short_text'}});
      await db.rsvpAnswer.create({data: {rsvpId: gone.id, questionId: q.id, value: 'x'}});
      const res = await admin.delete(`${G}/events/${ev.id}/guests/${gone.id}`);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ok: true});
      expect(await db.rsvp.findUnique({where: {id: gone.id}})).toBeNull();
      expect(await db.rsvpAnswer.count({where: {rsvpId: gone.id}})).toBe(0);
      expect((await db.rsvp.findUniqueOrThrow({where: {id: next.id}})).status).toBe('confirmed');
      const log = await audits('guests_removed');
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({actorUserId: adminId, targetType: 'event', targetId: ev.id, meta: {done: 1, failed: 0}});
      expect((await admin.delete(`${G}/events/${ev.id}/guests/${gone.id}`)).status).toBe(404);
    });

    it('refuses a guest with an order: 409 has_order, nothing deleted', async () => {
      const ev = await mkEvent();
      const paid = await seed(ev.id);
      await db.ticketOrder.create({data: {rsvpId: paid.id, checkoutId: 'cs_paid', amountCents: 1000, currency: 'USD', status: 'paid'}});
      const res = await admin.delete(`${G}/events/${ev.id}/guests/${paid.id}`);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.json)).toContain('has_order');
      expect(await db.rsvp.count({where: {id: paid.id}})).toBe(1);
      expect((await bulk(ev.id, 'remove', [paid.id])).json.failed).toEqual([{rsvpId: paid.id, reason: 'has_order: use erase'}]);
    });
  });

  describe('erase', () => {
    it('anonymises in place, keeps the order and the row, drops answers, kills the manage token, promotes the waitlist', async () => {
      const ev = await mkEvent({}, {capacity: 1});
      const r = await seed(ev.id, {marketingConsent: true, consentConfirmedAt: new Date(), utmSource: 'x'});
      const waiting = await seed(ev.id, {status: 'waitlisted', waitlistPosition: 1, confirmedAt: null});
      const q = await db.rsvpQuestion.create({data: {eventId: ev.id, label: 'Q', type: 'short_text'}});
      await db.rsvpAnswer.create({data: {rsvpId: r.id, questionId: q.id, value: 'secret'}});
      await db.ticketOrder.create({data: {rsvpId: r.id, checkoutId: 'cs_e', amountCents: 2500, currency: 'USD', status: 'paid'}});
      const before = (await db.rsvp.findUniqueOrThrow({where: {id: r.id}})).manageToken;
      const res = await bulk(ev.id, 'erase', [r.id]);
      expect(res.json).toEqual({action: 'erase', succeeded: [r.id], failed: [], emailsQueued: 1});
      const after = await db.rsvp.findUniqueOrThrow({where: {id: r.id}});
      expect(after).toMatchObject({
        name: 'Removed guest',
        email: `removed+${r.id}@invalid`,
        status: 'cancelled',
        marketingConsent: false,
        consentConfirmedAt: null,
        utmSource: null,
      });
      expect(after.manageToken).not.toBe(before);
      expect(await db.rsvpAnswer.count({where: {rsvpId: r.id}})).toBe(0);
      expect(await db.ticketOrder.count({where: {rsvpId: r.id}})).toBe(1);
      expect((await db.rsvp.findUniqueOrThrow({where: {id: waiting.id}})).status).toBe('confirmed');
      expect(await audits('guests_erased')).toHaveLength(1);
      const contacts = await admin.get(`${G}/contacts`);
      expect((contacts.json.items as {email: string}[]).some(c => c.email.startsWith('removed+'))).toBe(false);
    });

    it('refuses mid-checkout guests', async () => {
      const ev = await mkEvent();
      const r = await seed(ev.id, {status: 'awaiting_payment'});
      expect((await bulk(ev.id, 'erase', [r.id])).json.failed).toEqual([{rsvpId: r.id, reason: 'checkout_in_progress'}]);
    });
  });

  describe('bulk approve, decline, promote', () => {
    it('approves and declines pending guests and reports per-guest failures', async () => {
      const ev = await mkEvent({}, {approvalRequired: true, capacity: 10});
      const a = await seed(ev.id, {status: 'pending', confirmedAt: null});
      const b = await seed(ev.id, {status: 'pending', confirmedAt: null});
      const already = await seed(ev.id);
      const res = await bulk(ev.id, 'approve', [a.id, already.id, randomUUID()]);
      expect(res.json.succeeded).toEqual([a.id]);
      expect((res.json.failed as {reason: string}[]).map(f => f.reason)).toEqual(['not_pending', 'not_found']);
      expect((await db.rsvp.findUniqueOrThrow({where: {id: a.id}})).status).toBe('confirmed');
      expect((await bulk(ev.id, 'decline', [b.id])).json.succeeded).toEqual([b.id]);
      expect((await db.rsvp.findUniqueOrThrow({where: {id: b.id}})).status).toBe('declined');
    });

    it('approve waitlists when full, or refuses event_full when there is no waitlist', async () => {
      const ev = await mkEvent({}, {approvalRequired: true, capacity: 1});
      await seed(ev.id);
      const a = await seed(ev.id, {status: 'pending', confirmedAt: null});
      expect((await bulk(ev.id, 'approve', [a.id])).json.succeeded).toEqual([a.id]);
      expect(await db.rsvp.findUniqueOrThrow({where: {id: a.id}})).toMatchObject({status: 'waitlisted', waitlistPosition: 1});
      await db.event.update({where: {id: ev.id}, data: {waitlistEnabled: false}});
      const c = await seed(ev.id, {status: 'pending', confirmedAt: null});
      expect((await bulk(ev.id, 'approve', [c.id])).json.failed).toEqual([{rsvpId: c.id, reason: 'event_full'}]);
    });

    it('approving a paid-ticket guest holds the seat as awaiting_payment', async () => {
      const ev = await mkEvent({}, {approvalRequired: true, capacity: 5});
      const t = await db.ticketType.create({data: {eventId: ev.id, name: 'GA', priceCents: 1500, currency: 'USD'}});
      const a = await seed(ev.id, {status: 'pending', confirmedAt: null, ticketTypeId: t.id});
      await bulk(ev.id, 'approve', [a.id]);
      expect((await db.rsvp.findUniqueOrThrow({where: {id: a.id}})).status).toBe('awaiting_payment');
    });

    it('promote respects capacity, returns a partial report and closes waitlist gaps', async () => {
      const ev = await mkEvent({}, {capacity: 4});
      await seed(ev.id, {plusOnes: 1, seats: 2});
      const w1 = await seed(ev.id, {status: 'waitlisted', waitlistPosition: 1, confirmedAt: null});
      const w2 = await seed(ev.id, {status: 'waitlisted', waitlistPosition: 2, confirmedAt: null, plusOnes: 1, seats: 2});
      const w3 = await seed(ev.id, {status: 'waitlisted', waitlistPosition: 3, confirmedAt: null});
      const confirmed = await seed(ev.id);
      const res = await bulk(ev.id, 'promote', [w3.id, w2.id, w1.id, confirmed.id]);
      expect(res.status).toBe(200);
      expect(res.json.succeeded).toEqual([w1.id]);
      expect(res.json.failed).toEqual(
        expect.arrayContaining([
          {rsvpId: confirmed.id, reason: 'not_waitlisted'},
          {rsvpId: w2.id, reason: 'event_full'},
          {rsvpId: w3.id, reason: 'event_full'},
        ])
      );
      const row = (id: string) => db.rsvp.findUniqueOrThrow({where: {id}});
      expect(await row(w1.id)).toMatchObject({status: 'confirmed', waitlistPosition: null});
      expect((await row(w2.id)).waitlistPosition).toBe(1);
      expect((await row(w3.id)).waitlistPosition).toBe(2);
    });

    it('promote on a paid event offers a claim instead of a free seat', async () => {
      const ev = await mkEvent({}, {capacity: 2});
      await db.ticketType.create({data: {eventId: ev.id, name: 'GA', priceCents: 1500, currency: 'USD'}});
      const w = await seed(ev.id, {status: 'waitlisted', waitlistPosition: 1, confirmedAt: null});
      expect((await bulk(ev.id, 'promote', [w.id])).json.succeeded).toEqual([w.id]);
      const row = await db.rsvp.findUniqueOrThrow({where: {id: w.id}});
      expect(row.status).toBe('waitlisted');
      expect(row.claimExpiresAt).not.toBeNull();
      expect((await bulk(ev.id, 'promote', [w.id])).json.failed).toEqual([{rsvpId: w.id, reason: 'claim_pending'}]);
    });

    it('promote on a cancelled event fails every id', async () => {
      const ev = await mkEvent({}, {status: 'cancelled'});
      const w = await seed(ev.id, {status: 'waitlisted', waitlistPosition: 1, confirmedAt: null});
      expect((await bulk(ev.id, 'promote', [w.id])).json.failed).toEqual([{rsvpId: w.id, reason: 'event_cancelled'}]);
    });

    it('validates the body', async () => {
      const ev = await mkEvent();
      expect((await bulk(ev.id, 'explode', [randomUUID()])).status).toBe(422);
      expect((await bulk(ev.id, 'approve', [])).status).toBe(422);
      expect((await bulk(ev.id, 'approve', ['not-a-uuid'])).status).toBe(422);
      expect((await bulk(ev.id, 'approve', Array.from({length: 101}, () => randomUUID()))).status).toBe(422);
    });
  });

  describe('guest CSV export', () => {
    it('is BOM-prefixed, an attachment, formula-guarded, has answer columns, honours filters, audited', async () => {
      const ev = await mkEvent();
      const q = await db.rsvpQuestion.create({data: {eventId: ev.id, label: 'Company', type: 'short_text'}});
      const r = await seed(ev.id, {name: "=cmd|' /C calc'!A0", email: 'zoe@example.com', checkedInAt: new Date('2026-11-01T18:02:00Z')});
      await seed(ev.id, {name: 'Other', status: 'pending', confirmedAt: null});
      await db.rsvpAnswer.create({data: {rsvpId: r.id, questionId: q.id, value: 'Zoë, Ltd'}});
      await db.ticketOrder.create({data: {rsvpId: r.id, checkoutId: 'cs_csv', amountCents: 1, currency: 'USD', status: 'paid'}});
      const res = await admin.get(`${G}/events/${ev.id}/guests/export.csv?status=confirmed`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="guests-.*\.csv"/);
      expect(res.headers.get('x-export-truncated')).toBe('0');
      const text = res.json.text as string;
      const lines = csvLines(text);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/Payment status.*Company$/);
      expect(lines[1]).toContain("'=cmd|' /C calc'!A0");
      expect(lines[1]).not.toMatch(/(^|,)"?=cmd/);
      expect(lines[1]).toContain('"Zoë, Ltd"');
      expect(lines[1]).toContain('paid');
      expect(lines[1]).toContain('2026-11-01T18:02:00.000Z');
      expect(lines[1]).toContain(r.ticketCode);
      expect(await audits('guests_exported')).toHaveLength(1);
      expect((await staff.get(`${G}/events/${ev.id}/guests/export.csv`)).status).toBe(403);
      expect((await admin.get(`${G}/events/${ev.id}/guests/export.csv?status=bogus`)).status).toBe(422);
    });
  });

  describe('contacts and contacts CSV', () => {
    async function twoEvents() {
      const e1 = await mkEvent({title: 'First'});
      const e2 = await mkEvent({title: 'Second'});
      await seed(e1.id, {name: 'Ada Old', email: 'ada@example.test', marketingConsent: true, consentConfirmedAt: new Date(), createdAt: at(1)});
      await seed(e2.id, {name: 'Ada New', email: 'ada@example.test', marketingConsent: true, consentConfirmedAt: new Date(), createdAt: at(2)});
      await seed(e1.id, {name: '=HYPERLINK("x")', email: 'bob@example.test', marketingConsent: true}); // never confirmed
      await seed(e1.id, {name: 'Cy', email: 'cy@example.test', marketingConsent: true, consentConfirmedAt: new Date()});
    }

    it('lists each email once, lowercased, with counts; search, consent filter, keyset paging', async () => {
      await twoEvents();
      const items = (await admin.get(`${G}/contacts`)).json.items as {email: string; name: string; eventCount: number; marketingConsent: boolean}[];
      expect(items.map(i => i.email)).toEqual(['ada@example.test', 'bob@example.test', 'cy@example.test']);
      expect(items[0]).toMatchObject({name: 'Ada New', eventCount: 2, marketingConsent: true});
      expect(items[1]!.marketingConsent).toBe(false);
      const consent = await admin.get(`${G}/contacts?consent=yes`);
      expect((consent.json.items as {email: string}[]).map(i => i.email)).toEqual(['ada@example.test', 'cy@example.test']);
      expect((await admin.get(`${G}/contacts?q=CY`)).json.items as unknown[]).toHaveLength(1);
      const after = await admin.get(`${G}/contacts?before=ada@example.test`);
      expect((after.json.items as {email: string}[]).map(i => i.email)).toEqual(['bob@example.test', 'cy@example.test']);
    });

    it('pages contacts 50 at a time', async () => {
      const ev = await mkEvent();
      await db.rsvp.createMany({
        data: Array.from({length: 55}, (_, i) => ({
          eventId: ev.id,
          name: `C${i}`,
          email: `c${String(i).padStart(2, '0')}@example.test`,
          response: 'going' as const,
          status: 'confirmed' as const,
          ticketCode: `C${String(i).padStart(7, '0')}`,
          manageToken: hashToken(`c${i}`),
        })),
      });
      const p1 = await admin.get(`${G}/contacts`);
      expect(p1.json.items as unknown[]).toHaveLength(50);
      const p2 = await admin.get(`${G}/contacts?before=${encodeURIComponent(p1.json.nextBefore as string)}`);
      expect(p2.json.items as unknown[]).toHaveLength(5);
      expect(p2.json.nextBefore).toBeNull();
    });

    it('exports CSV: formula-safe, consent-only filter, audited, gated', async () => {
      await twoEvents();
      const res = await admin.get(`${G}/contacts/export.csv`);
      expect(res.status).toBe(200);
      const text = res.json.text as string;
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="contacts-.*\.csv"/);
      const lines = csvLines(text);
      expect(lines[0]).toBe('Name,Email,Events,Attended,Last event,Last event date,First seen,Marketing consent');
      expect(lines).toHaveLength(4);
      expect(lines.some(l => /^"?'=HYPERLINK/.test(l))).toBe(true);
      expect(lines.some(l => l.startsWith('='))).toBe(false);
      const only = csvLines((await admin.get(`${G}/contacts/export.csv?consent=yes`)).json.text as string);
      expect(only).toHaveLength(3);
      expect(only.join('\n')).not.toContain('bob@example.test');
      expect(await audits('contacts_exported')).toHaveLength(2);
      expect((await staff.get(`${G}/contacts/export.csv`)).status).toBe(403);
    });
  });

  describe('guest data export parity', () => {
    it('organiser export equals the guest self-export, is audited, an attachment, event-scoped', async () => {
      const ev = await mkEvent();
      const other = await mkEvent({title: 'Other'});
      const r = await seed(ev.id, {email: 'self@example.test'});
      const q = await db.rsvpQuestion.create({data: {eventId: ev.id, label: 'Company', type: 'short_text'}});
      await db.rsvpAnswer.create({data: {rsvpId: r.id, questionId: q.id, value: 'Acme'}});
      await db.ticketOrder.create({data: {rsvpId: r.id, checkoutId: 'cs_x', amountCents: 500, currency: 'USD', status: 'paid'}});
      const token = newToken();
      await db.rsvp.update({where: {id: r.id}, data: {manageToken: hashToken(token)}});

      const org = await admin.get(`${G}/events/${ev.id}/guests/${r.id}/data`);
      expect(org.status).toBe(200);
      expect(org.headers.get('content-disposition')).toContain('attachment');
      const self = await new Browser(app, '203.0.113.50').get(`/site-api/privacy/guest/${token}/export`);
      expect(self.status).toBe(200);
      const strip = (j: Record<string, unknown>) => ({...j, exportedAt: undefined});
      expect(strip(org.json)).toEqual(strip(self.json));
      expect(JSON.stringify(org.json)).not.toContain(hashToken(token));
      const log = await audits('guest_data_exported');
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({actorUserId: adminId, targetType: 'event', targetId: ev.id, meta: {rsvpId: r.id}});
      expect((await admin.get(`${G}/events/${other.id}/guests/${r.id}/data`)).status).toBe(404);
      expect((await staff.get(`${G}/events/${ev.id}/guests/${r.id}/data`)).status).toBe(403);
    });
  });
});
