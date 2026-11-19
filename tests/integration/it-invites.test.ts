import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {authRoutes} from '../../src/platform/auth';
import {defineBackground} from '../../src/platform/background';
import {csrf, previewCookies, sameOrigin} from '../../src/platform/guards';
import {syncPermissions} from '../../src/platform/permission-sync';
import {authSettings} from '../../src/server/auth-settings';
import {OUTBOX_LIST} from '../../src/server/jobs/outbox';
import {CATALOGUE} from '../../src/server/permissions';
import {adminInviteRoutes, DAILY_INVITE_LIMIT} from '../../src/server/routes/admin-invites';
import {resetEvents, setRoles} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

/**
 * Invites under concurrency (audit M-14, M-15): the 2,000-a-day limit, bulk-resend double clicks,
 * resends while the first send is still waiting in the outbox, drafts, and access.
 *
 * The outbox drain is registered as a NO-OP: every queued invite email stays `pending` in
 * `guest_email_outbox`, so the tests see exactly what each request queued (and "first send still
 * pending" is the natural state after a create).
 */
const app = new Hono()
  .basePath('/site-api')
  .use(previewCookies)
  .use(sameOrigin)
  .use(csrf)
  .use(bodyLimit({maxSize: 1024 * 1024}))
  .use(syncPermissions(CATALOGUE))
  .route('/auth', authRoutes(authSettings))
  .route('/event-admin', adminInviteRoutes);

const HOUR = 3_600_000;
const inv = (id: string, rest = '') => `/site-api/event-admin/events/${id}/invites${rest}`;

let seq = 0;
async function createEvent(status: 'published' | 'draft' = 'published') {
  seq += 1;
  return db.event.create({
    data: {
      slug: `it-invites-${seq}`,
      title: 'Invite test',
      startAt: new Date(Date.now() + 10 * 24 * HOUR),
      endAt: new Date(Date.now() + 10 * 24 * HOUR + HOUR),
      timezone: 'UTC',
      format: 'in_person',
      venueName: 'The Hall',
      venueAddress: '1 Main St',
      status,
      pollJoinCode: `I${String(seq).padStart(5, '0')}`,
    },
    select: {id: true, slug: true},
  });
}

/** Invites inserted directly (already sent `sentAgoH` hours ago), returning their ids by email. */
async function seedInvites(eventId: string, n: number, sentAgoH = 72, prefix = 'g') {
  const sentAt = new Date(Date.now() - sentAgoH * HOUR);
  await db.invite.createMany({
    data: Array.from({length: n}, (_, i) => ({eventId, email: `${prefix}${i}@x.test`, token: `${prefix}-${eventId}-${i}`, status: 'sent' as const, sentAt})),
  });
  return db.invite.findMany({where: {eventId}, select: {id: true, email: true}, orderBy: {email: 'asc'}});
}

/** `n` invite emails already queued in the last 24 h (they count against the daily limit). */
async function fillDailyQuota(n: number) {
  const createdAt = new Date(Date.now() - HOUR);
  await db.guestEmailOutbox.createMany({
    data: Array.from({length: n}, (_, i) => ({idempotencyKey: `it-quota-${i}`, kind: 'invite', status: 'sent', createdAt})),
  });
}

const inviteEmailsLastDay = () => db.guestEmailOutbox.count({where: {kind: 'invite', createdAt: {gte: new Date(Date.now() - 24 * HOUR)}}});
const errorCode = (json: Record<string, unknown>) => (json.error ?? (json as {code?: string}).code) as string | undefined;

