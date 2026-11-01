import {describe, expect, it} from 'vitest';

import {hashToken, newToken} from '../src/domain/secureToken';
import {signToken, verifyToken} from '../src/domain/tokens';
import type {PrismaClient} from '../src/generated/prisma/client';
import {
  CONSENT_TOKEN_TTL_SECONDS, MANAGE_READ_DAYS, RETENTION_DAYS, confirmConsent, consentState, consentToken, consentUrl, erasedIdentity,
  eraseByManageToken, eraseRsvp, exportDeadline, exportFilename, findByManageToken, guestExportById, guestPrivacyUrl, guestSummary,
  inProcessHeaders, unsubscribeState, unsubscribeUrl, retentionCutoff,
} from '../src/server/privacy';

const SECRET = 'test-secret-test-secret-test-secret';
const now = new Date('2026-10-20T12:00:00Z');
const RSVP_ID = '22222222-2222-4222-8222-222222222222';
type Row = Record<string, any>;

function fakeDb(initial: Row = {}, eventOver: Row = {}) {
  const event = {id: 'e1', title: 'Launch', slug: 'launch', startAt: new Date('2026-10-01'), endAt: new Date('2026-10-02'), timezone: 'UTC', status: 'published', ...eventOver};
  const token = newToken();
  const rsvp: Row = {
    id: RSVP_ID, eventId: 'e1', name: 'Ada', email: 'ada@example.com', response: 'going', status: 'confirmed', plusOnes: 0, seats: 1,
    ticketCode: 'ABC12345', marketingConsent: false, consentConfirmedAt: null, checkedInAt: null, attended: null, waitlistPosition: null,
    source: 'direct', utmSource: 'x', confirmedAt: null, createdAt: now, updatedAt: now, manageToken: hashToken(token), event, ...initial,
  };
  const lookups: Row[] = [];
  const tx: Row = {
    rsvp: {
      findUnique: async ({where}: Row) => {
        lookups.push(where);
        return where.manageToken === rsvp.manageToken || where.id === rsvp.id ? {...rsvp} : null;
      },
      findFirst: async ({where}: Row) => (where.id === rsvp.id && where.eventId === rsvp.eventId ? {...rsvp} : null),
      updateMany: async ({where, data}: Row) => {
        const ok = where.id === rsvp.id && (where.marketingConsent === undefined || rsvp.marketingConsent === where.marketingConsent) && (where.consentConfirmedAt !== null || rsvp.consentConfirmedAt === null);
        if (ok) Object.assign(rsvp, data);
        return {count: ok ? 1 : 0};
      },
      update: async ({data}: Row) => Object.assign(rsvp, data),
    },
    rsvpAnswer: {findMany: async () => [{questionId: 'q', value: 'vegan', question: {label: 'Diet'}}], deleteMany: async () => ({})},
    ticketOrder: {findMany: async () => [{amountCents: 500, currency: 'USD', seats: 1, status: 'paid', createdAt: now}]},
    pollVote: {findMany: async () => [], updateMany: async () => ({})},
    messageDelivery: {findMany: async () => [{id: 'd1', channel: 'email', status: 'sent', sentAt: now, message: {subject: 'Hello'}}], updateMany: async () => ({})},
    invite: {deleteMany: async () => ({})},
  };
  tx.$transaction = async (fn: (t: unknown) => unknown) => fn(tx);
  return {db: tx as unknown as PrismaClient, rsvp, token, lookups};
}

describe('privacy links and constants', () => {
  it('encodes tokens into link paths', () => {
    expect(unsubscribeUrl('https://x.example', 'a/b c')).toBe('https://x.example/privacy/unsubscribe/a%2Fb%20c');
    expect(guestPrivacyUrl('https://x.example', 'tok')).toBe('https://x.example/privacy/guest/tok');
    const url = consentUrl('https://x.example', RSVP_ID, SECRET, now);
    const token = decodeURIComponent(url.split('/privacy/consent/')[1]!);
    expect(verifyToken<{rsvpId: string}>(token, 'consent', SECRET, now)).toEqual({rsvpId: RSVP_ID});
  });
  it('consent token lasts 30 days exactly', () => {
    const t = consentToken(RSVP_ID, SECRET, now);
    expect(CONSENT_TOKEN_TTL_SECONDS).toBe(30 * 86400);
    expect(verifyToken(t, 'consent', SECRET, new Date(now.getTime() + 30 * 86400_000 - 1000))).not.toBeNull();
    expect(verifyToken(t, 'consent', SECRET, new Date(now.getTime() + 30 * 86400_000 + 1000))).toBeNull();
  });
  it('a consent token cannot be used as a manage/session token and vice versa', () => {
    expect(verifyToken(consentToken(RSVP_ID, SECRET, now), 'manage', SECRET, now)).toBeNull();
    expect(verifyToken(signToken('manage', {rsvpId: RSVP_ID}, SECRET), 'consent', SECRET)).toBeNull();
  });
  it('retention and export windows', () => {
    expect(exportDeadline(new Date('2026-01-01T00:00:00Z')).getTime() - Date.parse('2026-01-01T00:00:00Z')).toBe(MANAGE_READ_DAYS * 86400_000);
    expect(now.getTime() - retentionCutoff(now).getTime()).toBe(RETENTION_DAYS * 86400_000);
  });
  it('exportFilename strips unsafe slug characters', () => {
    expect(exportFilename('../../etc/pass"wd', now)).toBe('guest-data-etcpasswd-2026-10-20.json');
  });
  it('erasedIdentity is unique per call, with an unusable email', () => {
    const a = erasedIdentity(RSVP_ID);
    const b = erasedIdentity(RSVP_ID);
    expect(a.manageToken).not.toBe(b.manageToken);
    expect(a.email).toBe(`removed+${RSVP_ID}@invalid`);
    expect(a.name).toBe('Removed guest');
  });
});

