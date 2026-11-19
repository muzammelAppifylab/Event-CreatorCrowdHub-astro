import {beforeEach, describe, expect, it, vi} from 'vitest';

/** Audit stream G: guest privacy links in every email (M-4), signed unsubscribe (M-25), erase → waitlist (M-9), M-24, M-27. */

const queued = vi.hoisted(() => [] as Array<{kind: string; rsvpId: string; stamp?: string}>);
const promote = vi.hoisted(() => ({promotions: [] as Array<Record<string, unknown>>, calls: 0}));
vi.mock('../src/server/jobs/guest-emails', () => ({
  queueGuestEmails: async (items: Array<{kind: string; rsvpId: string; stamp?: string}>) => void queued.push(...items),
}));
vi.mock('../src/server/waitlist-promote', () => ({
  promoteWaitlist: async () => {
    promote.calls++;
    return {promotions: promote.promotions, failed: []};
  },
}));
vi.mock('../src/server/webhook-emit', () => ({
  emitWebhook: async () => undefined,
  emitSeated: async () => undefined,
  rsvpPayload: (x: unknown) => x,
}));

import {hashToken, newToken} from '../src/domain/secureToken';
import {signToken} from '../src/domain/tokens';
import {confirmationEmail, broadcastEmail} from '../src/emails';
import {guestPrivacyLinks, listUnsubscribeHeaders} from '../src/emails/layout';
import type {EmailData} from '../src/emails/types';
import type {PrismaClient} from '../src/generated/prisma/client';
import {
  eraseRsvp,
  erasureHash,
  guestEmailLinks,
  guestExport,
  unsubscribe,
  unsubscribeState,
  unsubscribeToken,
} from '../src/server/privacy';

const SECRET = 'test-secret-test-secret-test-secret';
const RSVP_ID = '44444444-4444-4444-8444-444444444444';
const ORIGIN = 'https://site.example';
type Row = Record<string, any>;

beforeEach(() => {
  queued.length = 0;
  promote.promotions = [];
  promote.calls = 0;
});

function mailData(guest: Partial<EmailData['guest']> = {}): EmailData {
  const start = new Date('2030-01-10T18:00:00Z');
  return {
    now: new Date('2030-01-01T00:00:00Z'),
    brand: {senderName: 'Host'},
    event: {
      title: 'Launch', startAt: start, endAt: new Date(start.getTime() + 3600_000), timezone: 'UTC', startLocal: 'Thu 10 Jan 2030, 18:00',
      format: 'in_person', venueName: 'Hall', pageUrl: `${ORIGIN}/e/launch/`,
    },
    guest: {rsvpId: RSVP_ID, name: 'Ada', response: 'going', status: 'confirmed', ticketCode: 'ABCD1234', manageUrl: `${ORIGIN}/e/launch/`, ...guest},
  };
}

describe('privacy links in guest emails (M-4)', () => {
  it('derives the data and unsubscribe pages from a token-bearing manage link', () => {
    const token = newToken();
    expect(guestPrivacyLinks({manageUrl: `${ORIGIN}/r/${token}/`})).toEqual({
      unsubscribeUrl: `${ORIGIN}/privacy/unsubscribe/${token}`,
      privacyUrl: `${ORIGIN}/privacy/guest/${token}`,
    });
    expect(guestPrivacyLinks({manageUrl: `${ORIGIN}/e/launch/`})).toEqual({unsubscribeUrl: null, privacyUrl: null});
    expect(guestPrivacyLinks({manageUrl: `${ORIGIN}/r/${token}/`, unsubscribeUrl: 'https://x/u'}).unsubscribeUrl).toBe('https://x/u');
  });

  it('every guest email footer and text part carries the links, plus List-Unsubscribe', () => {
    const token = newToken();
    const mail = confirmationEmail(mailData({manageUrl: `${ORIGIN}/r/${token}/`}));
    expect(mail.html).toContain(`${ORIGIN}/privacy/unsubscribe/${token}`);
    expect(mail.html).toContain(`${ORIGIN}/privacy/guest/${token}`);
    expect(mail.text).toContain(`Unsubscribe from host updates: ${ORIGIN}/privacy/unsubscribe/${token}`);
    expect(mail.headers).toEqual({'List-Unsubscribe': `<${ORIGIN}/privacy/unsubscribe/${token}>`});

    const links = guestEmailLinks(ORIGIN, RSVP_ID, SECRET);
    const b = broadcastEmail(mailData(links), {subject: 'News', body: 'Hello'});
    expect(links.privacyUrl).toBeNull();
    expect(b.html).toContain(links.unsubscribeUrl!);
    expect(b.headers?.['List-Unsubscribe']).toBe(`<${links.unsubscribeUrl}>`);
    // No link, no header.
    expect(broadcastEmail(mailData(), {subject: 'x', body: 'y'}).headers).toBeUndefined();
    expect(listUnsubscribeHeaders('javascript:alert(1)')).toBeUndefined();
  });

  it('with a manage token both links use it; without a secret there is no signed link', () => {
    expect(guestEmailLinks(ORIGIN, RSVP_ID, SECRET, 'tok')).toEqual({
      unsubscribeUrl: `${ORIGIN}/privacy/unsubscribe/tok`,
      privacyUrl: `${ORIGIN}/privacy/guest/tok`,
    });
    expect(guestEmailLinks(ORIGIN, RSVP_ID, '')).toEqual({unsubscribeUrl: null, privacyUrl: null});
  });
});

