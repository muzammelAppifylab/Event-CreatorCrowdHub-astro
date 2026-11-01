import {describe, expect, it} from 'vitest';

import {responseLabel, statusBadge, statusCopy} from '../src/components/rsvp/copy';
import {buildIcs, escapeIcsText, foldLine, googleCalendarUrl, icsUid} from '../src/domain/ics';
import {RSVP_CONFLICTS, type RsvpQuestion, type RsvpRules, validateRsvp} from '../src/lib/rsvp-types';
import {holdsSeat, MANAGE_READ_DAYS, MANAGE_WRITE_DAYS, manageTokenAllows, place, RsvpError, type PlaceInput} from '../src/server/routes/rsvp';

const T = '11111111-1111-4111-8111-111111111111';
const QID = '22222222-2222-4222-8222-222222222222';
const mkQ = (type: RsvpQuestion['type'], over: Partial<RsvpQuestion> = {}): RsvpQuestion => ({id: QID, label: 'Q', type, options: ['a', 'b'], required: false, ...over});
const rules = (questions: RsvpQuestion[] = [], over: Partial<RsvpRules> = {}): RsvpRules => ({allowMaybe: true, maxPlusOnes: 0, ticketTypeIds: [T], questions, ...over});
const body = (over: Record<string, unknown> = {}) => ({name: 'Ada', email: 'a@b.co', response: 'going', ...over});

describe('validateRsvp (ported adapters/schemas)', () => {
  it('maps plus-one limits to words', () => {
    const none = validateRsvp(body({plusOnes: 1}), rules());
    expect(!none.ok && none.fields.plusOnes).toBe('This event does not allow plus-ones.');
    const one = validateRsvp(body({plusOnes: 2}), rules([], {maxPlusOnes: 1}));
    expect(!one.ok && one.fields.plusOnes).toBe('You can bring up to 1 guest.');
    const many = validateRsvp(body({plusOnes: 5}), rules([], {maxPlusOnes: 3}));
    expect(!many.ok && many.fields.plusOnes).toBe('You can bring up to 3 guests.');
  });

  it('rejects fractional, negative and non-numeric plus-ones; blank means 0', () => {
    for (const p of [1.5, -1, 'x']) expect(validateRsvp(body({plusOnes: p}), rules([], {maxPlusOnes: 3})).ok).toBe(false);
    const ok = validateRsvp(body({plusOnes: ''}), rules());
    expect(ok.ok && ok.value.plusOnes).toBe(0);
  });

  it('limits name and email length and shape', () => {
    expect(validateRsvp(body({name: 'x'.repeat(121)}), rules()).ok).toBe(false);
    expect(validateRsvp(body({name: 'x'.repeat(120)}), rules()).ok).toBe(true);
    expect(validateRsvp(body({email: `${'a'.repeat(250)}@b.co`}), rules()).ok).toBe(false);
    expect(validateRsvp(body({email: 'a b@c.co'}), rules()).ok).toBe(false);
    expect(validateRsvp(body({email: 'a@b.c'}), rules()).ok).toBe(false);
    expect(validateRsvp(body({name: 12}), rules()).ok).toBe(false);
  });

  it('treats a non-object body as all-missing', () => {
    for (const raw of [null, 'x', [], 5]) expect(validateRsvp(raw, rules()).ok).toBe(false);
  });

  it('rejects maybe when the event refuses it, and bad responses', () => {
    expect(validateRsvp(body({response: 'maybe'}), rules([], {allowMaybe: false})).ok).toBe(false);
    expect(validateRsvp(body({response: 'yes'}), rules()).ok).toBe(false);
    expect(validateRsvp(body({response: 'maybe'}), rules()).ok).toBe(true);
  });

  it('only marketingConsent === true counts', () => {
    const t = validateRsvp(body({marketingConsent: true}), rules());
    const s = validateRsvp(body({marketingConsent: 'true'}), rules());
    expect(t.ok && t.value.marketingConsent).toBe(true);
    expect(s.ok && s.value.marketingConsent).toBe(false);
  });

  it('keeps a listed ticket, accepts blank, refuses malformed ids', () => {
    const ok = validateRsvp(body({ticketTypeId: T}), rules());
    expect(ok.ok && ok.value.ticketTypeId).toBe(T);
    const blank = validateRsvp(body({ticketTypeId: ''}), rules());
    expect(blank.ok && 'ticketTypeId' in blank.value).toBe(false);
    expect(validateRsvp(body({ticketTypeId: 'nope'}), rules()).ok).toBe(false);
    expect(validateRsvp(body({ticketTypeId: 5}), rules()).ok).toBe(false);
  });

  describe('answers by question type', () => {
    const run = (q: RsvpQuestion, value: unknown) => validateRsvp(body({answers: {[QID]: value}}), rules([q]));
    it('short_text <= 200 chars', () => {
      expect(run(mkQ('short_text'), 'x'.repeat(200)).ok).toBe(true);
      expect(run(mkQ('short_text'), 'x'.repeat(201)).ok).toBe(false);
      expect(run(mkQ('short_text'), true).ok).toBe(false);
    });
    it('long_text <= 2000 chars', () => {
      expect(run(mkQ('long_text'), 'x'.repeat(2000)).ok).toBe(true);
      expect(run(mkQ('long_text'), 'x'.repeat(2001)).ok).toBe(false);
    });
    it('checkbox is boolean; required needs true', () => {
      expect(run(mkQ('checkbox'), true).ok).toBe(true);
      expect(run(mkQ('checkbox'), 'yes').ok).toBe(false);
      expect(run(mkQ('checkbox', {required: true}), false).ok).toBe(false);
      expect(run(mkQ('checkbox', {required: true}), true).ok).toBe(true);
    });
    it('single_choice takes a listed option (or blank when optional)', () => {
      expect(run(mkQ('single_choice'), 'a').ok).toBe(true);
      expect(run(mkQ('single_choice'), '').ok).toBe(true);
      expect(run(mkQ('single_choice'), 'z').ok).toBe(false);
      expect(run(mkQ('single_choice', {required: true}), '').ok).toBe(false);
    });
    it('multi_choice takes listed options, at most 20', () => {
      expect(run(mkQ('multi_choice'), ['a', 'b']).ok).toBe(true);
      expect(run(mkQ('multi_choice'), ['a', 'z']).ok).toBe(false);
      expect(run(mkQ('multi_choice'), 'a').ok).toBe(false);
      expect(run(mkQ('multi_choice'), Array.from({length: 21}, () => 'a')).ok).toBe(false);
      expect(run(mkQ('multi_choice', {required: true}), []).ok).toBe(false);
    });
    it('a required blank text answer says it needs an answer; a decline skips it', () => {
      const q = mkQ('short_text', {required: true});
      const r = validateRsvp(body({answers: {[QID]: '   '}}), rules([q]));
      expect(!r.ok && r.fields[`answers.${QID}`]).toBe('This question needs an answer.');
      expect(validateRsvp(body({response: 'not_going'}), rules([q])).ok).toBe(true);
    });
    it('an unknown question id is refused, never stored', () => {
      const r = validateRsvp(body({answers: {'33333333-3333-4333-8333-333333333333': 'x'}}), rules());
      expect(!r.ok && Object.values(r.fields)).toEqual(['Unknown question.']);
    });
  });
});

