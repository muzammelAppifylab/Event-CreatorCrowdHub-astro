import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {authRoutes} from '../../src/platform/auth';
import {csrf, previewCookies, sameOrigin} from '../../src/platform/guards';
import {syncPermissions} from '../../src/platform/permission-sync';
import {STARTER_REMINDER_RULES} from '../../src/domain/reminders';
import {authSettings} from '../../src/server/auth-settings';
import {CATALOGUE} from '../../src/server/permissions';
import {adminEventRoutes} from '../../src/server/routes/admin-events';
import {eventSettingsRoutes} from '../../src/server/routes/event-settings';
import {createEvent, eventBody, inDays, resetEvents, setRoles} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

/**
 * Ported from CreatorCrowdHub: server/routes/events.test.ts, workspace.test.ts (now event
 * settings) and the ticket-type CRUD part of tickets.test.ts, against real Postgres.
 * The source ran on in-memory repos; the data model differs (no workspaces, a singleton
 * settings row), so cross-workspace cases become role cases.
 */
const app = new Hono()
  .basePath('/site-api')
  .use(previewCookies)
  .use(sameOrigin)
  .use(csrf)
  .use(bodyLimit({maxSize: 64 * 1024}))
  .use(syncPermissions(CATALOGUE))
  .route('/auth', authRoutes(authSettings))
  .route('/admin-events', adminEventRoutes)
  .route('/event-settings', eventSettingsRoutes);

const A = '/site-api/admin-events';
const S = '/site-api/event-settings';
type Json = Record<string, any>;

async function userWith(email: string, roles: string[], ip: string) {
  const b = await signedIn(app, email, undefined, ip);
  await setRoles(email, ...roles);
  return b;
}
const patch = (b: Browser, path: string, body: unknown) => b.request('PATCH', path, body);

