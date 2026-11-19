import {beforeEach, describe, expect, it, vi} from 'vitest';

// The drain reads the site logo from the platform: never over the network in a unit test.
vi.mock('../src/platform/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/platform/api')>()),
  publicGet: vi.fn(async () => null),
}));
// The request only queues: the kick is observed, never run.
vi.mock('../src/server/jobs/outbox', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/server/jobs/outbox')>()),
  kickGuestEmails: vi.fn(async () => undefined),
}));

import {type GuestNotice, type MailEvent, type MailGuest, noticeContent} from '../src/server/guest-mail';
import {noticeRows, notifyGuests} from '../src/server/guest-notices';
import {drainGuestEmailOutbox, noticeSkip} from '../src/server/jobs/outbox-drain';
import {enqueueGuestNotices, kickGuestEmails, noticeKey} from '../src/server/jobs/outbox';
import {siteBase, type Db} from '../src/server/jobs/shared';

const RSVP_A = '0190a000-0000-7000-8000-00000000000a';
const RSVP_B = '0190a000-0000-7000-8000-00000000000b';
const RSVP_C = '0190a000-0000-7000-8000-00000000000c';
const EVENT = '0190a000-0000-7000-8000-0000000000e1';

const guest = (id: string, status: MailGuest['status'] = 'confirmed'): MailGuest => ({
  id, name: 'Ada Lovelace', email: `${id.slice(-1)}@example.com`, response: 'going', status, ticketCode: null, waitlistPosition: null,
});

const event: MailEvent = {
  id: EVENT, slug: 'studio-night', title: 'Studio Night', startAt: new Date('2030-01-10T18:00:00Z'), endAt: new Date('2030-01-10T21:00:00Z'),
  timezone: 'UTC', format: 'in_person', venueName: 'The Studio', venueAddress: null, mapUrl: null, joinUrl: null, pollJoinCode: 'ABCD1234',
  thankYouLink: null, status: 'published', capacity: 10, waitlistEnabled: true, maxPlusOnes: 0,
};

/** The values bound to a tagged-template call: `fn(strings, ...values)`. */
const boundValues = (call: unknown[]) => call.slice(1);
const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');

describe('host notices: outbox rows', () => {
  it('maps approvals, declines and offers to outbox kinds with idempotency keys', () => {
    const expires = new Date('2030-01-09T12:00:00Z');
    const notices: GuestNotice[] = [
      {kind: 'confirmation', guest: guest(RSVP_A, 'confirmed')},
      {kind: 'declined', guest: guest(RSVP_B, 'declined')},
      {kind: 'waitlist_offer', guest: guest(RSVP_C, 'waitlisted'), claimExpiresAt: expires},
    ];
    expect(noticeRows(notices)).toEqual([
      {kind: 'notice_confirmation', rsvpId: RSVP_A, key: `notice_confirmation-${RSVP_A}-confirmed`},
      {kind: 'notice_declined', rsvpId: RSVP_B, key: `notice_declined-${RSVP_B}-declined`},
      // The scheduler's key for the same offer, so one claim email whichever path freed the seat.
      {kind: 'waitlist_offer', rsvpId: RSVP_C, key: `waitlist_offer-${RSVP_C}-${expires.getTime()}`},
    ]);
  });

  it('keys a confirmation by the status reached (an approval onto the waitlist, then a seat, are two emails)', () => {
    expect(noticeKey('notice_confirmation', RSVP_A, 'waitlisted')).not.toBe(noticeKey('notice_confirmation', RSVP_A, 'confirmed'));
  });
});