describe('manage token windows', () => {
  const end = new Date('2026-12-01T00:00:00Z');
  const at = (days: number) => new Date(end.getTime() + days * 86_400_000);
  it('constants and exact boundaries', () => {
    expect([MANAGE_WRITE_DAYS, MANAGE_READ_DAYS]).toEqual([90, 180]);
    expect(manageTokenAllows(end, 'write', at(89.99))).toBe(true);
    expect(manageTokenAllows(end, 'write', at(90))).toBe(false);
    expect(manageTokenAllows(end, 'read', at(179.99))).toBe(true);
    expect(manageTokenAllows(end, 'read', at(180))).toBe(false);
    expect(manageTokenAllows(end, 'write', at(-30))).toBe(true);
  });
  it('holdsSeat is only confirmed/awaiting_payment Going', () => {
    expect(holdsSeat('going', 'confirmed')).toBe(true);
    expect(holdsSeat('going', 'awaiting_payment')).toBe(true);
    for (const s of ['pending', 'waitlisted', 'declined', 'cancelled']) expect(holdsSeat('going', s)).toBe(false);
    expect(holdsSeat('maybe', 'confirmed')).toBe(false);
    expect(holdsSeat('not_going', 'declined')).toBe(false);
  });
});

describe('place: more rules', () => {
  const NOW = new Date('2026-11-01T12:00:00Z');
  const base = (over: Partial<PlaceInput> = {}): PlaceInput => ({
    event: {status: 'published', endAt: new Date('2026-12-01T00:00:00Z'), capacity: 10, rsvpDeadline: null, waitlistEnabled: true, approvalRequired: false},
    current: null,
    response: 'going',
    plusOnes: 0,
    ticket: null,
    anyPaidTicket: false,
    seatsTaken: 0,
    ticketSeatsTaken: 0,
    waitlist: [],
    paymentsEnabled: false,
    now: NOW,
    ...over,
  });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof RsvpError ? e.code : 'other';
    }
    return null;
  };

  it('unlimited capacity never waitlists', () => {
    const e = base({seatsTaken: 5000});
    e.event.capacity = null;
    expect(place(e).status).toBe('confirmed');
  });
  it('a party larger than the whole capacity is event_full even with a waitlist', () => {
    expect(code(() => place(base({plusOnes: 10})))).toBe('event_full');
  });
  it('closed after the event ended', () => {
    const over = base();
    over.event.endAt = new Date('2026-10-01T00:00:00Z');
    expect(code(() => place(over))).toBe('rsvps_closed');
  });
  it('a decline is recorded even when the event is full or past the deadline', () => {
    const full = base({response: 'not_going', seatsTaken: 10});
    full.event.rsvpDeadline = new Date('2026-10-01T00:00:00Z');
    expect(code(() => place(full))).toBeNull();
  });
  it('waitlist position follows the last in line', () => {
    const wl = [
      {id: 'a', seats: 1, waitlistPosition: 1, createdAt: NOW},
      {id: 'b', seats: 1, waitlistPosition: 2, createdAt: NOW},
    ];
    expect(place(base({seatsTaken: 10, waitlist: wl})).waitlistPosition).toBe(3);
  });
});