function fakeDb(initial: Row = {}) {
  const token = newToken();
  const event = {id: 'e1', title: 'Launch', slug: 'launch', startAt: new Date('2030-01-10'), endAt: new Date('2030-01-11'), timezone: 'UTC',
    status: 'published', capacity: 10, deletedAt: null};
  const rsvp: Row = {
    id: RSVP_ID, eventId: 'e1', name: 'Ada', email: 'ada@example.com', response: 'going', status: 'confirmed', plusOnes: 0, seats: 1,
    ticketCode: 'ABC12345', marketingConsent: true, consentConfirmedAt: new Date(), checkedInAt: null, attended: null, waitlistPosition: null,
    source: 'direct', utmSource: null, confirmedAt: null, createdAt: new Date(), updatedAt: new Date(), manageToken: hashToken(token), event,
    unsubscribedAt: null, ...initial,
  };
  const sql: Array<{text: string; values: unknown[]}> = [];
  const db: Row = {
    rsvp: {
      findUnique: async ({where}: Row) => (where.manageToken === rsvp.manageToken || where.id === rsvp.id ? {...rsvp} : null),
      update: async ({data}: Row) => Object.assign(rsvp, data),
    },
    rsvpAnswer: {findMany: async () => [], deleteMany: async () => ({})},
    ticketOrder: {findMany: async () => [{checkoutId: 'pcs_1', amountCents: 500, currency: 'USD', seats: 1, status: 'paid', createdAt: new Date()}]},
    order: {findMany: async () => [{email: 'ada@example.com', status: 'paid', amountCents: 500, currency: 'USD', quantity: 1, paidAt: null, createdAt: new Date()}]},
    pollVote: {findMany: async () => [], updateMany: async () => ({})},
    messageDelivery: {findMany: async () => [], updateMany: async () => ({})},
    invite: {findMany: async () => [{name: 'Ada', email: 'ada@example.com', status: 'sent', sentAt: null, lastResentAt: null}], deleteMany: async () => ({})},
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      sql.push({text, values});
      if (text.includes('unsubscribed_at = COALESCE')) Object.assign(rsvp, {marketingConsent: false, consentConfirmedAt: null, unsubscribedAt: values[0]});
      return 1;
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      sql.push({text, values});
      return text.includes('bool_or(unsubscribed_at') ? [{unsubscribed: Boolean(rsvp.unsubscribedAt)}] : [];
    },
  };
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return {db: db as unknown as PrismaClient, rsvp, token, sql};
}

