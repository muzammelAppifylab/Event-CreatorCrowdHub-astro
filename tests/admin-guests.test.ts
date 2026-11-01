import {describe, expect, it} from 'vitest';

import {
  DEFAULT_RULE_COPY as UI_COPY,
  describeOffset,
  embedCode,
  insertAtCursor,
  joinOffset,
  RULE_OFFSET_LIMITS as UI_LIMITS,
  shareUrl,
  splitOffset,
  summarizeBulk,
} from '../src/portal/guests-queries';
import {sendMail} from '../src/server/guest-mail';
import {checkGuestPatch, guestWhere, likePattern, parseCursor, parseGuestFilter} from '../src/server/routes/admin-guests';
import {inviteEmail, isResendable, isUuid, normalizeEmail, parseEmailList} from '../src/server/routes/admin-invites';
import {
  checkRule,
  inSegment,
  RULE_OFFSET_LIMITS,
  segmentCounts,
  segmentMembers,
  unknownTagFields,
} from '../src/server/routes/admin-messages';

const UUID = '3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b';

describe('invite paste parsing', () => {
  it('splits on commas, spaces and newlines, lowercases and dedupes', () => {
    const r = parseEmailList('A@x.com, b@x.com;\n a@X.com  nope');
    expect(r.valid.map(v => v.email)).toEqual(['a@x.com', 'b@x.com']);
    expect(r.repeated).toEqual(['a@x.com']);
    expect(r.invalid).toEqual(['nope']);
  });

  it('understands "Name <email>"', () => {
    const r = parseEmailList('Sam Rivera <sam@x.com>, "Lee, Ann" <ann@x.com>, plain@x.com');
    expect(r.valid).toEqual([
      {email: 'sam@x.com', name: 'Sam Rivera'},
      {email: 'ann@x.com', name: 'Lee, Ann'},
      {email: 'plain@x.com', name: null},
    ]);
  });

  it('validates addresses and ids', () => {
    expect(normalizeEmail(' Sam@Example.COM ')).toBe('sam@example.com');
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail('a b@c.com')).toBeNull();
    expect(normalizeEmail(5)).toBeNull();
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('1; drop table')).toBe(false);
  });
});

describe('resending', () => {
  const now = new Date('2026-06-10T12:00:00Z');
  const hours = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it('skips guests who responded or bounced', () => {
    expect(isResendable({status: 'sent', hasRsvp: true, sentAt: hours(100), lastResentAt: null}, now)).toBe(false);
    expect(isResendable({status: 'bounced', hasRsvp: false, sentAt: hours(100), lastResentAt: null}, now)).toBe(false);
    expect(isResendable({status: 'responded', hasRsvp: false, sentAt: null, lastResentAt: null}, now)).toBe(false);
  });

  it('waits 48 hours after the last send', () => {
    expect(isResendable({status: 'sent', hasRsvp: false, sentAt: hours(47), lastResentAt: null}, now)).toBe(false);
    expect(isResendable({status: 'sent', hasRsvp: false, sentAt: hours(49), lastResentAt: null}, now)).toBe(true);
    expect(isResendable({status: 'sent', hasRsvp: false, sentAt: hours(99), lastResentAt: hours(1)}, now)).toBe(false);
    expect(isResendable({status: 'queued', hasRsvp: false, sentAt: null, lastResentAt: null}, now)).toBe(true);
  });
});

describe('invite email', () => {
  it('carries the link and escapes the name', () => {
    const email = inviteEmail(
      {
        title: 'Studio Night',
        startAt: new Date('2026-11-12T18:00:00Z'),
        timezone: 'UTC',
        format: 'in_person',
        venueName: 'The Studio',
        venueAddress: null,
      },
      {senderName: 'Studio'},
      {name: '<b>Sam</b>'},
      'https://x.test/i/tok?e=studio-night'
    );
    expect(email.subject).toBe("You're invited: Studio Night");
    expect(email.html).toContain('https://x.test/i/tok?e=studio-night');
    expect(email.html).not.toContain('<b>Sam</b>');
    expect(email.text).toContain('The Studio');
  });
});