describe.skipIf(!DATABASE_URL)('invites: limits and races (integration, real Postgres)', () => {
  let admin: Browser;
  let admin2: Browser;
  let member: Browser;
  let guest: Browser;

  beforeAll(() => {
    configureEnv();
    // No-op drain: queued emails stay pending, so the tests count exactly what was queued.
    defineBackground({[OUTBOX_LIST]: async () => {}});
  });
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    admin = await signedIn(app, 'it-admin@example.test', undefined, '203.0.113.21');
    await setRoles('it-admin@example.test', 'admin');
    admin2 = await signedIn(app, 'it-admin2@example.test', undefined, '203.0.113.22');
    await setRoles('it-admin2@example.test', 'admin');
    member = await signedIn(app, 'it-member@example.test', undefined, '203.0.113.23');
    await setRoles('it-member@example.test', 'member');
    guest = new Browser(app, '203.0.113.29');
  });

  describe('daily limit of 2,000 under concurrency', () => {
    it('parallel creates near the limit: only what fits is queued, the rest get 409 daily_invite_limit', async () => {
      await fillDailyQuota(DAILY_INVITE_LIMIT - 10);
      const events = await Promise.all(Array.from({length: 8}, () => createEvent()));
      // 8 requests x 3 new addresses = 24 emails for 10 free slots: exactly 3 requests fit.
      const results = await Promise.all(
        events.map((e, i) => (i % 2 ? admin : admin2).post(inv(e.id), {emails: `a${i}@x.test, b${i}@x.test, c${i}@x.test`}))
      );
      const ok = results.filter(r => r.status === 201);
      const refused = results.filter(r => r.status !== 201);
      expect(ok).toHaveLength(3);
      for (const r of refused) {
        expect(r.status).toBe(409);
        expect(errorCode(r.json)).toBe('daily_invite_limit');
      }
      expect(await inviteEmailsLastDay()).toBe(DAILY_INVITE_LIMIT - 1);
      // A refused request left nothing behind: no invite rows without a queued email.
      expect(await db.invite.count()).toBe(9);
      expect(await db.guestEmailOutbox.count({where: {kind: 'invite', inviteId: {not: null}}})).toBe(9);
    });

    it('parallel creates, bulk resends and single resends together never pass the limit', async () => {
      const e = await createEvent();
      const old = await seedInvites(e.id, 6, 72); // all due for a nudge
      await fillDailyQuota(DAILY_INVITE_LIMIT - 4);
      const others = await Promise.all(Array.from({length: 3}, () => createEvent()));
      const results = await Promise.all([
        ...old.slice(0, 4).map(i => admin.post(inv(e.id, `/${i.id}/resend`))),
        admin2.post(inv(e.id, '/resend')), // wants 6 (or what is left of them): never fits in 4 alongside others
        ...others.map((o, n) => admin2.post(inv(o.id), {emails: `new${n}@x.test`})),
      ]);
      for (const r of results) {
        if (r.status >= 300) {
          expect(r.status).toBe(409);
          expect(errorCode(r.json)).toBe('daily_invite_limit');
        }
      }
      expect(await inviteEmailsLastDay()).toBeLessThanOrEqual(DAILY_INVITE_LIMIT);
      expect(results.filter(r => r.status === 409).length).toBeGreaterThan(0);
      // Every invite whose cooldown was started also had its email queued (no half-done send).
      const nudged = await db.invite.findMany({where: {eventId: e.id, lastResentAt: {not: null}}, select: {id: true}});
      const queued = await db.guestEmailOutbox.findMany({where: {inviteId: {in: old.map(o => o.id)}}, select: {inviteId: true}});
      expect(new Set(queued.map(q => q.inviteId))).toEqual(new Set(nudged.map(n => n.id)));
    });

    it('single resend counts against the limit and leaves the invite untouched when refused', async () => {
      const e = await createEvent();
      const [one] = await seedInvites(e.id, 1, 72);
      await fillDailyQuota(DAILY_INVITE_LIMIT);
      const res = await admin.post(inv(e.id, `/${one!.id}/resend`));
      expect(res.status).toBe(409);
      expect(errorCode(res.json)).toBe('daily_invite_limit');
      expect((await db.invite.findUniqueOrThrow({where: {id: one!.id}})).lastResentAt).toBeNull();
      expect(await db.guestEmailOutbox.count({where: {inviteId: one!.id}})).toBe(0);
      // Bulk resend is refused the same way, and starts no cooldown.
      const bulk = await admin.post(inv(e.id, '/resend'));
      expect(bulk.status).toBe(409);
      expect((await db.invite.findUniqueOrThrow({where: {id: one!.id}})).lastResentAt).toBeNull();
    });

    it('deleting and re-creating an invite still counts each send', async () => {
      const e = await createEvent();
      await fillDailyQuota(DAILY_INVITE_LIMIT - 1);
      expect((await admin.post(inv(e.id), {emails: 'loop@x.test'})).status).toBe(201);
      const row = await db.invite.findFirstOrThrow({where: {email: 'loop@x.test'}});
      expect((await admin.delete(inv(e.id, `/${row.id}`))).status).toBe(200);
      const again = await admin.post(inv(e.id), {emails: 'loop@x.test'});
      expect(again.status).toBe(409);
      expect(errorCode(again.json)).toBe('daily_invite_limit');
      expect(await inviteEmailsLastDay()).toBe(DAILY_INVITE_LIMIT);
    });
  });

  describe('bulk resend double click', () => {
    it('two concurrent bulk resends queue each invite at most once', async () => {
      const e = await createEvent();
      const rows = await seedInvites(e.id, 12, 72);
      const [a, b] = await Promise.all([admin.post(inv(e.id, '/resend')), admin.post(inv(e.id, '/resend'))]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect((a.json.resent as number) + (b.json.resent as number)).toBe(12);
      const perInvite = await db.guestEmailOutbox.groupBy({by: ['inviteId'], where: {kind: 'invite'}, _count: {_all: true}});
      expect(perInvite).toHaveLength(12);
      for (const g of perInvite) expect(g._count._all).toBe(1);
      expect(await db.invite.count({where: {eventId: e.id, lastResentAt: null}})).toBe(0);
      expect(rows).toHaveLength(12);
    });

    it('five concurrent bulk resends from two admins still queue each invite once', async () => {
      const e = await createEvent();
      await seedInvites(e.id, 20, 49);
      const results = await Promise.all(Array.from({length: 5}, (_, i) => (i % 2 ? admin : admin2).post(inv(e.id, '/resend'))));
      expect(results.every(r => r.status === 200)).toBe(true);
      expect(results.reduce((s, r) => s + (r.json.resent as number), 0)).toBe(20);
      expect(await db.guestEmailOutbox.count({where: {kind: 'invite'}})).toBe(20);
      // And a later click inside the 48 h cooldown queues nothing.
      expect((await admin.post(inv(e.id, '/resend'))).json).toEqual({resent: 0, remaining: 0});
      expect(await db.guestEmailOutbox.count({where: {kind: 'invite'}})).toBe(20);
    });

    it('a bulk resend while the first send is still pending queues nothing for those invites', async () => {
      const e = await createEvent();
      const created = await admin.post(inv(e.id), {emails: 'p1@x.test p2@x.test p3@x.test'});
      expect(created.status).toBe(201);
      // The no-op drain left the three first sends pending: invites are `queued`, never sent.
      expect(await db.guestEmailOutbox.count({where: {kind: 'invite', status: 'pending'}})).toBe(3);
      // One more invite that WAS sent long ago: only it is nudged.
      const [done] = await seedInvites(e.id, 1, 72, 'z');
      const res = await admin.post(inv(e.id, '/resend'));
      expect(res.status).toBe(200);
      expect(res.json.resent).toBe(1);
      const pendingIds = (await db.invite.findMany({where: {eventId: e.id, email: {startsWith: 'p'}}, select: {id: true}})).map(r => r.id);
      expect(await db.guestEmailOutbox.count({where: {inviteId: {in: pendingIds}}})).toBe(3);
      expect(await db.invite.count({where: {id: {in: pendingIds}, lastResentAt: {not: null}}})).toBe(0);
      expect(await db.guestEmailOutbox.count({where: {inviteId: done!.id}})).toBe(1);
    });

    // Was a bug: resend-preview counts invites whose first email is still pending (queued, sentAt null), but the resend skips them.
    it('resend-preview matches what a resend would queue while first sends are pending', async () => {
      const e = await createEvent();
      await admin.post(inv(e.id), {emails: 'q1@x.test q2@x.test'});
      const preview = await admin.get(inv(e.id, '/resend-preview'));
      const res = await admin.post(inv(e.id, '/resend'));
      expect(preview.json.count).toBe(res.json.resent);
    });

    // Was a bug: the bulk resend picked its page and total without leaving out invites still pending in the
    // outbox, so when a full page of them sorted first every click picked the same ones and queued nothing.
    it('pending-in-outbox invites sorting first never fill the page: the click queues the resendable ones', async () => {
      const e = await createEvent();
      await seedInvites(e.id, 205, 72, 'a'); // more than one page (MAX_INVITES_PER_REQUEST = 200)
      const pending = await db.invite.findMany({where: {eventId: e.id}, select: {id: true}});
      const createdAt = new Date(Date.now() - HOUR);
      await db.guestEmailOutbox.createMany({
        data: pending.map((p, i) => ({idempotencyKey: `it-pending-${i}`, kind: 'invite', status: 'pending', inviteId: p.id, createdAt})),
      });
      await seedInvites(e.id, 5, 72, 'z'); // resendable, sorting after every pending one
      const preview = await admin.get(inv(e.id, '/resend-preview'));
      expect(preview.json.count).toBe(5);
      const res = await admin.post(inv(e.id, '/resend'));
      expect(res.status).toBe(200);
      expect(res.json).toEqual({resent: 5, remaining: 0});
      expect((await admin.get(inv(e.id, '/resend-preview'))).json.count).toBe(res.json.remaining);
      const zIds = (await db.invite.findMany({where: {eventId: e.id, email: {startsWith: 'z'}}, select: {id: true}})).map(r => r.id);
      expect(await db.guestEmailOutbox.count({where: {inviteId: {in: zIds}}})).toBe(5);
      // No pending invite was nudged a second time.
      expect(await db.invite.count({where: {id: {in: pending.map(p => p.id)}, lastResentAt: {not: null}}})).toBe(0);
      expect(await db.guestEmailOutbox.count({where: {inviteId: {in: pending.map(p => p.id)}}})).toBe(205);
    });
  });

  describe('single resend', () => {
    it('queues one email and starts the cooldown', async () => {
      const e = await createEvent();
      const [one] = await seedInvites(e.id, 1, 72);
      const res = await admin.post(inv(e.id, `/${one!.id}/resend`));
      expect(res.status).toBe(200);
      expect(await db.guestEmailOutbox.count({where: {inviteId: one!.id, kind: 'invite'}})).toBe(1);
      expect((await db.invite.findUniqueOrThrow({where: {id: one!.id}})).lastResentAt).not.toBeNull();
      // The cooldown it started keeps the invite out of a bulk resend.
      expect((await admin.post(inv(e.id, '/resend'))).json).toEqual({resent: 0, remaining: 0});
    });

    // Was a bug: single resend ignores the 48 h cooldown, so repeated clicks email the same guest again and again (US-14).
    it('a second single resend inside the 48 h cooldown queues no second email', async () => {
      const e = await createEvent();
      const [one] = await seedInvites(e.id, 1, 72);
      expect((await admin.post(inv(e.id, `/${one!.id}/resend`))).status).toBe(200);
      await new Promise(r => setTimeout(r, 5)); // a distinct millisecond: a real second click
      const second = await admin.post(inv(e.id, `/${one!.id}/resend`));
      expect(second.status).toBe(409);
      // Its own resend is still pending here (no-op drain), so either refusal is right.
      expect(['resend_cooldown', 'invite_pending']).toContain(errorCode(second.json));
      expect(await db.guestEmailOutbox.count({where: {inviteId: one!.id}})).toBe(1);
      // Once that email has gone out, the cooldown alone refuses the next click.
      await db.guestEmailOutbox.updateMany({where: {inviteId: one!.id}, data: {status: 'sent'}});
      const third = await admin.post(inv(e.id, `/${one!.id}/resend`));
      expect(third.status).toBe(409);
      expect(errorCode(third.json)).toBe('resend_cooldown');
      expect(await db.guestEmailOutbox.count({where: {inviteId: one!.id}})).toBe(1);
    });

    // Was a bug: single resend does not check for a pending first send, so a nudge before delivery is a second email.
    it('a single resend while the first send is still pending queues nothing', async () => {
      const e = await createEvent();
      await admin.post(inv(e.id), {emails: 'pending@x.test'});
      const row = await db.invite.findFirstOrThrow({where: {email: 'pending@x.test'}});
      const res = await admin.post(inv(e.id, `/${row.id}/resend`));
      expect(res.status).toBe(409);
      expect(errorCode(res.json)).toBe('invite_pending');
      expect(await db.guestEmailOutbox.count({where: {inviteId: row.id}})).toBe(1);
    });

    // Was a bug: single resend nudges a bounced invite (the bulk rule excludes bounced addresses).
    it('refuses a bounced invite', async () => {
      const e = await createEvent();
      const [one] = await seedInvites(e.id, 1, 72);
      await db.invite.update({where: {id: one!.id}, data: {status: 'bounced'}});
      const res = await admin.post(inv(e.id, `/${one!.id}/resend`));
      expect(res.status).toBe(409);
      expect(await db.guestEmailOutbox.count({where: {inviteId: one!.id}})).toBe(0);
    });

    it("404s an invite of another event (never resends across events)", async () => {
      const e = await createEvent();
      const other = await createEvent();
      const [theirs] = await seedInvites(other.id, 1, 72);
      expect((await admin.post(inv(e.id, `/${theirs!.id}/resend`))).status).toBe(404);
      expect((await admin.delete(inv(e.id, `/${theirs!.id}`))).status).toBe(404);
      expect(await db.guestEmailOutbox.count()).toBe(0);
      expect(await db.invite.count({where: {id: theirs!.id}})).toBe(1);
    });
  });

  describe('drafts (M-14)', () => {
    it('create, bulk resend and single resend all answer 409 event_not_published and queue nothing', async () => {
      const draft = await createEvent('draft');
      const [one] = await seedInvites(draft.id, 1, 72);
      const create = await admin.post(inv(draft.id), {emails: 'd@x.test'});
      expect(create.status).toBe(409);
      expect(errorCode(create.json)).toBe('event_not_published');
      const bulk = await admin.post(inv(draft.id, '/resend'));
      expect(bulk.status).toBe(409);
      expect(errorCode(bulk.json)).toBe('event_not_published');
      const single = await admin.post(inv(draft.id, `/${one!.id}/resend`));
      expect(single.status).toBe(409);
      expect(errorCode(single.json)).toBe('event_not_published');
      expect(await db.guestEmailOutbox.count()).toBe(0);
      expect(await db.invite.count({where: {eventId: draft.id}})).toBe(1);
    });

    it('a soft-deleted event is 404 for every invite route', async () => {
      const e = await createEvent();
      const [one] = await seedInvites(e.id, 1, 72);
      await db.event.update({where: {id: e.id}, data: {deletedAt: new Date()}});
      expect((await admin.post(inv(e.id), {emails: 'x@x.test'})).status).toBe(404);
      expect((await admin.post(inv(e.id, '/resend'))).status).toBe(404);
      expect((await admin.post(inv(e.id, `/${one!.id}/resend`))).status).toBe(404);
      expect((await admin.get(inv(e.id))).status).toBe(404);
    });
  });

  describe('access', () => {
    it('anonymous gets 401 and a member without event management 403 on every invite route; nothing is queued', async () => {
      const e = await createEvent();
      const [one] = await seedInvites(e.id, 1, 72);
      const calls = (b: Browser) => [
        b.get(inv(e.id)),
        b.post(inv(e.id), {emails: 'a@x.test'}),
        b.get(inv(e.id, '/resend-preview')),
        b.post(inv(e.id, '/resend')),
        b.post(inv(e.id, `/${one!.id}/resend`)),
        b.delete(inv(e.id, `/${one!.id}`)),
        b.get(`/site-api/event-admin/events/${e.id}/share-kit`),
      ];
      for (const r of await Promise.all(calls(guest))) expect(r.status).toBe(401);
      for (const r of await Promise.all(calls(member))) expect(r.status).toBe(403);
      expect(await db.guestEmailOutbox.count()).toBe(0);
      expect(await db.invite.count()).toBe(1);
      expect((await db.invite.findUniqueOrThrow({where: {id: one!.id}})).lastResentAt).toBeNull();
    });

    // Was a bug: the body validator runs before withViewer/requireAuth, so an anonymous caller gets 422, not 401 (audit L-4).
    it('anonymous with an invalid body still gets 401, not 422', async () => {
      const e = await createEvent();
      expect((await guest.post(inv(e.id), {})).status).toBe(401);
    });

    // Was a bug: same as above (L-4): a signed-in member without permission also gets 422 before the 403.
    it('a member with an invalid body gets 403, not 422', async () => {
      const e = await createEvent();
      expect((await member.post(inv(e.id), {})).status).toBe(403);
    });
  });
});