describe('inProcessHeaders', () => {
  it('copies only the real ip, user agent and named extras', () => {
    const req = new Request('https://x.example/', {headers: {'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '6.6.6.6', 'user-agent': 'UA', cookie: 'secret', 'x-extra': 'y'}});
    const h = inProcessHeaders(req, ['x-extra']);
    expect(h.get('cf-connecting-ip')).toBe('1.2.3.4');
    expect(h.get('user-agent')).toBe('UA');
    expect(h.get('x-extra')).toBe('y');
    expect(h.get('x-forwarded-for')).toBeNull();
    expect(h.get('cookie')).toBeNull();
  });
  it('omits absent headers', () => expect([...inProcessHeaders(new Request('https://x.example/')).keys()]).toEqual([]));
});

describe('token lookups', () => {
  it('junk length never reaches the database', async () => {
    const f = fakeDb();
    expect(await findByManageToken(f.db, 'short')).toBeNull();
    expect(await findByManageToken(f.db, 'x'.repeat(129))).toBeNull();
    expect(await findByManageToken(f.db, 5 as unknown as string)).toBeNull();
    expect(f.lookups).toHaveLength(0);
  });
  it('looks up the hash, never the raw token', async () => {
    const f = fakeDb();
    await findByManageToken(f.db, f.token);
    expect(f.lookups[0]).toEqual({manageToken: hashToken(f.token)});
  });
  it('consent state: off, pending, confirmed; rejects a non-uuid rsvp id in a valid signature', async () => {
    const f = fakeDb();
    const tok = consentToken(RSVP_ID, SECRET, now);
    expect((await consentState(f.db, tok, SECRET, now))?.state).toBe('off');
    f.rsvp.marketingConsent = true;
    expect((await consentState(f.db, tok, SECRET, now))?.state).toBe('pending');
    expect(await confirmConsent(f.db, tok, SECRET, now)).toBe('confirmed');
    expect((await consentState(f.db, tok, SECRET, now))?.state).toBe('confirmed');
    const bad = signToken('consent', {rsvpId: "x' OR 1=1"}, SECRET, {expiresInSeconds: 60, now});
    expect(await consentState(f.db, bad, SECRET, now)).toBeNull();
    expect(await confirmConsent(f.db, bad, SECRET, now)).toBe('invalid');
  });
  it('unsubscribe state needs both consent and its confirmation', async () => {
    const f = fakeDb({marketingConsent: true});
    expect((await unsubscribeState(f.db, f.token))?.state).toBe('off');
    f.rsvp.consentConfirmedAt = now;
    expect((await unsubscribeState(f.db, f.token))?.state).toBe('confirmed');
    expect(await unsubscribeState(f.db, 'x'.repeat(43))).toBeNull();
  });
});

describe('guestSummary', () => {
  it('shows own data, the export deadline, and blocks erase while awaiting payment', async () => {
    const f = fakeDb();
    const s = await guestSummary(f.db, f.token);
    expect(s).toMatchObject({name: 'Ada', email: 'ada@example.com', canErase: true, consentConfirmed: false});
    expect(s?.exportUntil).toBe(exportDeadline(new Date('2026-10-02')).toISOString());
    expect(JSON.stringify(s)).not.toContain(f.rsvp.manageToken);
    f.rsvp.status = 'awaiting_payment';
    expect((await guestSummary(f.db, f.token))?.canErase).toBe(false);
  });
  it('is null for a draft event', async () => {
    const f = fakeDb({}, {status: 'draft'});
    expect(await guestSummary(f.db, f.token)).toBeNull();
  });
});

describe('guestExportById (organiser export)', () => {
  it('ignores the 180-day window, never includes the credential, and scopes by event', async () => {
    const f = fakeDb({}, {endAt: new Date('2020-01-01')});
    const doc = await guestExportById(f.db, 'e1', RSVP_ID, now);
    expect(doc?.rsvp.email).toBe('ada@example.com');
    expect(doc?.answers).toEqual([{questionId: 'q', question: 'Diet', answer: 'vegan'}]);
    expect(doc?.messages[0]).toMatchObject({subject: 'Hello', channel: 'email'});
    const text = JSON.stringify(doc);
    expect(text).not.toContain(f.rsvp.manageToken);
    expect(text).not.toContain('manageToken');
    expect(await guestExportById(f.db, 'other-event', RSVP_ID, now)).toBeNull();
  });
});

describe('erase', () => {
  it('unknown id is not_found; token path for junk is not_found', async () => {
    const f = fakeDb();
    expect(await eraseRsvp(f.db, '33333333-3333-4333-8333-333333333333')).toBe('not_found');
    expect(await eraseByManageToken(f.db, 'junk')).toBe('not_found');
  });
  it('erases, cancels and kills the old link; a second erase through the old token fails', async () => {
    const f = fakeDb({marketingConsent: true, consentConfirmedAt: now});
    expect(await eraseByManageToken(f.db, f.token)).toBe('erased');
    expect(f.rsvp).toMatchObject({name: 'Removed guest', status: 'cancelled', marketingConsent: false, consentConfirmedAt: null, utmSource: null, inviteId: null});
    expect(f.rsvp.email).toMatch(/@invalid$/);
    expect(await eraseByManageToken(f.db, f.token)).toBe('not_found');
  });
  it('refuses mid-checkout without changing anything', async () => {
    const f = fakeDb({status: 'awaiting_payment'});
    expect(await eraseRsvp(f.db, RSVP_ID)).toBe('checkout_in_progress');
    expect(f.rsvp.name).toBe('Ada');
  });
});
