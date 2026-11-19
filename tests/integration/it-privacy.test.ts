import {createHash} from 'node:crypto';

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {hashToken, newToken} from '../../src/domain/secureToken';
import {signToken} from '../../src/domain/tokens';
import {getDb} from '../../src/platform/db';
import {inRequestScope} from '../../src/platform/request-scope';
import {runRetention} from '../../src/server/jobs/retention';
import {consentToken, unsubscribeToken} from '../../src/server/privacy';
import {PRIVACY_LIMITS} from '../../src/server/routes/privacy';
import {createEvent, eventsApp, resetEvents, rsvpBody, userWith} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

/**
 * Guest privacy end to end against a real Postgres (audit M-4, M-9, M-23, M-24, M-25, M-26, M-27,
 * L-40, L-42): erase, retention re-apply, unsubscribe, export, the privacy-link rate limit, and the
 * links surviving an unpublished or deleted event. Events and guests are mostly created straight in
 * the database; the routes under test are the real `/privacy` and `/rsvp` routers.
 */
const PR = '/site-api/privacy';
const DAY = 86_400_000;
const SECRET = 'integration-test-secret-0123456789-abcdefghijklmnop'; // harness configureEnv's JWT_SECRET
let ipSeq = 10;
const guest = () => new Browser(eventsApp, `198.51.100.${ipSeq++ % 250}`);
let seq = 0;
const code = () => `PV${String(seq++).padStart(6, '0')}`;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function mkEvent(over: Record<string, unknown> = {}) {
  const start = new Date(Date.now() + 7 * DAY);
  const n = seq++;
  return db.event.create({
    data: {
      slug: `privacy-${n}`, title: 'Privacy Night', startAt: start, endAt: new Date(start.getTime() + 3_600_000), timezone: 'UTC',
      format: 'online', status: 'published', pollJoinCode: `Q${String(n).padStart(5, '0')}`, capacity: 1, ...over,
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

/** A paid checkout for this RSVP: the site's ticket order and the payment platform's order row. */
async function mkPaidOrder(rsvpId: string, email: string) {
  const checkoutId = `cs_test_${seq++}`;
  await db.ticketOrder.create({data: {rsvpId, checkoutId, amountCents: 1500, currency: 'USD', status: 'paid'}});
  await db.order.create({
    data: {checkoutId, priceKey: 'ticket', email, status: 'paid', amountCents: 1500, currency: 'USD', metadata: {rsvpId, eventSlug: 'x'}, paidAt: new Date()},
  });
  return checkoutId;
}

async function outboxFor(rsvpId: string) {
  return db.guestEmailOutbox.findMany({where: {rsvpId}, select: {kind: true, status: true}});
}

/** The retention job as the scheduler runs it (inside a request scope, so its emails can queue). */
const retention = (now = new Date()) =>
  inRequestScope(async () => {
    try {
      return await runRetention(db, now);
    } finally {
      await getDb()?.$disconnect();
    }
  });

describe.skipIf(!DATABASE_URL)('guest privacy (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    await db.$executeRawUnsafe('TRUNCATE "orders", "guest_erasures", "privacy_attempts" RESTART IDENTITY');
  });

  describe('erase', () => {
    it('scrubs the payment record, deletes answers and the invite, logs the erasure, confirms the next free-event guest and queues their email', async () => {
      const ev = await mkEvent({capacity: 1});
      const q = await db.rsvpQuestion.create({data: {eventId: ev.id, label: 'Diet', type: 'short_text'}});
      const {rsvp, token} = await mkGuest(ev.id, 'erase-me@example.test', {marketingConsent: true, consentConfirmedAt: new Date(), utmSource: 'news'});
      await db.rsvpAnswer.create({data: {rsvpId: rsvp.id, questionId: q.id, value: 'vegan'}});
      await db.invite.create({data: {eventId: ev.id, email: 'Erase-Me@example.test', name: 'Erin', token: `inv-${seq++}`}});
      const checkoutId = await mkPaidOrder(rsvp.id, 'erase-me@example.test');
      // Somebody else's order is not touched.
      const other = await mkGuest(ev.id, 'other@example.test', {status: 'declined', response: 'not_going'});
      const otherCheckout = await mkPaidOrder(other.rsvp.id, 'other@example.test');
      const next = await mkGuest(ev.id, 'next@example.test', {status: 'waitlisted', waitlistPosition: 1});
      const after = await mkGuest(ev.id, 'after@example.test', {status: 'waitlisted', waitlistPosition: 2});

      const res = await guest().post(`${PR}/guest/${token}/erase`, {confirm: 'erase'});
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.json)).not.toContain(token);

      // The RSVP is anonymised and released.
      const erased = await db.rsvp.findUniqueOrThrow({where: {id: rsvp.id}});
      expect(erased.email).toMatch(/@invalid$/);
      expect(erased.name).not.toContain('erase-me');
      expect(erased.status).toBe('cancelled');
      expect(erased.marketingConsent).toBe(false);
      expect(erased.consentConfirmedAt).toBeNull();
      expect(erased.utmSource).toBeNull();
      expect(erased.manageToken).not.toBe(hashToken(token));
      expect(await db.rsvpAnswer.count({where: {rsvpId: rsvp.id}})).toBe(0);
      expect(await db.invite.count({where: {eventId: ev.id}})).toBe(0);

      // The payment record keeps the money, not the person (M-24).
      const order = await db.order.findUniqueOrThrow({where: {checkoutId}});
      expect(order.email).toBeNull();
      expect(order.metadata).toEqual({eventSlug: 'x'});
      expect([order.status, order.amountCents]).toEqual(['paid', 1500]);
      const untouched = await db.order.findUniqueOrThrow({where: {checkoutId: otherCheckout}});
      expect(untouched.email).toBe('other@example.test');
      expect(untouched.metadata).toEqual({rsvpId: other.rsvp.id, eventSlug: 'x'});

      // The erasure log: a hash of the address, never the address (M-27).
      const log = await db.guestErasure.findMany();
      expect(log).toHaveLength(1);
      expect(log[0]!.emailHash).toBe(sha256('erase-me@example.test'));
      expect(log[0]!.eventId).toBe(ev.id);
      expect(JSON.stringify(log)).not.toContain('erase-me');

      // The freed seat goes to the first in line (M-9), the rest move up, and the email is queued.
      const promoted = await db.rsvp.findUniqueOrThrow({where: {id: next.rsvp.id}});
      expect(promoted.status).toBe('confirmed');
      expect(promoted.waitlistPosition).toBeNull();
      expect((await db.rsvp.findUniqueOrThrow({where: {id: after.rsvp.id}})).waitlistPosition).toBe(1);
      expect((await outboxFor(next.rsvp.id)).map(r => r.kind)).toEqual(['confirmation']);
      expect(await outboxFor(after.rsvp.id)).toEqual([]);

      // The old link is dead everywhere.
      const g = guest();
      expect((await g.get(`${PR}/guest/${token}`)).status).toBe(404);
      expect((await g.get(`${PR}/guest/${token}/export`)).status).toBe(404);
      expect((await g.post(`${PR}/guest/${token}/erase`, {confirm: 'erase'})).status).toBe(404);
      expect(await db.guestErasure.count()).toBe(1);
    });

    it('on a paid event the next guest is OFFERED the seat (a claim deadline), still waitlisted, and the offer email is queued', async () => {
      const ev = await mkEvent({capacity: 1});
      const paid = await db.ticketType.create({data: {eventId: ev.id, name: 'Paid', priceCents: 1500, currency: 'USD'}});
      const {rsvp, token} = await mkGuest(ev.id, 'payer@example.test', {ticketTypeId: paid.id});
      const checkoutId = await mkPaidOrder(rsvp.id, 'payer@example.test');
      const next = await mkGuest(ev.id, 'next-paid@example.test', {status: 'waitlisted', waitlistPosition: 1, ticketTypeId: paid.id});

      expect((await guest().post(`${PR}/guest/${token}/erase`, {confirm: 'ERASE '})).status).toBe(200);

      const offered = await db.rsvp.findUniqueOrThrow({where: {id: next.rsvp.id}});
      expect(offered.status).toBe('waitlisted');
      expect(offered.claimExpiresAt).not.toBeNull();
      expect(offered.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect((await outboxFor(next.rsvp.id)).map(r => r.kind)).toEqual(['waitlist_offer']);
      const order = await db.order.findUniqueOrThrow({where: {checkoutId}});
      expect(order.email).toBeNull();
      expect(order.metadata).toEqual({eventSlug: 'x'});
    });

    it('refuses without the typed confirmation, and refuses a guest in checkout (409) without touching anything', async () => {
      const ev = await mkEvent({capacity: 5});
      const {rsvp, token} = await mkGuest(ev.id, 'paying@example.test', {status: 'awaiting_payment'});
      const g = guest();
      expect((await g.post(`${PR}/guest/${token}/erase`, {confirm: 'yes'})).status).toBe(422);
      const res = await g.post(`${PR}/guest/${token}/erase`, {confirm: 'erase'});
      expect(res.status).toBe(409);
      expect((await db.rsvp.findUniqueOrThrow({where: {id: rsvp.id}})).email).toBe('paying@example.test');
      expect(await db.guestErasure.count()).toBe(0);
    });
  });

  describe('retention re-applies erasures after a restore', () => {
    it('erases a restored row created before the erasure and hands its seat to the waitlist', async () => {
      const ev = await mkEvent({capacity: 1});
      const erasedAt = new Date(Date.now() - 2 * DAY);
      // What a backup restore brings back: the row from before the erasure, plus the erasure log.
      const restored = await mkGuest(ev.id, 'restored@example.test', {createdAt: new Date(erasedAt.getTime() - DAY)});
      await db.guestErasure.create({data: {emailHash: sha256('restored@example.test'), eventId: ev.id, erasedAt}});
      const next = await mkGuest(ev.id, 'line@example.test', {status: 'waitlisted', waitlistPosition: 1});
      const bystander = await mkGuest((await mkEvent()).id, 'restored@example.test'); // another event: never erased

      const result = await retention();
      expect(result.reapplied).toBe(1);

      const row = await db.rsvp.findUniqueOrThrow({where: {id: restored.rsvp.id}});
      expect(row.email).toMatch(/@invalid$/);
      expect(row.status).toBe('cancelled');
      expect((await db.rsvp.findUniqueOrThrow({where: {id: next.rsvp.id}})).status).toBe('confirmed');
      expect((await outboxFor(next.rsvp.id)).map(r => r.kind)).toEqual(['confirmation']);
      expect((await db.rsvp.findUniqueOrThrow({where: {id: bystander.rsvp.id}})).email).toBe('restored@example.test');
      expect((await guest().get(`${PR}/guest/${restored.token}`)).status).toBe(404);

      // Idempotent: a second run finds nothing more.
      expect((await retention()).reapplied).toBe(0);
    });

    it('does NOT erase a fresh RSVP the same person made after their erasure', async () => {
      const ev = await mkEvent({capacity: 10});
      const first = await mkGuest(ev.id, 'comeback@example.test');
      expect((await guest().post(`${PR}/guest/${first.token}/erase`, {confirm: 'erase'})).status).toBe(200);
      expect(await db.guestErasure.count()).toBe(1);

      // Make sure the new row's created_at is strictly after erased_at.
      await new Promise(resolve => setTimeout(resolve, 20));
      const again = await guest().post(`/site-api/rsvp/events/${ev.slug}`, rsvpBody('comeback@example.test'));
      expect(again.status).toBe(202);
      const fresh = await db.rsvp.findFirstOrThrow({where: {eventId: ev.id, email: 'comeback@example.test'}});

      const result = await retention();
      expect(result.reapplied).toBe(0);
      const still = await db.rsvp.findUniqueOrThrow({where: {id: fresh.id}});
      expect(still.email).toBe('comeback@example.test');
      expect(still.status).toBe('confirmed');
    });
  });

  describe('unsubscribe', () => {
    it('a signed unsubscribe token switches this person off on EVERY RSVP, keeps the first time, and leaves others alone', async () => {
      const ev1 = await mkEvent({capacity: 10});
      const ev2 = await mkEvent({capacity: 10});
      const confirmedAt = new Date(Date.now() - DAY);
      const a = await mkGuest(ev1.id, 'sub@example.test', {marketingConsent: true, consentConfirmedAt: confirmedAt});
      const b = await mkGuest(ev2.id, 'sub@example.test', {marketingConsent: true, consentConfirmedAt: confirmedAt});
      const other = await mkGuest(ev1.id, 'keep@example.test', {marketingConsent: true, consentConfirmedAt: confirmedAt});
      const signed = unsubscribeToken(a.rsvp.id, SECRET);
      const g = guest();

      const before = await g.get(`${PR}/unsubscribe/${signed}`);
      expect(before.status).toBe(200);
      expect(before.json.state).toBe('confirmed');
      expect(before.headers.get('cache-control')).toContain('no-store');

      const res = await g.post(`${PR}/unsubscribe/${signed}`);
      expect(res.status).toBe(200);
      expect(res.json.state).toBe('off');

      const rows = await db.rsvp.findMany({where: {email: 'sub@example.test'}});
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.marketingConsent).toBe(false);
        expect(row.consentConfirmedAt).toBeNull();
        expect(row.unsubscribedAt).not.toBeNull();
      }
      const firstStamp = rows.map(r => r.unsubscribedAt!.getTime()).sort();
      const kept = await db.rsvp.findUniqueOrThrow({where: {id: other.rsvp.id}});
      expect([kept.marketingConsent, kept.unsubscribedAt]).toEqual([true, null]);

      // The other RSVP's own manage link shows the person as off.
      expect((await g.get(`${PR}/unsubscribe/${b.token}`)).json.state).toBe('off');
      // Again: idempotent, the first time is kept.
      expect((await g.post(`${PR}/unsubscribe/${b.token}`)).status).toBe(200);
      const again = await db.rsvp.findMany({where: {email: 'sub@example.test'}});
      expect(again.map(r => r.unsubscribedAt!.getTime()).sort()).toEqual(firstStamp);
    });

    it('no token can switch consent back on: the old consent link answers "off", and an unsubscribe token is useless on /consent', async () => {
      const ev = await mkEvent({capacity: 10});
      const a = await mkGuest(ev.id, 'nope@example.test', {marketingConsent: true});
      const consent = consentToken(a.rsvp.id, SECRET);
      const g = guest();
      expect((await g.post(`${PR}/unsubscribe/${unsubscribeToken(a.rsvp.id, SECRET)}`)).status).toBe(200);

      const click = await g.post(`${PR}/consent/${consent}`);
      expect(click.status).toBe(200);
      expect(click.json.state).toBe('off');
      expect((await g.post(`${PR}/consent/${unsubscribeToken(a.rsvp.id, SECRET)}`)).status).toBe(404);
      const row = await db.rsvp.findUniqueOrThrow({where: {id: a.rsvp.id}});
      expect(row.marketingConsent).toBe(false);
      expect(row.consentConfirmedAt).toBeNull();
      expect(row.unsubscribedAt).not.toBeNull();
    });

    it('rejects a wrong-purpose, tampered, foreign-secret or unknown token with the same 404 and changes nothing', async () => {
      const ev = await mkEvent({capacity: 10});
      const a = await mkGuest(ev.id, 'safe@example.test', {marketingConsent: true, consentConfirmedAt: new Date()});
      const good = unsubscribeToken(a.rsvp.id, SECRET);
      const [body, mac] = good.split('.') as [string, string];
      const bad = [
        consentToken(a.rsvp.id, SECRET), // the consent link's token
        signToken('manage', {r: a.rsvp.id}, SECRET), // right shape, wrong purpose
        signToken('poll', {r: a.rsvp.id}, SECRET),
        `${body}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`, // tampered signature
        unsubscribeToken(a.rsvp.id, 'another-sites-secret-0123456789-abcdefghijkl'),
        unsubscribeToken('00000000-0000-4000-8000-000000000000', SECRET), // no such RSVP
        signToken('unsubscribe', {r: 'not-a-uuid'}, SECRET),
      ];
      const g = guest();
      for (const token of bad) {
        const get = await g.get(`${PR}/unsubscribe/${encodeURIComponent(token)}`);
        const post = await g.post(`${PR}/unsubscribe/${encodeURIComponent(token)}`);
        expect([get.status, post.status]).toEqual([404, 404]);
        expect(post.json).toEqual(get.json);
      }
      const row = await db.rsvp.findUniqueOrThrow({where: {id: a.rsvp.id}});
      expect([row.marketingConsent, row.unsubscribedAt]).toEqual([true, null]);
      // A signed unsubscribe token is not a manage token: it opens no data page.
      expect((await g.get(`${PR}/guest/${encodeURIComponent(good)}`)).status).toBe(404);
      expect((await g.get(`${PR}/guest/${encodeURIComponent(good)}/export`)).status).toBe(404);
    });
  });

  describe('export', () => {
    it('includes the invite (matched case-insensitively) and the payments, field by field, without secrets', async () => {
      const ev = await mkEvent({capacity: 10});
      const {rsvp, token} = await mkGuest(ev.id, 'exp@example.test');
      await db.invite.create({data: {eventId: ev.id, email: 'Exp@Example.test', name: 'Ex Porter', token: `inv-${seq++}`, status: 'sent', sentAt: new Date()}});
      await db.invite.create({data: {eventId: ev.id, email: 'someone-else@example.test', name: 'Not Me', token: `inv-${seq++}`}});
      const checkoutId = await mkPaidOrder(rsvp.id, 'exp@example.test');
      const res = await guest().get(`${PR}/guest/${token}/export`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="guest-data-privacy-\d+-\d{4}-\d{2}-\d{2}\.json"/);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const doc = res.json as {
        rsvp: {email: string};
        invites: Array<{name: string; email: string; status: string; sentAt: string | null}>;
        payments: Array<{email: string; status: string; amountCents: number; currency: string; quantity: number}>;
        orders: Array<{amountCents: number}>;
      };
      expect(doc.rsvp.email).toBe('exp@example.test');
      expect(doc.invites).toHaveLength(1);
      expect(doc.invites[0]).toMatchObject({name: 'Ex Porter', status: 'sent'});
      expect(doc.invites[0]!.sentAt).not.toBeNull();
      expect(doc.payments).toEqual([expect.objectContaining({email: 'exp@example.test', status: 'paid', amountCents: 1500, currency: 'USD', quantity: 1})]);
      expect(doc.orders).toHaveLength(1);
      const text = JSON.stringify(doc);
      expect(text).not.toContain(checkoutId);
      expect(text).not.toContain(token);
      expect(text).not.toContain(hashToken(token));
      expect(text).not.toContain('someone-else');
      expect(text).not.toContain('rsvpId');
    });

    it('still works long after the manage page closes (an event that ended a year ago)', async () => {
      const ended = new Date(Date.now() - 365 * DAY);
      const ev = await mkEvent({startAt: new Date(ended.getTime() - 3_600_000), endAt: ended});
      const {token} = await mkGuest(ev.id, 'old@example.test');
      expect((await guest().get(`${PR}/guest/${token}/export`)).status).toBe(200);
    });
  });

  describe('rate limit (privacy_attempts)', () => {
    /** Statuses of `n` reads of one link, each from a new IP. */
    const sameToken = async (token: string, n: number) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await guest().get(`${PR}/guest/${token}`)).status);
      return out;
    };
    /** Statuses of `n` reads of different links from one IP. */
    const sameIp = async (g: Browser, n: number) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await g.get(`${PR}/guest/${String(i).padStart(43, 'k')}`)).status);
      return out;
    };

    it('one link: 429 with Retry-After once the per-token limit is passed, from any IP; only hashes are stored', async () => {
      const junk = 'j'.repeat(43);
      // Attempts 1..max are answered, then 429.
      expect(new Set(await sameToken(junk, PRIVACY_LIMITS.token.max))).toEqual(new Set([404]));
      const blocked = await guest().get(`${PR}/guest/${junk}`);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe(String(PRIVACY_LIMITS.token.windowMs / 1000));
      expect(blocked.headers.get('cache-control')).toContain('no-store');
      expect(JSON.stringify(blocked.json)).toContain('rate_limited');
      // A blocked try is not recorded, and neither the token nor the IP is stored in the clear.
      expect(await db.privacyAttempt.count()).toBe(PRIVACY_LIMITS.token.max);
      const rows = await db.$queryRawUnsafe<Array<{ip_hash: string; token_hash: string}>>('SELECT ip_hash, token_hash FROM privacy_attempts');
      expect(JSON.stringify(rows)).not.toContain(junk);
      expect(JSON.stringify(rows)).not.toContain('198.51.100');
      // Writes are limited by the same count.
      expect((await guest().post(`${PR}/unsubscribe/${junk}`)).status).toBe(429);
    });

    it('one IP: 429 once the per-IP limit is passed over any tokens; another IP is unaffected', async () => {
      const g = guest();
      expect(new Set(await sameIp(g, PRIVACY_LIMITS.ip.max))).toEqual(new Set([404]));
      const blocked = await g.get(`${PR}/guest/${'z'.repeat(43)}`);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe(String(PRIVACY_LIMITS.ip.windowMs / 1000));
      expect((await guest().get(`${PR}/guest/${'z'.repeat(43)}`)).status).toBe(404);
    });

    // Regression: the limiter once answered max + 1 tries (`count > max` before the insert).
    it(`one link allows exactly ${PRIVACY_LIMITS.token.max} tries, the next is 429`, async () => {
      const statuses = await sameToken('q'.repeat(43), PRIVACY_LIMITS.token.max + 1);
      expect(statuses.at(-1)).toBe(429);
    });

    // Regression: same off-by-one for the per-IP limit.
    it(`one IP allows exactly ${PRIVACY_LIMITS.ip.max} tries, the next is 429`, async () => {
      const statuses = await sameIp(guest(), PRIVACY_LIMITS.ip.max + 1);
      expect(statuses.at(-1)).toBe(429);
    });

    it('the retention job prunes attempts older than a day', async () => {
      await db.$executeRawUnsafe(
        `INSERT INTO privacy_attempts (ip_hash, token_hash, created_at) VALUES (repeat('a', 64), repeat('b', 64), now() - interval '2 days'), (repeat('a', 64), repeat('c', 64), now())`,
      );
      await retention();
      expect(await db.privacyAttempt.count()).toBe(1);
    });
  });

  describe('after the event is unpublished or deleted (M-23)', () => {
    it('the guest data page, export, unsubscribe and erase keep working', async () => {
      const admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
      const ev = await createEvent(admin, {capacity: 5});
      const made = await guest().post(`/site-api/rsvp/events/${ev.slug}`, rsvpBody('gone@example.test', {response: 'not_going'}));
      expect(made.status).toBe(202);
      const token = newToken();
      await db.rsvp.updateMany({where: {email: 'gone@example.test'}, data: {manageToken: hashToken(token)}});

      expect((await admin.post(`/site-api/admin-events/${ev.id}/unpublish`)).status).toBe(200);
      const g = guest();
      const summary = await g.get(`${PR}/guest/${token}`);
      expect(summary.status).toBe(200);
      expect(summary.json.email).toBe('gone@example.test');
      expect((await g.get(`${PR}/guest/${token}/export`)).status).toBe(200);
      expect((await g.get(`${PR}/unsubscribe/${token}`)).status).toBe(200);

      // Deleted (soft) too.
      expect((await admin.delete(`/site-api/admin-events/${ev.id}`)).status).toBe(200);
      expect((await g.get(`${PR}/guest/${token}`)).status).toBe(200);
      expect((await g.post(`${PR}/unsubscribe/${token}`)).status).toBe(200);
      expect((await g.post(`${PR}/guest/${token}/erase`, {confirm: 'erase'})).status).toBe(200);
      expect(await db.rsvp.count({where: {email: 'gone@example.test'}})).toBe(0);
    });

    it('a confirmed guest of an event moved back to draft keeps the data page; erasing promotes nobody on a draft', async () => {
      const ev = await mkEvent({capacity: 1});
      const {token} = await mkGuest(ev.id, 'draft@example.test');
      const next = await mkGuest(ev.id, 'wait@example.test', {status: 'waitlisted', waitlistPosition: 1});
      await db.event.update({where: {id: ev.id}, data: {status: 'draft'}});
      const g = guest();
      expect((await g.get(`${PR}/guest/${token}`)).status).toBe(200);
      expect((await g.post(`${PR}/guest/${token}/erase`, {confirm: 'erase'})).status).toBe(200);
      expect((await db.rsvp.findUniqueOrThrow({where: {id: next.rsvp.id}})).status).toBe('waitlisted');
      expect(await outboxFor(next.rsvp.id)).toEqual([]);
    });
  });
});