describe('unsubscribe (M-25, M-26)', () => {
  it('a signed unsubscribe token works for ever; a consent or tampered token does not', async () => {
    const f = fakeDb();
    const t = unsubscribeToken(RSVP_ID, SECRET);
    expect((await unsubscribeState(f.db, t, SECRET))?.state).toBe('confirmed');
    expect(await unsubscribe(f.db, signToken('consent', {rsvpId: RSVP_ID}, SECRET), SECRET)).toBe('invalid');
    expect(await unsubscribe(f.db, t.slice(0, -2) + 'AA', SECRET)).toBe('invalid');
    expect(await unsubscribe(f.db, unsubscribeToken(RSVP_ID, 'another-secret-another-secret'), SECRET)).toBe('invalid');
    expect(await unsubscribe(f.db, t, SECRET)).toBe('ok');
    expect((await unsubscribeState(f.db, t, SECRET))?.state).toBe('off');
  });

  it('unsubscribes the PERSON: one statement over every RSVP with the address', async () => {
    const f = fakeDb();
    expect(await unsubscribe(f.db, f.token, SECRET)).toBe('ok');
    const update = f.sql.find(s => s.text.includes('UPDATE rsvps'))!;
    expect(update.text).toContain('WHERE email = ?');
    expect(update.values).toContain('ada@example.com');
    expect(f.rsvp).toMatchObject({marketingConsent: false, consentConfirmedAt: null});
  });
});

describe('erase (M-9, M-24, M-27)', () => {
  it('locks the event, passes the freed seat to the waitlist and emails the promoted guests after the commit', async () => {
    const f = fakeDb();
    promote.promotions = [{kind: 'confirm', rsvpId: 'p1'}, {kind: 'offer_claim', rsvpId: 'p2', claimExpiresAt: new Date(5000)}];
    expect(await eraseRsvp(f.db, RSVP_ID, {now: new Date('2030-01-01')})).toBe('erased');
    expect(f.sql.some(s => s.text.includes('FOR UPDATE'))).toBe(true);
    expect(promote.calls).toBe(1);
    expect(queued).toEqual([{kind: 'confirmation', rsvpId: 'p1'}, {kind: 'waitlist_offer', rsvpId: 'p2', stamp: '5000'}]);
  });

  it('strips the address and RSVP id from payment records and logs the hashed address', async () => {
    const f = fakeDb();
    await eraseRsvp(f.db, RSVP_ID, {now: new Date('2030-01-01')});
    const scrub = f.sql.find(s => s.text.includes('UPDATE orders'))!;
    expect(scrub.text).toContain('email = NULL');
    expect(scrub.text).toContain("metadata - 'rsvpId'");
    const log = f.sql.find(s => s.text.includes('INSERT INTO guest_erasures'))!;
    expect(log.values).toContain(erasureHash('ada@example.com'));
    expect(log.values).not.toContain('ada@example.com');
    expect(erasureHash('Ada@Example.com')).toBe(erasureHash('ada@example.com'));
  });

  it('retention mode neither promotes nor logs; an ended or unpublished event never promotes', async () => {
    const f = fakeDb();
    await eraseRsvp(f.db, RSVP_ID, {promote: false, log: false});
    expect(promote.calls).toBe(0);
    expect(f.sql.some(s => s.text.includes('guest_erasures'))).toBe(false);
    expect(f.sql.some(s => s.text.includes('FOR UPDATE'))).toBe(false);

    const ended = fakeDb();
    await eraseRsvp(ended.db, RSVP_ID, {now: new Date('2031-01-01')});
    const draft = fakeDb({event: {...ended.rsvp.event, status: 'draft'}});
    await eraseRsvp(draft.db, RSVP_ID, {now: new Date('2030-01-01')});
    const maybe = fakeDb({status: 'pending'});
    await eraseRsvp(maybe.db, RSVP_ID, {now: new Date('2030-01-01')});
    expect(promote.calls).toBe(0);
    expect(queued).toEqual([]);
  });
});

describe('export (L-42)', () => {
  it('includes the invite and the payment record', async () => {
    const f = fakeDb();
    const doc = await guestExport(f.db, f.token, new Date('2031-06-01'));
    expect(doc?.invites).toEqual([{name: 'Ada', email: 'ada@example.com', status: 'sent', sentAt: null, lastResentAt: null}]);
    expect(doc?.payments[0]).toMatchObject({email: 'ada@example.com', status: 'paid', amountCents: 500});
    expect(JSON.stringify(doc)).not.toContain('pcs_1');
  });
});
