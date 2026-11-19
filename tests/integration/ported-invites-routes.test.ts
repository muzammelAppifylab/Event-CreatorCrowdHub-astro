import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {authRoutes} from '../../src/platform/auth';
import {csrf, previewCookies, sameOrigin} from '../../src/platform/guards';
import {syncPermissions} from '../../src/platform/permission-sync';
import {authSettings} from '../../src/server/auth-settings';
import {CATALOGUE} from '../../src/server/permissions';
import {adminInviteRoutes} from '../../src/server/routes/admin-invites';
import {defineBackground} from '../../src/platform/background';
import {OUTBOX_LIST} from '../../src/server/jobs/outbox';
import {drainGuestEmailOutbox, type Deliver} from '../../src/server/jobs/outbox-drain';
import {verifyToken} from '../../src/domain/tokens';
import {resetEvents, setRoles} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

const mail = {sent: [] as {to: string; subject: string}[], fail: new Set<string>()};

/**
 * Invites are only QUEUED in the guest email outbox; the kick after the commit runs the outbox
 * drain inline (jobs run locally in tests), sending through this fake provider. An address in
 * `fail` is refused (permanent: the outbox row is failed, the invite stays as it was).
 */
const deliver: Deliver = async email => {
  if (mail.fail.has(email.to)) return {outcome: 'rejected'};
  mail.sent.push({to: email.to, subject: email.content.subject});
  return {outcome: 'sent'};
};
function registerOutboxDrain() {
  defineBackground({
    [OUTBOX_LIST]: async () => {
      for (let i = 0; i < 10; i++) {
        const run = await drainGuestEmailOutbox(db as never, new Date(), {deliver, providerConfigured: true});
        if (!run.more) break;
      }
    },
  });
}

/** Same middleware chain as src/server/app.ts, with the event admin routes mounted at /event-admin. */
export const app = new Hono()
  .basePath('/site-api')
  .use(previewCookies)
  .use(sameOrigin)
  .use(csrf)
  .use(bodyLimit({maxSize: 1024 * 1024}))
  .use(syncPermissions(CATALOGUE))
  .route('/auth', authRoutes(authSettings))
  .route('/event-admin', adminInviteRoutes);

/** Sign up through THIS app (email verification on, as the harness expects), then hold exactly `roles`. */
async function userWith(email: string, roles: string[], ip: string) {
  const b = await signedIn(app, email, undefined, ip);
  await setRoles(email, ...roles);
  return b;
}

/** Inserted directly: the admin-events API is not under test here. */
let seq = 0;
async function createEvent(_admin: Browser, over: Record<string, unknown> = {}, publish = true) {
  seq += 1;
  return db.event.create({
    data: {
      slug: `launch-party-${seq}`,
      title: 'Launch party',
      startAt: new Date(Date.now() + 10 * 24 * 3_600_000),
      endAt: new Date(Date.now() + 10 * 24 * 3_600_000 + 3_600_000),
      timezone: 'UTC',
      format: 'in_person',
      venueName: 'The Hall',
      venueAddress: '1 Main St',
      status: publish ? 'published' : 'draft',
      pollJoinCode: `P${String(seq).padStart(5, '0')}`,
      ...over,
    },
    select: {id: true, slug: true},
  });
}

const HOUR = 3_600_000;
const inv = (id: string, rest = '') => `/site-api/event-admin/events/${id}/invites${rest}`;
const JWT = 'integration-test-secret-0123456789-abcdefghijklmnop';

