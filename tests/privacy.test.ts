import {describe, expect, it} from 'vitest';

import {hashToken, newToken} from '../src/domain/secureToken';
import type {PrismaClient} from '../src/generated/prisma/client';
import {
  confirmConsent,
  consentState,
  consentToken,
  eraseByManageToken,
  exportAllowed,
  exportFilename,
  findByManageToken,
  guestExport,
  retentionCutoff,
  unsubscribe,
} from '../src/server/privacy';

const SECRET = 'test-secret-test-secret-test-secret';
const now = new Date('2026-10-20T12:00:00Z');
const RSVP_ID = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, any>;

/** A tiny in-memory stand-in for the few Prisma calls the privacy module makes. */
function fakeDb(initial: Partial<Row> = {}, eventOver: Partial<Row> = {}) {
  const event = {id: 'e1', title: 'Launch', slug: 'launch', startAt: new Date('2026-10-01'), endAt: new Date('2026-10-02'), timezone: 'UTC', status: 'published', ...eventOver};
  const token = newToken();
  const rsvp: Row = {
    id: RSVP_ID, eventId: 'e1', name: 'Ada', email: 'ada@example.com', response: 'yes', status: 'confirmed', plusOnes: 0, seats: 1,
    ticketCode: 'ABC12345', marketingConsent: true, consentConfirmedAt: null, checkedInAt: null, attended: null, waitlistPosition: null,
    source: 'direct', utmSource: 'x', confirmedAt: null, createdAt: now, updatedAt: now, manageToken: hashToken(token), event, ...initial,
  };
  const calls: string[] = [];
  const db = {
    rsvp: {
      findUnique: async ({where}: Row) => (where.manageToken === rsvp.manageToken || where.id === rsvp.id ? {...rsvp} : null),
      updateMany: async ({where, data}: Row) => {
        calls.push('rsvp.updateMany');
        const ok = where.id === rsvp.id && (where.marketingConsent === undefined || rsvp.marketingConsent === where.marketingConsent) && (where.consentConfirmedAt !== null || rsvp.consentConfirmedAt === null);
        if (ok) Object.assign(rsvp, data);
        return {count: ok ? 1 : 0};
      },
      update: async ({data}: Row) => {
        calls.push('rsvp.update');
        Object.assign(rsvp, data);
        return rsvp;
      },
    },
    rsvpAnswer: {findMany: async () => [{questionId: 'q', value: 'vegan', question: {label: 'Diet'}}], deleteMany: async () => calls.push('answers.delete')},
    ticketOrder: {findMany: async () => [{amountCents: 500, currency: 'USD', seats: 1, status: 'paid', createdAt: now}]},
    pollVote: {findMany: async () => [], updateMany: async () => calls.push('votes.anon')},
    messageDelivery: {findMany: async () => [], updateMany: async () => calls.push('deliveries.clean')},
    invite: {deleteMany: async () => calls.push('invite.delete')},
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return {db: db as unknown as PrismaClient, rsvp, token, calls};
}

describe('manage token lookup', () => {
  it('finds by hash and rejects junk, rotated and draft', async () => {
    const f = fakeDb();
    expect((await findByManageToken(f.db, f.token))?.id).toBe(RSVP_ID);
    expect(await findByManageToken(f.db, 'short')).toBeNull();
    expect(await findByManageToken(f.db, newToken())).toBeNull();
    // The raw token is never what is stored.
    expect(f.rsvp.manageToken).not.toBe(f.token);
    const draft = fakeDb({}, {status: 'draft'});
    expect(await findByManageToken(draft.db, draft.token)).toBeNull();
  });
});

describe('double opt-in consent', () => {
  it('confirms once, only with a valid signed consent token', async () => {
    const f = fakeDb();
    const t = consentToken(RSVP_ID, SECRET, now);
    expect((await consentState(f.db, t, SECRET, now))?.state).toBe('pending');
    expect(await confirmConsent(f.db, t, SECRET, now)).toBe('confirmed');
    expect(f.rsvp.consentConfirmedAt).toEqual(now);
    expect(await confirmConsent(f.db, t, SECRET, new Date(now.getTime() + 1000))).toBe('confirmed');
    expect(f.rsvp.consentConfirmedAt).toEqual(now);
  });

  it('rejects tampered, wrong-secret, wrong-purpose and expired tokens', async () => {
    const f = fakeDb();
    const t = consentToken(RSVP_ID, SECRET, now);
    expect(await confirmConsent(f.db, t + 'x', SECRET, now)).toBe('invalid');
    expect(await confirmConsent(f.db, t, 'other-secret', now)).toBe('invalid');
    expect(await confirmConsent(f.db, f.token, SECRET, now)).toBe('invalid');
    expect(await confirmConsent(f.db, t, SECRET, new Date(now.getTime() + 31 * 86400_000))).toBe('invalid');
    expect(f.rsvp.consentConfirmedAt).toBeNull();
  });

  it('never re-enables marketing after an unsubscribe', async () => {
    const f = fakeDb({marketingConsent: false});
    expect(await confirmConsent(f.db, consentToken(RSVP_ID, SECRET, now), SECRET, now)).toBe('off');
    expect(f.rsvp.consentConfirmedAt).toBeNull();
  });
});

describe('unsubscribe', () => {
  it('withdraws consent and is idempotent', async () => {
    const f = fakeDb({consentConfirmedAt: now});
    expect(await unsubscribe(f.db, f.token)).toBe('ok');
    expect(f.rsvp.marketingConsent).toBe(false);
    expect(f.rsvp.consentConfirmedAt).toBeNull();
    expect(await unsubscribe(f.db, f.token)).toBe('ok');
    expect(await unsubscribe(f.db, newToken())).toBe('invalid');
  });
});

describe('export and erase', () => {
  it('exports field by field without the credential', async () => {
    const f = fakeDb();
    const doc = await guestExport(f.db, f.token, now);
    expect(doc?.rsvp.email).toBe('ada@example.com');
    expect(doc?.answers).toEqual([{questionId: 'q', question: 'Diet', answer: 'vegan'}]);
    const text = JSON.stringify(doc);
    expect(text).not.toContain(f.token);
    expect(text).not.toContain(f.rsvp.manageToken);
    expect(text).not.toContain('manageToken');
  });

  it('stops exporting 180 days after the event, but erase still works', async () => {
    const f = fakeDb();
    const late = new Date(f.rsvp.event.endAt.getTime() + 181 * 86400_000);
    expect(exportAllowed(f.rsvp.event.endAt, late)).toBe(false);
    expect(await guestExport(f.db, f.token, late)).toBeNull();
    expect(await eraseByManageToken(f.db, f.token)).toBe('erased');
  });

  it('erases personal data, kills the old link and refuses mid-checkout', async () => {
    const f = fakeDb();
    expect(await eraseByManageToken(f.db, f.token)).toBe('erased');
    expect(f.rsvp).toMatchObject({name: 'Removed guest', email: `removed+${RSVP_ID}@invalid`, status: 'cancelled', marketingConsent: false, utmSource: null});
    expect(f.calls).toEqual(expect.arrayContaining(['answers.delete', 'votes.anon', 'invite.delete']));
    expect(await findByManageToken(f.db, f.token)).toBeNull();
    expect(await eraseByManageToken(f.db, f.token)).toBe('not_found');

    const paying = fakeDb({status: 'awaiting_payment'});
    expect(await eraseByManageToken(paying.db, paying.token)).toBe('checkout_in_progress');
    expect(paying.rsvp.name).toBe('Ada');
  });
});

describe('retention helpers', () => {
  it('computes the cutoff and a safe filename', () => {
    expect(retentionCutoff(now).toISOString()).toBe('2024-10-20T12:00:00.000Z');
    expect(exportFilename('a/../b c', now)).toBe('guest-data-abc-2026-10-20.json');
  });
});