describe('guest filters', () => {
  it('treats blanks as no filter and rejects unknown values', () => {
    expect(parseGuestFilter({status: '', q: ' '})).toEqual({filter: {}});
    expect(parseGuestFilter({status: 'bogus'})).toEqual({error: 'Unknown status.'});
    expect(parseGuestFilter({response: 'x'})).toEqual({error: 'Unknown response.'});
    expect(parseGuestFilter({ticketTypeId: 'nope'})).toEqual({error: 'Unknown ticket type.'});
    expect(parseGuestFilter({checkedIn: 'maybe'})).toEqual({error: 'checkedIn must be yes or no.'});
    expect(parseGuestFilter({status: 'pending', checkedIn: 'no', q: ' Sam '})).toEqual({
      filter: {status: 'pending', checkedIn: false, q: 'Sam'},
    });
  });

  it('builds the where clause', () => {
    const where = guestWhere(UUID, {status: 'confirmed', checkedIn: true, q: 'ab12'});
    expect(where.eventId).toBe(UUID);
    expect(where.status).toBe('confirmed');
    expect(where.checkedInAt).toEqual({not: null});
    expect(where.OR).toHaveLength(3);
    expect(guestWhere(UUID, {checkedIn: false}).checkedInAt).toBeNull();
  });

  it('parses keyset cursors', () => {
    const iso = '2026-06-10T12:00:00.000Z';
    expect(parseCursor(`${iso}_${UUID}`)).toEqual({at: new Date(iso), id: UUID});
    expect(parseCursor('garbage')).toBeNull();
    expect(parseCursor(`${iso}_not-a-uuid`)).toBeNull();
    expect(parseCursor('')).toBeNull();
  });

  it('escapes LIKE wildcards', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('guest edits', () => {
  it('validates each field', () => {
    expect(checkGuestPatch({name: ' ', plusOnes: 11, email: 'x', attended: 'y', checkedIn: 1})).toEqual({
      fields: {
        name: 'A name needs 1 to 120 characters.',
        email: 'Enter a valid email address.',
        plusOnes: 'Plus-ones are a whole number from 0 to 10.',
        attended: 'Use yes, no or unset.',
        checkedIn: 'Use yes or no.',
      },
    });
    expect(checkGuestPatch({})).toHaveProperty('fields');
    expect(checkGuestPatch({name: ' Sam   Rivera ', email: 'S@X.com', plusOnes: 2, attended: null, marketingConsent: false})).toEqual({
      patch: {name: 'Sam Rivera', email: 's@x.com', plusOnes: 2, attended: null, marketingConsent: false},
    });
  });
});

describe('segments', () => {
  const end = new Date('2026-06-10T20:00:00Z');
  const during = new Date('2026-06-10T19:00:00Z');
  const after = new Date('2026-06-11T09:00:00Z');
  const g = (status: string, response = 'going', checkedInAt: Date | null = null, attended: boolean | null = null) => ({
    status,
    response,
    checkedInAt,
    attended,
  });
  const guests = [
    g('confirmed'),
    g('confirmed', 'maybe'),
    g('waitlisted'),
    g('pending'),
    g('confirmed', 'going', new Date()),
    g('declined'),
    g('cancelled', 'going', new Date()),
    g('confirmed', 'going', null, true),
  ];

  it('counts each segment', () => {
    expect(segmentCounts(guests, end, after)).toEqual({
      going: 3,
      maybe: 1,
      waitlisted: 1,
      pending: 1,
      checked_in: 1,
      no_show: 1,
      all: 6,
    });
  });

  it('has no no-shows before the event ends', () => {
    expect(segmentCounts(guests, end, during).no_show).toBe(0);
  });

  it('selects members', () => {
    expect(segmentMembers('waitlisted', guests, end, during)).toHaveLength(1);
    expect(inSegment('all', g('declined'), end, during)).toBe(false);
  });
});

describe('merge tags and reminder rules', () => {
  it('names unknown tags', () => {
    expect(unknownTagFields({subject: 'Hi {{guest.first_name}}', body: 'x {{guest.nickname}} {{foo}}'})).toEqual({
      body: 'Unknown merge tags: {{guest.nickname}}, {{foo}}',
    });
    expect(unknownTagFields({subject: 'ok'})).toEqual({});
  });

  it('accepts the default copy for every kind', () => {
    for (const kind of ['confirmation', 'reminder', 'live_now', 'thank_you'] as const) {
      expect(checkRule({kind, ...UI_COPY[kind]}), kind).toHaveProperty('rule');
    }
  });

  it('enforces the offset limits per kind', () => {
    expect(checkRule({kind: 'reminder', offsetMinutes: -15 * 1440, subject: 's', body: 'b'})).toHaveProperty('fields.offsetMinutes');
    expect(checkRule({kind: 'thank_you', offsetMinutes: -1, subject: 's', body: 'b'})).toHaveProperty('fields.offsetMinutes');
    expect(checkRule({kind: 'live_now', offsetMinutes: 30.5, subject: 's', body: 'b'})).toHaveProperty('fields.offsetMinutes');
    expect(checkRule({kind: 'nope', offsetMinutes: 0, subject: '', body: ''})).toHaveProperty('fields.kind');
    expect(checkRule({kind: 'reminder', offsetMinutes: -60, subject: 's', body: '{{x}}'})).toHaveProperty('fields.body');
  });

  it('keeps the screen and the server limits in step', () => {
    expect(UI_LIMITS).toEqual(RULE_OFFSET_LIMITS);
  });
});

describe('portal helpers', () => {
  it('describes offsets in words', () => {
    expect(describeOffset('reminder', -1440)).toBe('24 hours before');
    expect(describeOffset('reminder', -4320)).toBe('3 days before');
    expect(describeOffset('live_now', 0)).toBe('At the start');
    expect(describeOffset('thank_you', 120)).toBe('2 hours after the end');
    expect(describeOffset('confirmation', 0)).toBe('Straight after the RSVP');
  });

  it('splits and joins offsets', () => {
    expect(splitOffset(-1440)).toEqual({amount: 24, unit: 'hours'});
    expect(joinOffset('reminder', 24, 'hours')).toBe(-1440);
    expect(joinOffset('thank_you', 2, 'hours')).toBe(120);
    expect(joinOffset('live_now', 5, 'minutes', true)).toBe(5);
  });

  it('inserts a merge tag at the cursor', () => {
    expect(insertAtCursor('Hi !', '{{guest.name}}', 3, 3)).toEqual({value: 'Hi {{guest.name}}!', caret: 17});
  });

  it('summarises a bulk result', () => {
    expect(summarizeBulk({action: 'approve', succeeded: ['a'], failed: []})).toEqual({ok: true, message: '1 guest approved.'});
    expect(
      summarizeBulk({
        action: 'promote',
        succeeded: ['a', 'b'],
        failed: [
          {rsvpId: 'c', reason: 'event_full'},
          {rsvpId: 'd', reason: 'has_order: use erase'},
        ],
      })
    ).toEqual({ok: true, message: '2 guests promoted. 2 skipped: no seats left (1), has a payment (erase instead) (1).'});
  });

  it('builds share links and an escaped embed', () => {
    expect(shareUrl('whatsapp', 'https://x.test/e/a', 'A & B')).toContain('wa.me');
    expect(embedCode('https://x.test/', 'a b', 'Say "hi"')).toContain('src="https://x.test/e/a%20b?embed=1"');
    expect(embedCode('https://x.test', 'a', 'Say "hi"')).toContain('title="RSVP: Say &quot;hi&quot;"');
  });
});

describe('mailer glue', () => {
  it('never throws, with or without a mailer', async () => {
    const result = await sendMail({to: 'a@x.com', subject: 's', html: '<p>x</p>', text: 'x'});
    expect(typeof result.ok).toBe('boolean');
  });
});

describe('guest data export (organiser)', () => {
  it('builds the guest document by id, scoped to the event, without the credential', async () => {
    const {guestExportById} = await import('../src/server/privacy');
    const rsvp = {
      id: UUID, eventId: 'e1', name: 'Ada', email: 'ada@example.com', response: 'yes', status: 'confirmed', plusOnes: 0, seats: 1, ticketCode: 'ABC12345',
      marketingConsent: false, consentConfirmedAt: null, checkedInAt: null, attended: null, waitlistPosition: null, source: 'direct', utmSource: null,
      confirmedAt: null, createdAt: new Date(), updatedAt: new Date(), manageToken: 'hash',
      event: {id: 'e1', title: 'Launch', slug: 'launch', startAt: new Date('2020-01-01'), endAt: new Date('2020-01-02'), timezone: 'UTC', status: 'published'},
    };
    const db = {
      rsvp: {findFirst: async ({where}: any) => (where.id === UUID && where.eventId === 'e1' ? rsvp : null)},
      rsvpAnswer: {findMany: async () => [{questionId: 'q', value: 'vegan', question: {label: 'Diet'}}]},
      ticketOrder: {findMany: async () => []},
      pollVote: {findMany: async () => []},
      messageDelivery: {findMany: async () => []},
    } as any;
    const doc = await guestExportById(db, 'e1', UUID, new Date('2026-10-30'));
    expect(doc?.rsvp.ticketCode).toBe('ABC12345');
    expect(doc?.answers).toEqual([{questionId: 'q', question: 'Diet', answer: 'vegan'}]);
    expect(JSON.stringify(doc)).not.toContain('manageToken');
    expect(await guestExportById(db, 'other', UUID, new Date())).toBeNull();
  });
});