describe('enqueueGuestNotices', () => {
  it('inserts every row in ONE statement, de-duplicated, unsubscribed guests included (a notice is about their own RSVP)', async () => {
    const $executeRaw = vi.fn(async () => 2);
    const db = {$executeRaw} as unknown as Db;
    const queued = await enqueueGuestNotices(db, [
      {kind: 'notice_confirmation', rsvpId: RSVP_A, key: 'k-a'},
      {kind: 'notice_confirmation', rsvpId: RSVP_A, key: 'k-a'},
      {kind: 'notice_declined', rsvpId: RSVP_B, key: 'k-b'},
    ]);
    expect(queued).toBe(2);
    expect($executeRaw).toHaveBeenCalledTimes(1);
    const call = $executeRaw.mock.calls[0] as unknown[];
    const [, , keys, kinds, ids] = boundValues(call); // the first two bound values are `now` (next_attempt_at, created_at)
    expect(keys).toEqual(['k-a', 'k-b']);
    expect(kinds).toEqual(['notice_confirmation', 'notice_declined']);
    expect(ids).toEqual([RSVP_A, RSVP_B]);
    expect(sqlOf(call)).not.toContain('unsubscribed_at');
    expect(sqlOf(call)).toContain('ON CONFLICT (idempotency_key)');
  });

  it('runs nothing for no rows', async () => {
    const $executeRaw = vi.fn(async () => 0);
    expect(await enqueueGuestNotices({$executeRaw} as unknown as Db, [])).toBe(0);
    expect($executeRaw).not.toHaveBeenCalled();
  });
});