describe.skipIf(!DATABASE_URL)('admin invites (integration, real Postgres)', () => {
  let admin: Browser;
  let member: Browser;
  let guest: Browser;

  beforeAll(() => {
    configureEnv();
    registerOutboxDrain();
  });
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    mail.sent.length = 0;
    mail.fail.clear();
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
    member = await userWith('member@example.test', ['member'], '203.0.113.4');
    guest = new Browser(app, '203.0.113.9');
  });

  // Sessions are cookie based, so browsers signed in on the fixture app work on this one too.
  const ev = () => createEvent(admin);

  it('gates: guest 401, non-manager 403, manager ok', async () => {
    const e = await ev();
    expect((await guest.get(inv(e.id))).status).toBe(401);
    expect((await guest.post(inv(e.id), {emails: 'a@x.com'})).status).toBe(401);
    expect((await member.get(inv(e.id))).status).toBe(403);
    expect((await member.post(inv(e.id), {emails: 'a@x.com'})).status).toBe(403);
    expect((await member.post(inv(e.id, '/resend'))).status).toBe(403);
    expect((await member.get(inv(e.id, '/resend-preview'))).status).toBe(403);
    expect((await member.get(`/site-api/event-admin/events/${e.id}/share-kit`)).status).toBe(403);
    expect((await admin.get(inv(e.id))).status).toBe(200);
  });

  it('creates invites with signed per-invite links, sends mail, audits', async () => {
    const e = await ev();
    const res = await admin.post(inv(e.id), {emails: 'ana@x.com, Bob <bob@x.com>, nope'});
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({queued: 2, sent: 2, skippedInvalid: ['nope'], skippedDuplicate: []});
    expect(mail.sent.map(m => m.to).sort()).toEqual(['ana@x.com', 'bob@x.com']);
    expect(mail.sent[0]!.subject).toContain('invited');

    const list = await admin.get(inv(e.id));
    const items = list.json.items as {id: string; email: string; name: string | null; status: string; link: string; sentAt: string}[];
    expect(items.map(i => i.email)).toEqual(['ana@x.com', 'bob@x.com']);
    expect(items.find(i => i.email === 'bob@x.com')!.name).toBe('Bob');
    for (const i of items) {
      expect(i.status).toBe('sent');
      expect(i.sentAt).toBeTruthy();
      const url = new URL(i.link);
      expect(url.searchParams.get('e')).toBe(e.slug);
      expect(verifyToken(url.pathname.slice('/i/'.length), 'invite', JWT)).toEqual({eventId: e.id, inviteId: i.id});
    }
    const audits = await db.auditEvent.findMany({where: {action: 'invites_sent'}});
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({targetType: 'event', targetId: e.id});
    expect(audits[0]!.meta).toEqual({queued: 2});
  });

  it('keeps an invite queued when the mailer fails', async () => {
    const e = await ev();
    mail.fail.add('bad@x.com');
    const res = await admin.post(inv(e.id), {emails: 'ok@x.com bad@x.com'});
    expect(res.json).toMatchObject({queued: 2});
    expect(mail.sent.map(m => m.to)).toEqual(['ok@x.com']);
    expect(await db.guestEmailOutbox.count({where: {kind: 'invite', status: 'failed'}})).toBe(1);
    const rows = await db.invite.findMany({select: {email: true, status: true}});
    expect(Object.fromEntries(rows.map(r => [r.email, r.status]))).toEqual({'ok@x.com': 'sent', 'bad@x.com': 'queued'});
  });

  it('skips already invited and repeated addresses; dedupes per event', async () => {
    const e = await ev();
    await admin.post(inv(e.id), {emails: 'ana@x.com'});
    mail.sent.length = 0;
    const res = await admin.post(inv(e.id), {emails: 'ANA@x.com\nnew@x.com\nnew@x.com'});
    expect(res.json.queued).toBe(1);
    expect((res.json.skippedDuplicate as string[]).sort()).toEqual(['ana@x.com', 'new@x.com']);
    expect(mail.sent.map(m => m.to)).toEqual(['new@x.com']);
    expect(await db.invite.count()).toBe(2);

    const other = await createEvent(admin, {title: 'Other'});
    expect((await admin.post(inv(other.id), {emails: 'ana@x.com'})).json.queued).toBe(1);
  });

  it('limits one request to 200 invites (ok at 200, 422 at 201)', async () => {
    const e = await ev();
    const make = (n: number) => Array.from({length: n}, (_, i) => `g${i}@x.com`).join(', ');
    const over = await admin.post(inv(e.id), {emails: make(201)});
    expect(over.status).toBe(422);
    expect((over.json.fields as Record<string, string>).emails).toContain('200');
    expect(await db.invite.count()).toBe(0);
    expect((await admin.post(inv(e.id), {emails: make(200)})).status).toBe(201);
    expect(await db.invite.count()).toBe(200);
  });

  it('validates the body and the event id', async () => {
    const e = await ev();
    expect((await admin.post(inv(e.id), {})).status).toBe(422);
    expect((await admin.post(inv(e.id), {emails: '   '})).status).toBe(422);
    expect((await admin.post(inv(e.id), {emails: 42})).status).toBe(422);
    expect((await admin.post(inv('00000000-0000-4000-8000-000000000000'), {emails: 'a@x.com'})).status).toBe(404);
    expect((await admin.post(inv('nope'), {emails: 'a@x.com'})).status).toBe(404);
    expect((await admin.get(inv('nope'))).status).toBe(404);
  });

  it('refuses new invites and resends for a cancelled event', async () => {
    const e = await ev();
    await db.event.update({where: {id: e.id}, data: {status: 'cancelled'}});
    expect((await admin.post(inv(e.id), {emails: 'a@x.com'})).status).toBe(409);
    expect((await admin.post(inv(e.id, '/resend'))).status).toBe(409);
  });

  it('refuses invites and resends for a draft (M-14): its links would have no page', async () => {
    const draft = await createEvent(admin, {}, false);
    const res = await admin.post(inv(draft.id), {emails: 'a@x.com'});
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('event_not_published');
    expect((await admin.post(inv(draft.id, '/resend'))).status).toBe(409);
    expect(await db.invite.count({where: {eventId: draft.id}})).toBe(0);
    expect(mail.sent).toEqual([]);
    // Without event management it is still 403 before anything else.
    expect((await member.post(inv(draft.id), {emails: 'a@x.com'})).status).toBe(403);
  });

  it('caps invite emails at 2,000 per rolling 24h with 409 daily_invite_limit', async () => {
    const e = await ev();
    const recent = new Date(Date.now() - HOUR);
    // The cap counts invite emails queued in the outbox in the last 24 hours, across every event.
    await db.guestEmailOutbox.createMany({
      data: Array.from({length: 1999}, (_, i) => ({idempotencyKey: `invite-old-${i}`, kind: 'invite', status: 'sent', createdAt: recent})),
    });
    const over = await admin.post(inv(e.id), {emails: 'a@x.com, b@x.com'});
    expect(over.status).toBe(409);
    expect(JSON.stringify(over.json)).toContain('daily_invite_limit');
    expect(mail.sent).toEqual([]);
    expect((await admin.post(inv(e.id), {emails: 'a@x.com'})).status).toBe(201);
    // A day later the window has moved on.
    await db.guestEmailOutbox.updateMany({data: {createdAt: new Date(Date.now() - 25 * HOUR)}});
    expect((await admin.post(inv(e.id), {emails: 'b@x.com, c@x.com'})).status).toBe(201);
  });

  it('pages the list 100 at a time by email', async () => {
    const e = await ev();
    await db.invite.createMany({
      data: Array.from({length: 150}, (_, i) => ({eventId: e.id, email: `g${String(i).padStart(3, '0')}@x.com`, token: `t${i}`})),
    });
    const first = await admin.get(inv(e.id));
    expect((first.json.items as unknown[]).length).toBe(100);
    expect(first.json.nextBefore).toBe('g099@x.com');
    const second = await admin.get(inv(e.id) + `?before=${encodeURIComponent(first.json.nextBefore as string)}`);
    expect((second.json.items as unknown[]).length).toBe(50);
    expect(second.json.nextBefore).toBeNull();
  });

  describe('resend', () => {
    async function seeded() {
      const e = await ev();
      await admin.post(inv(e.id), {emails: 'a@x.com b@x.com c@x.com d@x.com e@x.com'});
      const id = async (email: string) => (await db.invite.findFirstOrThrow({where: {email}})).id;
      // a: RSVP via invite link, c: marked responded, b: bounced
      await db.rsvp.create({
        data: {eventId: e.id, inviteId: await id('a@x.com'), name: 'a', email: 'a@x.com', response: 'going', status: 'confirmed', ticketCode: 'AAAAAAA1', manageToken: 'm1'},
      });
      await db.invite.update({where: {id: await id('c@x.com')}, data: {status: 'responded'}});
      await db.invite.update({where: {id: await id('b@x.com')}, data: {status: 'bounced'}});
      return {e, id};
    }
    const ago = (h: number) => new Date(Date.now() - h * HOUR);

    it('counts only non-responders past the 48h cooldown', async () => {
      const {e} = await seeded();
      const preview = async () => (await admin.get(inv(e.id, '/resend-preview'))).json.count;
      expect(await preview()).toBe(0);
      await db.invite.updateMany({data: {sentAt: ago(47)}});
      expect(await preview()).toBe(0);
      await db.invite.updateMany({data: {sentAt: ago(49)}});
      expect(await preview()).toBe(2); // d and e
      const list = (await admin.get(inv(e.id))).json.items as {email: string; status: string; rsvpResponse: string | null}[];
      expect(Object.fromEntries(list.map(i => [i.email, [i.status, i.rsvpResponse]]))).toEqual({
        'a@x.com': ['responded', 'going'],
        'b@x.com': ['bounced', null],
        'c@x.com': ['responded', null],
        'd@x.com': ['sent', null],
        'e@x.com': ['sent', null],
      });
    });

    it('resends once then not again within 48h; audits', async () => {
      const {e} = await seeded();
      await db.invite.updateMany({data: {sentAt: ago(72)}});
      mail.sent.length = 0;
      const res = await admin.post(inv(e.id, '/resend'));
      expect(res.json).toEqual({resent: 2, remaining: 0});
      expect(mail.sent.map(m => m.to).sort()).toEqual(['d@x.com', 'e@x.com']);
      expect((await db.invite.findFirstOrThrow({where: {email: 'd@x.com'}})).lastResentAt).not.toBeNull();
      expect((await admin.post(inv(e.id, '/resend'))).json).toEqual({resent: 0, remaining: 0});
      const audits = await db.auditEvent.findMany({where: {action: 'invites_resent'}, orderBy: {id: 'asc'}});
      expect(audits).toHaveLength(2);
      expect(audits[0]!.meta).toEqual({resent: 2});
    });

    it('resends one invite once its cooldown is over, 409 inside it; 409 responded, 404 unknown; a refused email is a failed outbox row', async () => {
      const {e, id} = await seeded();
      // Inside the 48 h cooldown a single resend is refused too (it used to skip the cooldown).
      expect((await admin.post(inv(e.id, `/${await id('d@x.com')}/resend`))).json).toMatchObject({error: 'resend_cooldown'});
      await db.invite.updateMany({data: {sentAt: ago(72)}});
      mail.sent.length = 0;
      const ok = await admin.post(inv(e.id, `/${await id('d@x.com')}/resend`));
      expect(ok.status).toBe(200);
      expect(mail.sent.map(m => m.to)).toEqual(['d@x.com']);
      // A second click right after is inside the new cooldown.
      expect((await admin.post(inv(e.id, `/${await id('d@x.com')}/resend`))).status).toBe(409);
      expect((await admin.post(inv(e.id, `/${await id('a@x.com')}/resend`))).status).toBe(409);
      expect((await admin.post(inv(e.id, `/${await id('c@x.com')}/resend`))).status).toBe(409);
      expect((await admin.post(inv(e.id, '/00000000-0000-4000-8000-000000000000/resend'))).status).toBe(404);
      expect((await admin.post(inv(e.id, '/junk/resend'))).status).toBe(404);
      mail.fail.add('e@x.com');
      // The request only queues: it answers 200, and the refusal is recorded on the outbox row.
      expect((await admin.post(inv(e.id, `/${await id('e@x.com')}/resend`))).status).toBe(200);
      expect(await db.guestEmailOutbox.count({where: {kind: 'invite', inviteId: await id('e@x.com'), status: 'failed'}})).toBe(1);
      expect(await db.auditEvent.count({where: {action: 'invite_resent'}})).toBe(2);
    });

    it('caps a bulk resend at 200 and reports the remainder', async () => {
      const e = await ev();
      await db.invite.createMany({data: Array.from({length: 205}, (_, i) => ({eventId: e.id, email: `q${i}@x.com`, token: `qt${i}`}))});
      const res = await admin.post(inv(e.id, '/resend'));
      expect(res.json).toEqual({resent: 200, remaining: 5});
    });
  });

  it('revokes (deletes) an invite and 404s repeats', async () => {
    const e = await ev();
    await admin.post(inv(e.id), {emails: 'a@x.com'});
    const row = await db.invite.findFirstOrThrow();
    expect((await member.delete(inv(e.id, `/${row.id}`))).status).toBe(403);
    expect((await guest.delete(inv(e.id, `/${row.id}`))).status).toBe(401);
    expect((await admin.delete(inv(e.id, `/${row.id}`))).json).toEqual({ok: true});
    expect(await db.invite.count()).toBe(0);
    expect((await admin.delete(inv(e.id, `/${row.id}`))).status).toBe(404);
    expect((await admin.delete(inv(e.id, '/junk'))).status).toBe(404);
  });

  it('serves the share kit', async () => {
    const e = await ev();
    const res = await admin.get(`/site-api/event-admin/events/${e.id}/share-kit`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({slug: e.slug, published: true});
    expect(res.json.eventUrl).toBe(`${res.json.base}/e/${e.slug}`);
    const draft = await createEvent(admin, {title: 'Draft one'}, false);
    expect((await admin.get(`/site-api/event-admin/events/${draft.id}/share-kit`)).json.published).toBe(false);
    expect((await admin.get('/site-api/event-admin/events/junk/share-kit')).status).toBe(404);
  });
});