describe('RSVP copy and conflicts', () => {
  const ctx = {host: 'Ada', email: 'a@b.co', waitlistPosition: 2, paid: false};
  it('confirmed Going is the one "You are in" state', () => {
    expect(statusCopy('confirmed', 'going', ctx).youreIn).toBe(true);
    expect(statusCopy('confirmed', 'maybe', ctx)).toMatchObject({youreIn: false, badge: {label: 'Maybe'}});
  });
  it('every status has copy, and only confirmed Going says you are in', () => {
    for (const s of Object.keys(statusBadge) as (keyof typeof statusBadge)[]) {
      for (const r of ['going', 'maybe', 'not_going'] as const) {
        const c = statusCopy(s, r, ctx);
        expect(c.title.length).toBeGreaterThan(0);
        expect(c.youreIn).toBe(s === 'confirmed' && r === 'going');
      }
    }
  });
  it('labels and conflict copy', () => {
    expect(responseLabel.not_going).toBe('Can’t go');
    for (const k of ['rsvps_closed', 'event_full', 'event_cancelled', 'ticket_sold_out', 'payments_unavailable']) expect(RSVP_CONFLICTS[k]).toBeTruthy();
  });
});

describe('ICS builder', () => {
  const input = {
    uid: icsUid('abc'),
    sequence: 0,
    title: 'Launch, party; now',
    description: 'https://x.test/events/a/',
    startAt: new Date('2026-11-01T18:00:00Z'),
    endAt: new Date('2026-11-01T20:00:00Z'),
    timezone: 'UTC',
    location: 'The Hall, 1 Main St',
    now: new Date('2026-10-01T00:00:00Z'),
  };
  it('uses UID = rsvp id, escapes text and ends the calendar', () => {
    expect(icsUid('abc')).toBe('abc@events.ezystudio');
    const ics = buildIcs(input);
    expect(ics).toContain('UID:abc@events.ezystudio');
    expect(ics).toContain('SUMMARY:Launch\\, party\\; now');
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('\r\n');
  });
  it('CANCEL method is emitted', () => {
    expect(buildIcs({...input, method: 'CANCEL', sequence: 5})).toContain('METHOD:CANCEL');
  });
  it('escapeIcsText and foldLine', () => {
    expect(escapeIcsText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
    for (const l of foldLine('X:' + 'é'.repeat(100)).split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(76);
  });
  it('google URL carries the title', () => {
    const u = googleCalendarUrl({title: 'Launch', description: 'd', startAt: input.startAt, endAt: input.endAt, location: null, timezone: 'UTC'});
    expect(u).toContain('calendar.google.com');
    expect(u).toContain('Launch');
  });
});