describe('notifyGuests (queues, never sends in the request)', () => {
  beforeEach(() => vi.mocked(kickGuestEmails).mockClear());

  it('queues the notices in one insert, then kicks the outbox once', async () => {
    const $executeRaw = vi.fn(async () => 2);
    const db = {$executeRaw} as unknown as Db;
    const queued = await notifyGuests(db, event, [
      {kind: 'confirmation', guest: guest(RSVP_A)},
      {kind: 'declined', guest: guest(RSVP_B, 'declined')},
    ]);
    expect(queued).toBe(2);
    expect($executeRaw).toHaveBeenCalledTimes(1);
    expect(kickGuestEmails).toHaveBeenCalledTimes(1);
  });

  it('queues nothing for a cancelled event or no notices', async () => {
    const $executeRaw = vi.fn(async () => 1);
    const db = {$executeRaw} as unknown as Db;
    expect(await notifyGuests(db, {status: 'cancelled'}, [{kind: 'confirmation', guest: guest(RSVP_A)}])).toBe(0);
    expect(await notifyGuests(db, event, [])).toBe(0);
    expect($executeRaw).not.toHaveBeenCalled();
    expect(kickGuestEmails).not.toHaveBeenCalled();
  });

  it('does not kick when nothing was queued', async () => {
    const db = {$executeRaw: vi.fn(async () => 0)} as unknown as Db;
    expect(await notifyGuests(db, event, [{kind: 'confirmation', guest: guest(RSVP_A)}])).toBe(0);
    expect(kickGuestEmails).not.toHaveBeenCalled();
  });

  it('never throws: a failed insert is logged and reported as 0 queued', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = {$executeRaw: vi.fn(async () => Promise.reject(new Error('db down')))} as unknown as Db;
    expect(await notifyGuests(db, event, [{kind: 'confirmation', guest: guest(RSVP_A)}])).toBe(0);
    expect(kickGuestEmails).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('noticeSkip', () => {
  const live = {status: 'published' as const, deletedAt: null};
  it('sends a confirmation to a guest still seated, waitlisted or awaiting payment', () => {
    for (const status of ['confirmed', 'waitlisted', 'awaiting_payment'] as const) {
      expect(noticeSkip('notice_confirmation', {status}, live)).toBeNull();
    }
  });
  it('skips when the guest moved on, or the event is gone or cancelled', () => {
    expect(noticeSkip('notice_confirmation', {status: 'declined'}, live)).toBe('status_changed');
    expect(noticeSkip('notice_declined', {status: 'confirmed'}, live)).toBe('status_changed');
    expect(noticeSkip('notice_declined', {status: 'declined'}, live)).toBeNull();
    expect(noticeSkip('notice_confirmation', {status: 'confirmed'}, {status: 'cancelled', deletedAt: null})).toBe('event_cancelled');
    expect(noticeSkip('notice_confirmation', {status: 'confirmed'}, {status: 'draft', deletedAt: new Date()})).toBe('gone');
    expect(noticeSkip('notice_confirmation', undefined, live)).toBe('gone');
  });
});

describe('drainGuestEmailOutbox: host notices', () => {
  function fakeDb(opts: {unsubscribed?: string[]}) {
    const claimed = [
      {id: 'o1', kind: 'notice_confirmation', rsvpId: RSVP_A, inviteId: null, messageId: null, attempts: 1},
      {id: 'o2', kind: 'notice_declined', rsvpId: RSVP_B, inviteId: null, messageId: null, attempts: 1},
    ];
    let claims = 0;
    const updates: Array<{where: unknown; data: unknown}> = [];
    const db = {
      guestEmailOutbox: {updateMany: vi.fn(async (args: {where: unknown; data: unknown}) => (updates.push(args), {count: 1}))},
      messageDelivery: {updateMany: vi.fn()},
      message: {updateMany: vi.fn()},
      invite: {updateMany: vi.fn()},
      eventSettings: {
        findUnique: vi.fn(async () => ({senderName: 'The Studio', replyToEmail: 'host@example.com', brandColor: null, logoFileId: null, logoName: null})),
      },
      rsvp: {
        findMany: vi.fn(async () => [
          {...guest(RSVP_A, 'confirmed'), event: {...event, deletedAt: null}},
          {...guest(RSVP_B, 'declined'), event: {...event, deletedAt: null}},
        ]),
      },
      $executeRaw: vi.fn(async () => 0),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('UPDATE guest_email_outbox')) return claims++ === 0 ? claimed : [];
        if (sql.includes('unsubscribed_at IS NOT NULL')) return (opts.unsubscribed ?? []).map(id => ({id}));
        return [];
      }),
    };
    return {db: db as unknown as Db, updates};
  }

  it('sends the same content as noticeContent, with an idempotency key per row', async () => {
    const {db, updates} = fakeDb({});
    const deliver = vi.fn(async () => ({outcome: 'sent' as const}));
    const run = await drainGuestEmailOutbox(db, new Date('2030-01-01T00:00:00Z'), {deliver, providerConfigured: true});
    expect(run).toMatchObject({sent: 2, skipped: 0, failed: 0});
    const sent = deliver.mock.calls.map(c => (c as unknown as [{to: string; content: {subject: string}; idempotencyKey: string; replyTo: string}])[0]);
    const brand = {senderName: 'The Studio', replyToEmail: 'host@example.com', brandColor: null, logoUrl: null};
    const expected = (notice: GuestNotice) => noticeContent(siteBase(), event, brand, notice).subject;
    expect(sent.map(e => e.content.subject)).toEqual([
      expected({kind: 'confirmation', guest: guest(RSVP_A, 'confirmed')}),
      expected({kind: 'declined', guest: guest(RSVP_B, 'declined')}),
    ]);
    expect(sent[1].content.subject).toBe('Update on your request: Studio Night');
    expect(sent.map(e => e.idempotencyKey)).toEqual(['outbox-o1', 'outbox-o2']);
    expect(sent.every(e => e.replyTo === 'host@example.com')).toBe(true);
    expect(updates.some(u => (u.data as {status?: string}).status === 'sent')).toBe(true);
  });

  it('still sends to a guest who unsubscribed from host updates (the opt-out covers broadcasts only)', async () => {
    const {db} = fakeDb({unsubscribed: [RSVP_A]});
    const deliver = vi.fn(async () => ({outcome: 'sent' as const}));
    const run = await drainGuestEmailOutbox(db, new Date('2030-01-01T00:00:00Z'), {deliver, providerConfigured: true});
    expect(run).toMatchObject({sent: 2, skipped: 0});
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