describe.skipIf(!DATABASE_URL)('ported events admin / tickets / settings (real Postgres)', () => {
  let admin: Browser;
  let staff: Browser;
  let guest: Browser;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.32');
    staff = await userWith('staff@example.test', ['checkin-staff'], '203.0.113.33');
    guest = new Browser(app, '203.0.113.39');
  });

  const create = async (over: Record<string, unknown> = {}) => {
    const res = await admin.post(A, eventBody(over));
    expect(res.status).toBe(201);
    return res.json.event as Json;
  };
  let seq = 0;
  const addRsvp = (eventId: string, over: Record<string, unknown> = {}) => {
    seq += 1;
    return db.rsvp.create({
      data: {
        eventId, name: `G${seq}`, email: `g${seq}@example.test`, response: 'going', status: 'confirmed', plusOnes: 0, seats: 1,
        ticketCode: `T${String(seq).padStart(7, '0')}`, manageToken: `mt-${seq}-${Math.random()}`, ...over,
      } as never,
    });
  };

  // -------------------------------------------------------------- create --
  describe('POST /admin-events', () => {
    it('creates a draft with settings defaults, a slug, a join code and ordered questions', async () => {
      await patch(admin, S, {
        defaultTimezone: 'Europe/London', allowMaybeDefault: false, showGuestListDefault: true,
        defaultReminderRules: [{kind: 'reminder', offsetMinutes: -60, enabled: true, subject: 'Soon', body: 'Soon'}],
      });
      const res = await admin.post(A, {
        title: 'Pricing Workshop', startAt: inDays(10), endAt: inDays(10.1), timezone: 'Europe/London', format: 'online', joinUrl: 'https://zoom.example/j/123',
        questions: [{label: 'Company?', type: 'short_text'}, {label: 'Track', type: 'single_choice', options: ['Beginner', 'Advanced'], required: true}],
      });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      const e = res.json.event as Json;
      expect(e.status).toBe('draft');
      expect(e.slug).toBe('pricing-workshop');
      expect(e.publicPath).toBe('/events/pricing-workshop/');
      expect(e.pollJoinCode).toMatch(/^[23456789A-HJKMNP-Z]{6}$/);
      expect([e.timezone, e.allowMaybe, e.showGuestList]).toEqual(['Europe/London', false, true]);
      expect(e.joinUrl).toBe('https://zoom.example/j/123');
      expect(e.questions.map((q: Json) => q.label)).toEqual(['Company?', 'Track']);
      expect(e.counts).toMatchObject({confirmed: 0, waitlisted: 0, pending: 0});
      const rules = await db.reminderRule.findMany({where: {eventId: e.id}});
      expect(rules).toHaveLength(1);
    });

    it('a body without timezone inherits the settings default timezone', async () => {
      await patch(admin, S, {defaultTimezone: 'Asia/Dhaka'});
      const res = await admin.post(A, {title: 'Q&A', startAt: inDays(10), endAt: inDays(10.1), format: 'online', joinUrl: 'https://meet.example/x'});
      expect(res.status).toBe(201);
      expect((res.json.event as Json).timezone).toBe('Asia/Dhaka');
    });

    it('lets the body override settings defaults', async () => {
      await patch(admin, S, {defaultTimezone: 'Asia/Dhaka', allowMaybeDefault: true, showGuestListDefault: false});
      const e = await create({allowMaybe: false, showGuestList: true, timezone: 'America/New_York'});
      expect([e.allowMaybe, e.showGuestList, e.timezone]).toEqual([false, true, 'America/New_York']);
      const inherited = await create({title: 'Other'});
      expect([inherited.allowMaybe, inherited.showGuestList, inherited.timezone]).toEqual([true, false, 'UTC']);
    });

    it('feeds new events the default cover poster, an explicit pick or null beats it', async () => {
      await patch(admin, S, {defaultCoverPoster: 'launch'});
      expect((await create()).coverPoster).toBe('launch');
      expect((await create({title: 'Two', coverPoster: 'ama'})).coverPoster).toBe('ama');
      expect((await create({title: 'Three', coverPoster: null})).coverPoster).toBeNull();
    });

    it('suffixes a colliding slug', async () => {
      await create({title: 'Pricing Workshop'});
      expect((await create({title: 'Pricing Workshop'})).slug).toBe('pricing-workshop-2');
      expect((await create({title: 'Pricing Workshop', slug: 'pricing-workshop-3'})).slug).toBe('pricing-workshop-3');
      expect((await create({title: 'Pricing Workshop'})).slug).toBe('pricing-workshop-4');
    });

    it('422s an explicit slug another live event uses; a deleted draft frees it', async () => {
      const first = await create({slug: 'launch-night'});
      const dup = await admin.post(A, eventBody({title: 'B', slug: 'launch-night'}));
      expect(dup.status).toBe(422);
      expect(dup.json.fields).toHaveProperty('slug');
      expect((await admin.delete(`${A}/${first.id}`)).status).toBe(200);
      expect((await admin.post(A, eventBody({title: 'B', slug: 'launch-night'}))).status).toBe(201);
    });

    it('422s with field messages', async () => {
      // Field parsing runs first; the cross-field rules only once every field parses (the source reported both at once).
      const first = await admin.post(A, eventBody({title: ''}));
      expect(first.status).toBe(422);
      expect(first.json.error).toBe('invalid_input');
      expect(Object.keys(first.json.fields as Json)).toEqual(['title']);
      const cross = await admin.post(A, eventBody({endAt: inDays(1), startAt: inDays(2), venueName: '', venueAddress: ''}));
      expect(cross.status).toBe(422);
      expect(Object.keys(cross.json.fields as Json).sort()).toEqual(['endAt', 'venueAddress', 'venueName']);
    });
  });

  // --------------------------------------------------------------- patch --
  describe('PATCH /admin-events/:id', () => {
    it('merges, keeps untouched fields and bumps updatedAt', async () => {
      const e = await create({allowMaybe: false, questions: [{label: 'A', type: 'short_text'}, {label: 'B', type: 'long_text'}]});
      await new Promise(r => setTimeout(r, 15));
      const res = await patch(admin, `${A}/${e.id}`, {title: 'Pricing Masterclass'});
      expect(res.status).toBe(200);
      const out = res.json.event as Json;
      expect(out.title).toBe('Pricing Masterclass');
      expect(out.slug).toBe(e.slug); // the slug does not follow the title
      expect(out.allowMaybe).toBe(false);
      expect(out.questions).toHaveLength(2);
      expect(Date.parse(out.updatedAt)).toBeGreaterThan(Date.parse(e.updatedAt));
    });

    it('422s when the merged event breaks a cross-field rule', async () => {
      const e = await create({format: 'online', joinUrl: 'https://zoom.example/j/1', venueName: null, venueAddress: null});
      const end = await patch(admin, `${A}/${e.id}`, {endAt: new Date(Date.parse(e.startAt) - 1000).toISOString()});
      expect(end.status).toBe(422);
      expect(end.json.fields).toHaveProperty('endAt');
      const sw = await patch(admin, `${A}/${e.id}`, {format: 'hybrid'});
      expect(Object.keys(sw.json.fields as Json).sort()).toEqual(['venueAddress', 'venueName']);
    });

    it('replaces questions, keeping the ids of ones that remain', async () => {
      const e = await create({questions: [{label: 'Company?', type: 'short_text'}, {label: 'Track', type: 'single_choice', options: ['Beginner', 'Advanced']}]});
      const track = e.questions[1];
      const res = await patch(admin, `${A}/${e.id}`, {
        questions: [{id: track.id, label: 'Track', type: 'single_choice', options: ['Beginner', 'Advanced']}, {label: 'Diet', type: 'long_text'}],
      });
      expect(res.status).toBe(200);
      const qs = (res.json.event as Json).questions as Json[];
      expect(qs.map(q => q.label)).toEqual(['Track', 'Diet']);
      expect(qs[0]!.id).toBe(track.id);
    });

    it('rejects a slug another event uses and accepts a free one', async () => {
      const first = await create({title: 'Pricing Workshop'});
      const second = await create({title: 'Other'});
      const bad = await patch(admin, `${A}/${second.id}`, {slug: first.slug});
      expect(bad.status).toBe(422);
      expect(bad.json.fields).toHaveProperty('slug');
      const ok = await patch(admin, `${A}/${second.id}`, {slug: 'other-new'});
      expect((ok.json.event as Json).publicPath).toBe('/events/other-new/');
    });

    it('saves a deleted event slug as free for another event', async () => {
      const a = await create({slug: 'launch-night'});
      const b = await create({title: 'B'});
      await admin.delete(`${A}/${a.id}`);
      expect((await patch(admin, `${A}/${b.id}`, {slug: 'launch-night'})).status).toBe(200);
    });

    it('ignores smuggled columns (status, id, pollJoinCode)', async () => {
      const e = await create();
      const res = await patch(admin, `${A}/${e.id}`, {status: 'cancelled', id: 'x', pollJoinCode: 'ZZZZZZ', deletedAt: '2020-01-01T00:00:00Z'});
      expect(res.status).toBe(200);
      const row = await db.event.findUniqueOrThrow({where: {id: e.id}});
      expect([row.status, row.pollJoinCode === 'ZZZZZZ', row.deletedAt]).toEqual(['draft', false, null]);
    });
  });

  // -------------------------------------------------------------- access --
  describe('access', () => {
    it('404s a malformed or unknown id on every route', async () => {
      const e = await create();
      expect((await admin.get(`${A}/not-a-uuid`)).status).toBe(404);
      const none = '0192f0a1-0000-7000-8000-000000000001';
      for (const [method, path] of [
        ['GET', `${A}/${none}`], ['PATCH', `${A}/${none}`], ['POST', `${A}/${none}/publish`], ['POST', `${A}/${none}/cancel`],
        ['GET', `${A}/${none}/cancel-preview`], ['POST', `${A}/${none}/duplicate`], ['DELETE', `${A}/${none}`],
      ] as const) {
        expect([method, path, (await admin.request(method, path, method === 'GET' || method === 'DELETE' ? undefined : path.endsWith('/duplicate') ? {startAt: '2027-12-01T18:00:00Z', endAt: '2027-12-01T20:00:00Z'} : {})).status]).toEqual([method, path, 404]);
      }
      expect(e.id).toBeTruthy();
    });

    it('403s check-in staff and 401s anonymous callers on every route, with no event data leaked', async () => {
      const e = await create({format: 'online', joinUrl: 'https://zoom.example/j/leak'});
      const routes = [
        ['GET', A], ['POST', A], ['GET', `${A}/${e.id}`], ['PATCH', `${A}/${e.id}`], ['POST', `${A}/${e.id}/publish`],
        ['POST', `${A}/${e.id}/cancel`], ['GET', `${A}/${e.id}/cancel-preview`], ['POST', `${A}/${e.id}/duplicate`], ['DELETE', `${A}/${e.id}`],
        ['GET', S], ['PATCH', S], ['GET', `${A}/${e.id}/ticket-types`], ['POST', `${A}/${e.id}/ticket-types`],
      ] as const;
      for (const [method, path] of routes) {
        const body = method === 'GET' || method === 'DELETE' ? undefined : {};
        const anon = await guest.request(method, path, body);
        expect([method, path, anon.status]).toEqual([method, path, 401]);
        expect(JSON.stringify(anon.json)).not.toContain('zoom.example');
        const door = await staff.request(method, path, body);
        expect([method, path, door.status]).toEqual([method, path, 403]);
      }
    });
  });

  // ------------------------------------------------------ publish / cancel --
  describe('publish and cancel', () => {
    it('publishes a complete future event', async () => {
      const e = await create();
      const res = await admin.post(`${A}/${e.id}/publish`);
      expect(res.status).toBe(200);
      expect((res.json.event as Json).status).toBe('published');
    });

    it('409s publishing an event that already ended', async () => {
      const e = await create();
      await db.event.update({where: {id: e.id}, data: {startAt: new Date(Date.now() - 7200_000), endAt: new Date(Date.now() - 3600_000)}});
      expect((await admin.post(`${A}/${e.id}/publish`)).status).toBe(409);
    });

    it('409s publishing a draft with missing required details, naming the fields', async () => {
      const e = await create({format: 'online', joinUrl: 'https://zoom.example/j/1'});
      await db.event.update({where: {id: e.id}, data: {joinUrl: null}});
      const res = await admin.post(`${A}/${e.id}/publish`);
      expect(res.status).toBe(409);
      expect(res.json.fields).toHaveProperty('joinUrl');
    });

    it('previews and cancels with guest and refund numbers, then refuses to repeat or reopen', async () => {
      const e = await create({});
      await admin.post(`${A}/${e.id}/publish`);
      const ticket = await db.ticketType.create({data: {eventId: e.id, name: 'GA', priceCents: 2500, currency: 'USD', sortOrder: 0}});
      const going2 = await addRsvp(e.id, {plusOnes: 1, seats: 2, ticketTypeId: ticket.id});
      await addRsvp(e.id, {response: 'maybe'});
      await addRsvp(e.id, {status: 'pending'});
      await addRsvp(e.id, {status: 'waitlisted'});
      await addRsvp(e.id, {status: 'awaiting_payment'});
      await addRsvp(e.id, {status: 'declined'});
      await addRsvp(e.id, {response: 'not_going', status: 'cancelled'});
      const paid = await addRsvp(e.id, {status: 'confirmed'});
      for (const [i, status] of (['paid', 'paid', 'expired'] as const).entries()) {
        await db.ticketOrder.create({data: {rsvpId: i === 0 ? going2.id : paid.id, checkoutId: `cs_${i}`, amountCents: 2500, currency: 'USD', status}});
      }
      const preview = await admin.get(`${A}/${e.id}/cancel-preview`);
      expect(preview.json).toEqual({guestsToEmail: 6, ordersToRefund: 2, refundTotalCents: 5000, currency: 'USD'});

      const res = await admin.post(`${A}/${e.id}/cancel`);
      expect(res.status).toBe(200);
      expect((res.json.event as Json).status).toBe('cancelled');
      expect((await db.ticketOrder.findMany({where: {status: 'refund_due'}})).length).toBe(2);
      expect((await admin.post(`${A}/${e.id}/cancel`)).status).toBe(409);
      expect((await admin.post(`${A}/${e.id}/publish`)).status).toBe(409);
      expect((await admin.post(`${A}/${e.id}/unpublish`)).status).toBe(409);
    });

    it('previews zeros for an event with no guests', async () => {
      const e = await create();
      expect((await admin.get(`${A}/${e.id}/cancel-preview`)).json).toEqual({guestsToEmail: 0, ordersToRefund: 0, refundTotalCents: 0, currency: null});
    });
  });

  // ----------------------------------------------------------- duplicate --
  describe('POST /admin-events/:id/duplicate', () => {
    it('copies settings, questions and tickets; resets status, dates, slug, code and guests', async () => {
      const source = await create({rsvpDeadline: new Date(Date.parse(inDays(10)) - 6 * 3600_000).toISOString(), capacity: 30, format: 'online', joinUrl: 'https://zoom.example/j/1', title: 'Pricing Workshop', questions: [{label: 'Company?', type: 'short_text'}, {label: 'Track', type: 'single_choice', options: ['A', 'B'], required: true}]});
      await admin.post(`${A}/${source.id}/publish`);
      await addRsvp(source.id);
      const start = '2027-12-01T18:00:00.000Z';
      const res = await admin.post(`${A}/${source.id}/duplicate`, {startAt: start, endAt: '2027-12-01T20:00:00.000Z'});
      expect(res.status).toBe(201);
      const copy = res.json.event as Json;
      expect(copy.id).not.toBe(source.id);
      expect(copy.title).toBe('Copy of Pricing Workshop');
      expect(copy.slug).toBe('copy-of-pricing-workshop');
      expect(copy.status).toBe('draft');
      expect(copy.pollJoinCode).not.toBe(source.pollJoinCode);
      expect([copy.startAt, copy.endAt]).toEqual([start, '2027-12-01T20:00:00.000Z']);
      expect(copy.rsvpDeadline).toBe('2027-12-01T12:00:00.000Z'); // same 6h before the start
      expect([copy.capacity, copy.joinUrl, copy.allowMaybe]).toEqual([30, source.joinUrl, source.allowMaybe]);
      expect(copy.questions.map((q: Json) => q.label)).toEqual(['Company?', 'Track']);
      expect(copy.questions.some((q: Json) => source.questions.some((s: Json) => s.id === q.id))).toBe(false);
      expect(await db.rsvp.count({where: {eventId: copy.id}})).toBe(0);
    });

    it('copies ticket types and email rules, and polls as drafts', async () => {
      const source = await create({});
      await admin.post(`${A}/${source.id}/ticket-types`, {name: 'VIP', priceCents: 4900, currency: 'USD', quantity: 20});
      await db.reminderRule.create({data: {eventId: source.id, kind: 'reminder', offsetMinutes: -60, enabled: true, subject: 'S', body: 'B'}});
      const poll = await db.poll.create({data: {eventId: source.id, question: 'Best slot?', type: 'single_choice', status: 'open', anonymous: true, showResultsToVoters: true, sortOrder: 0} as never});
      await db.pollOption.createMany({data: [{pollId: poll.id, label: 'Morning', sortOrder: 0}, {pollId: poll.id, label: 'Evening', sortOrder: 1}] as never});
      const res = await admin.post(`${A}/${source.id}/duplicate`, {startAt: '2027-12-01T18:00:00Z', endAt: '2027-12-01T20:00:00Z'});
      const id = (res.json.event as Json).id;
      expect((await db.ticketType.findMany({where: {eventId: id}})).map(t => [t.name, t.priceCents])).toEqual([['VIP', 4900]]);
      // A new event starts with the starter email rules; the copy carries those plus the one added here.
      const sourceRules = await db.reminderRule.count({where: {eventId: source.id}});
      expect(sourceRules).toBe(STARTER_REMINDER_RULES.length + 1);
      expect(await db.reminderRule.count({where: {eventId: id}})).toBe(sourceRules);
      const polls = await db.poll.findMany({where: {eventId: id}, include: {pollOptions: {orderBy: {sortOrder: 'asc'}}}});
      expect(polls.map(p => [p.question, p.status, p.pollOptions.map(o => o.label)])).toEqual([['Best slot?', 'draft', ['Morning', 'Evening']]]);
    });

    it('takes a title and requires valid new dates', async () => {
      const source = await create();
      const named = await admin.post(`${A}/${source.id}/duplicate`, {title: 'Session 2', startAt: '2027-12-01T18:00:00Z', endAt: '2027-12-01T20:00:00Z'});
      expect((named.json.event as Json).title).toBe('Session 2');
      const bad = await admin.post(`${A}/${source.id}/duplicate`, {startAt: '2027-12-01T18:00:00Z', endAt: '2027-12-01T17:00:00Z'});
      expect(bad.status).toBe(422);
      expect(bad.json.fields).toHaveProperty('endAt');
      const missing = await admin.post(`${A}/${source.id}/duplicate`, {});
      expect(Object.keys(missing.json.fields as Json).sort()).toEqual(['endAt', 'startAt']);
    });
  });

  // ---------------------------------------------------------------- list --
  describe('GET /admin-events', () => {
    async function seed() {
      const mk = async (title: string, startDays: number, publish: boolean) => {
        const e = await create({title, startAt: inDays(startDays), endAt: inDays(startDays + 0.04)});
        if (publish) await admin.post(`${A}/${e.id}/publish`);
        return e;
      };
      await mk('Later', 20, true);
      await mk('Sooner', 5, true);
      const past = await mk('Past', 30, true);
      await db.event.update({where: {id: past.id}, data: {startAt: new Date(Date.now() - 4 * 86400_000), endAt: new Date(Date.now() - 4 * 86400_000 + 3600_000)}});
      const cancelled = await mk('Cancelled', 40, true);
      await admin.post(`${A}/${cancelled.id}/cancel`);
      await mk('Old draft', 50, false);
      await new Promise(r => setTimeout(r, 15));
      await mk('New draft', 51, false);
    }
    const titles = async (qs: string) => ((await admin.get(`${A}${qs}`)).json.events as Json[]).map(e => e.title);

    it('splits upcoming, past and drafts with their orderings; an unknown tab is 422', async () => {
      await seed();
      expect(await titles('?tab=upcoming')).toEqual(['Sooner', 'Later']);
      expect(await titles('')).toEqual(['Sooner', 'Later']);
      expect(await titles('?tab=past')).toEqual(['Cancelled', 'Past']); // latest start first
      expect(await titles('?tab=drafts')).toEqual(['New draft', 'Old draft']);
      expect((await admin.get(`${A}?tab=nope`)).status).toBe(422);
    });

    it('counts RSVPs per event by status', async () => {
      await seed();
      const sooner = (await db.event.findFirstOrThrow({where: {title: 'Sooner'}})).id;
      await addRsvp(sooner, {plusOnes: 1, seats: 2});
      await addRsvp(sooner);
      await addRsvp(sooner, {response: 'maybe'});
      await addRsvp(sooner, {status: 'awaiting_payment'});
      await addRsvp(sooner, {status: 'waitlisted'});
      await addRsvp(sooner, {status: 'pending'});
      await addRsvp(sooner, {status: 'declined'});
      const [first, second] = (await admin.get(`${A}?tab=upcoming`)).json.events as Json[];
      expect(first!.counts).toMatchObject({waitlisted: 1, pending: 1});
      expect(second!.counts).toEqual({confirmed: 0, waitlisted: 0, pending: 0});
    });

    it('keyset-pages 20 at a time', async () => {
      for (let i = 0; i < 22; i++) await create({title: `Draft ${i}`});
      const first = await admin.get(`${A}?tab=drafts`);
      expect((first.json.events as Json[]).length).toBe(20);
      expect(first.json.nextBefore).toBeTruthy();
      const second = await admin.get(`${A}?tab=drafts&before=${encodeURIComponent(first.json.nextBefore as string)}`);
      expect((second.json.events as Json[]).length).toBe(2);
      expect(second.json.nextBefore).toBeNull();
    });
  });

  // -------------------------------------------------------------- delete --
  describe('DELETE /admin-events/:id', () => {
    it('409s for a published event', async () => {
      const e = await create();
      await admin.post(`${A}/${e.id}/publish`);
      expect((await admin.delete(`${A}/${e.id}`)).status).toBe(409);
    });

    it('soft-deletes a draft and hides it everywhere', async () => {
      const e = await create({title: 'Pricing Workshop'});
      expect((await admin.delete(`${A}/${e.id}`)).status).toBe(200);
      expect((await admin.get(`${A}/${e.id}`)).status).toBe(404);
      expect((await admin.get(`${A}?tab=drafts`)).json.events).toEqual([]);
      expect((await db.event.findUniqueOrThrow({where: {id: e.id}})).deletedAt).not.toBeNull();
    });
  });

  // ------------------------------------------- H-1: guests force Cancel --
  describe('unpublish / delete an event people expect (H-1)', () => {
    it('409s unpublish while a guest holds a place, and keeps the event published', async () => {
      const e = await create();
      await admin.post(`${A}/${e.id}/publish`);
      await addRsvp(e.id, {status: 'waitlisted'});
      const res = await admin.post(`${A}/${e.id}/unpublish`);
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('event_has_guests');
      expect(res.json.message).toMatch(/Cancel the event/);
      expect((await db.event.findUniqueOrThrow({where: {id: e.id}})).status).toBe('published');
      // A user without event management is still refused, and an unknown event is still 404.
      expect((await staff.post(`${A}/${e.id}/unpublish`)).status).toBe(403);
      expect((await admin.post(`${A}/00000000-0000-7000-8000-000000000000/unpublish`)).status).toBe(404);
    });

    it('409s unpublish when only a paid order is left (its guest cancelled)', async () => {
      const e = await create();
      await admin.post(`${A}/${e.id}/publish`);
      const r = await addRsvp(e.id, {status: 'cancelled'});
      await db.ticketOrder.create({data: {rsvpId: r.id, checkoutId: 'cs_h1', amountCents: 2500, currency: 'USD', status: 'paid'}});
      expect((await admin.post(`${A}/${e.id}/unpublish`)).status).toBe(409);
    });

    it('still unpublishes when every guest declined or cancelled and nothing was paid', async () => {
      const e = await create();
      await admin.post(`${A}/${e.id}/publish`);
      await addRsvp(e.id, {status: 'declined', response: 'not_going'});
      await addRsvp(e.id, {status: 'cancelled'});
      expect((await admin.post(`${A}/${e.id}/unpublish`)).status).toBe(200);
      expect((await db.event.findUniqueOrThrow({where: {id: e.id}})).status).toBe('draft');
    });

    it('409s deleting a draft that still carries guests; staff 403; nothing deleted', async () => {
      const e = await create();
      await addRsvp(e.id, {status: 'pending'});
      const res = await admin.delete(`${A}/${e.id}`);
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('event_has_guests');
      expect((await staff.delete(`${A}/${e.id}`)).status).toBe(403);
      expect((await db.event.findUniqueOrThrow({where: {id: e.id}})).deletedAt).toBeNull();
      // Cancel is the way out: it is allowed, and the guest stays reachable.
      expect((await admin.post(`${A}/${e.id}/cancel`)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------- cover poster --
  describe('cover poster (US-1)', () => {
    it('saves, patches, validates and duplicates coverPoster', async () => {
      const e = await create({coverPoster: 'breakfast'});
      expect(e.coverPoster).toBe('breakfast');
      expect((await create({title: 'No poster'})).coverPoster).toBeNull();
      expect(((await patch(admin, `${A}/${e.id}`, {coverPoster: 'launch'})).json.event as Json).coverPoster).toBe('launch');
      expect(((await patch(admin, `${A}/${e.id}`, {title: 'Renamed'})).json.event as Json).coverPoster).toBe('launch');
      const bad = await patch(admin, `${A}/${e.id}`, {coverPoster: 'neon'});
      expect(bad.status).toBe(422);
      expect(Object.keys(bad.json.fields as Json)).toEqual(['coverPoster']);
      const copy = await admin.post(`${A}/${e.id}/duplicate`, {startAt: '2027-12-01T18:00:00Z', endAt: '2027-12-01T20:00:00Z'});
      expect((copy.json.event as Json).coverPoster).toBe('launch');
      const list = (await admin.get(`${A}?tab=drafts`)).json.events as Json[];
      expect(list.find(x => x.id === e.id)?.coverPoster).toBe('launch');
    });

    it('saves coverStyle without blank lines, keeps it on PATCH and duplicate', async () => {
      const e = await create({coverPoster: 'ama', coverStyle: {palette: 'plum', headline: 'Ask us', eyebrow: ' ', footer: ''}});
      expect(e.coverStyle).toEqual({palette: 'plum', headline: 'Ask us'});
      expect((await create({title: 'Plain', coverStyle: {palette: null, headline: ''}})).coverStyle).toBeNull();
      expect(((await patch(admin, `${A}/${e.id}`, {title: 'Renamed'})).json.event as Json).coverStyle).toEqual({palette: 'plum', headline: 'Ask us'});
      expect((await patch(admin, `${A}/${e.id}`, {coverStyle: {palette: 'neon'}})).status).toBe(422);
      const copy = await admin.post(`${A}/${e.id}/duplicate`, {startAt: '2027-12-01T18:00:00Z', endAt: '2027-12-01T20:00:00Z'});
      expect((copy.json.event as Json).coverStyle).toEqual({palette: 'plum', headline: 'Ask us'});
    });
  });

  // ----------------------------------------------------------- ticket types --
  describe('ticket types editor API', () => {
    const T = (id: string) => `${A}/${id}/ticket-types`;

    it('creates free and paid types, appends sortOrder, and lists them with sold counts', async () => {
      const e = await create();
      expect((await admin.post(T(e.id), {name: 'Community', priceCents: 0})).status).toBe(201);
      const paid = await admin.post(T(e.id), {name: 'VIP', priceCents: 4900, currency: 'usd', quantity: 20});
      const vip = paid.json.ticketType as Json;
      expect(vip).toMatchObject({name: 'VIP', priceCents: 4900, currency: 'USD', quantity: 20, sold: 0});
      await addRsvp(e.id, {ticketTypeId: vip.id, plusOnes: 1, seats: 2});
      const list = await admin.get(T(e.id));
      expect(list.json.currency).toBe('USD');
      expect((list.json.ticketTypes as Json[]).map(t => [t.name, t.sold])).toEqual([['Community', 0], ['VIP', 2]]);
      const rows = await db.ticketType.findMany({where: {eventId: e.id}, orderBy: {sortOrder: 'asc'}});
      expect(rows.map(r => r.sortOrder)).toEqual([0, 1]);
    });

    it('validates price as whole cents and the currency as a supported ISO code', async () => {
      const e = await create();
      const res = await admin.post(T(e.id), {name: 'X', priceCents: 10.5, currency: 'ZZZ'});
      expect(res.status).toBe(422);
      expect(Object.keys(res.json.fields as Json)).toEqual(expect.arrayContaining(['priceCents', 'currency']));
    });

    it('keeps one currency per event: a mismatch is 422 on create and patch', async () => {
      const e = await create();
      const usd = await admin.post(T(e.id), {name: 'GA', priceCents: 2500, currency: 'USD'});
      await admin.post(T(e.id), {name: 'Free', priceCents: 0, currency: 'USD'});
      const create2 = await admin.post(T(e.id), {name: 'Euro', priceCents: 100, currency: 'EUR'});
      expect(create2.status).toBe(422);
      expect(create2.json.fields).toHaveProperty('currency');
      const p = await patch(admin, `${T(e.id)}/${(usd.json.ticketType as Json).id}`, {currency: 'EUR'});
      expect(p.status).toBe(422);
    });

    it('patches only the sent fields, and ending sales marks a type ended', async () => {
      const e = await create();
      const t = (await admin.post(T(e.id), {name: 'GA', priceCents: 2500, currency: 'USD', quantity: 50})).json.ticketType as Json;
      const past = new Date(Date.now() - 60_000).toISOString();
      const res = await patch(admin, `${T(e.id)}/${t.id}`, {salesEndAt: past});
      expect(res.json.ticketType).toMatchObject({name: 'GA', quantity: 50, priceCents: 2500, salesEnded: true});
    });

    it('refuses to delete a ticket guests already chose (409); an unused one is removed', async () => {
      const e = await create();
      const sold = (await admin.post(T(e.id), {name: 'Sold', priceCents: 0})).json.ticketType as Json;
      const spare = (await admin.post(T(e.id), {name: 'Spare', priceCents: 0})).json.ticketType as Json;
      await addRsvp(e.id, {ticketTypeId: sold.id});
      expect((await admin.delete(`${T(e.id)}/${sold.id}`)).status).toBe(409);
      expect((await admin.delete(`${T(e.id)}/${spare.id}`)).status).toBe(200);
      expect((await db.ticketType.findMany({where: {eventId: e.id}})).map(t => t.id)).toEqual([sold.id]);
    });

    it('reorders, requiring every type of the event exactly once', async () => {
      const e = await create();
      const a = (await admin.post(T(e.id), {name: 'A', priceCents: 0})).json.ticketType as Json;
      const b = (await admin.post(T(e.id), {name: 'B', priceCents: 0})).json.ticketType as Json;
      expect((await patch(admin, `${T(e.id)}/order`, {ids: [b.id, a.id]})).status).toBe(200);
      expect(((await admin.get(T(e.id))).json.ticketTypes as Json[]).map(t => t.name)).toEqual(['B', 'A']);
      expect((await patch(admin, `${T(e.id)}/order`, {ids: [a.id]})).status).toBe(422);
    });

    it("a ticket of another event is a 404 and cannot be patched or deleted through this event", async () => {
      const e1 = await create({title: 'One'});
      const e2 = await create({title: 'Two'});
      const t = (await admin.post(T(e1.id), {name: 'GA', priceCents: 0})).json.ticketType as Json;
      expect((await patch(admin, `${T(e2.id)}/${t.id}`, {name: 'Hijack'})).status).toBe(404);
      expect((await admin.delete(`${T(e2.id)}/${t.id}`)).status).toBe(404);
      expect((await db.ticketType.findUniqueOrThrow({where: {id: t.id}})).name).toBe('GA');
    });

    it('rejects paid prices under the per-currency minimum; 0 is free', async () => {
      const e = await create();
      const under = await admin.post(T(e.id), {name: 'Cheap', priceCents: 49, currency: 'USD'});
      expect(under.status).toBe(422);
      expect(under.json.fields).toHaveProperty('priceCents');
      expect((await admin.post(T(e.id), {name: 'Free', priceCents: 0, currency: 'USD'})).status).toBe(201);
      expect((await admin.post(T(e.id), {name: 'Min', priceCents: 50, currency: 'USD'})).status).toBe(201);
      const sek = await create({title: 'Sek'});
      expect((await admin.post(T(sek.id), {name: 'Kr', priceCents: 200, currency: 'SEK'})).status).toBe(422);
    });

    it('caps price x (1 + maxPlusOnes) at 99,999,999 cents, also on PATCH', async () => {
      const e = await create({maxPlusOnes: 5});
      expect((await admin.post(T(e.id), {name: 'Gala', priceCents: 20_000_000, currency: 'USD'})).status).toBe(422);
      const ok = (await admin.post(T(e.id), {name: 'Gala', priceCents: 200, currency: 'USD'})).json.ticketType as Json;
      expect((await patch(admin, `${T(e.id)}/${ok.id}`, {priceCents: 20_000_000})).status).toBe(422);
      expect((await patch(admin, `${T(e.id)}/${ok.id}`, {priceCents: 30})).status).toBe(422);
    });

    // Source-only behaviours with no counterpart route in the port (see test-findings-events.md).
    it.todo('POST /ticket-types/currency switches every type at once, locked once an order exists (not ported)');
    it.todo('paid ticket types need Stripe connected, 409 stripe_not_connected (no such gate in the port)');
  });

  // -------------------------------------------------------------- settings --
  describe('event settings (ported workspace settings)', () => {
    it('serves the public brand without a row or auth, then the saved one', async () => {
      expect((await guest.get(`${S}/brand`)).json).toEqual({brandColor: null, fontPreset: 'inter', logoUrl: null});
      await patch(admin, S, {brandColor: '#4F46E5', fontPreset: 'serif'});
      expect((await guest.get(`${S}/brand`)).json).toEqual({brandColor: '#4f46e5', fontPreset: 'serif', logoUrl: null});
    });

    it('returns defaults when nothing was saved', async () => {
      const out = (await admin.get(S)).json.settings as Json;
      expect(out).toMatchObject({fontPreset: 'inter', defaultTimezone: 'UTC', updatedAt: null, defaultReminderRules: STARTER_REMINDER_RULES.map(r => ({...r}))});
    });

    it('updates and normalises settings; unknown keys are not editable', async () => {
      const res = await patch(admin, S, {
        brandColor: '#4F46E5', fontPreset: 'serif', defaultTimezone: 'America/New_York', replyToEmail: ' Hello@Clara.Example ', id: 5, stripeConnected: true,
      });
      expect(res.status).toBe(200);
      expect(res.json.settings).toMatchObject({brandColor: '#4f46e5', fontPreset: 'serif', defaultTimezone: 'America/New_York', replyToEmail: 'hello@clara.example'});
      expect(await db.eventSettings.count()).toBe(1);
    });

    it('accepts null to reset the brand colour, and keeps keys that were not sent', async () => {
      await patch(admin, S, {brandColor: '#112233', senderName: 'Clara'});
      const res = await patch(admin, S, {brandColor: null});
      expect(res.json.settings).toMatchObject({brandColor: null, senderName: 'Clara'});
    });

    it('422s invalid values with field messages', async () => {
      const res = await patch(admin, S, {brandColor: 'red', fontPreset: 'comic', defaultTimezone: 'Mars/Olympus_Mons', replyToEmail: 'not-an-email', senderName: 'x'.repeat(81)});
      expect(res.status).toBe(422);
      expect(Object.keys(res.json.fields as Json).sort()).toEqual(['brandColor', 'defaultTimezone', 'fontPreset', 'replyToEmail', 'senderName']);
    });

    it('stores default reminder rules and poster, and 422s offsets outside the per-kind limits', async () => {
      const rules = [
        {kind: 'reminder', offsetMinutes: -1440, enabled: true, subject: 'Tomorrow', body: 'See you tomorrow'},
        {kind: 'reminder', offsetMinutes: -60, enabled: false, subject: 'Soon', body: 'Starting soon'},
      ];
      const ok = await patch(admin, S, {defaultCoverPoster: 'launch', defaultReminderRules: rules});
      expect(ok.json.settings).toMatchObject({defaultCoverPoster: 'launch', defaultReminderRules: rules});
      const e = await create();
      const stored = await db.reminderRule.findMany({where: {eventId: e.id}, orderBy: {offsetMinutes: 'asc'}});
      expect(stored.map(r => [r.offsetMinutes, r.enabled])).toEqual([[-1440, true], [-60, false]]);
      const bad = await patch(admin, S, {defaultCoverPoster: 'neon', defaultReminderRules: [{kind: 'reminder', offsetMinutes: 60, subject: 'Late', body: 'Too late'}]});
      expect(bad.status).toBe(422);
      expect(Object.keys(bad.json.fields as Json).sort()).toEqual(['defaultCoverPoster', 'defaultReminderRules.0.offsetMinutes']);
    });

    it('a hand-edited row with an invalid rule never breaks the screen', async () => {
      await db.eventSettings.create({data: {id: 1, defaultReminderRules: [{kind: 'reminder', offsetMinutes: 99999, subject: 'x', body: 'y'}]} as never});
      const res = await admin.get(S);
      expect(res.status).toBe(200);
      // The invalid rule is dropped; with none left the starter rules are offered.
      expect((res.json.settings as Json).defaultReminderRules).toEqual(STARTER_REMINDER_RULES.map(r => ({...r})));
    });
  });
});
