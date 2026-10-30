import {describe, expect, it} from 'vitest';

import {type RsvpRules, validateRsvp} from '../src/lib/rsvp-types';
import {manageTokenAllows, type PlaceInput, place, RsvpError} from '../src/server/routes/rsvp';

const NOW = new Date('2026-11-01T12:00:00Z');
const TICKET = '11111111-1111-4111-8111-111111111111';
const Q = '22222222-2222-4222-8222-222222222222';

const rules: RsvpRules = {
  allowMaybe: true,
  maxPlusOnes: 2,
  ticketTypeIds: [TICKET],
  questions: [{id: Q, label: 'Diet', type: 'single_choice', options: ['none', 'veg'], required: true}],
};
const good = {name: ' Ada ', email: 'ADA@Example.com ', response: 'going', plusOnes: 1, answers: {[Q]: 'veg'}};

describe('validateRsvp', () => {
  it('trims, lowercases and keeps only known fields', () => {
    const r = validateRsvp({...good, isAdmin: true}, rules);
    expect(r).toEqual({
      ok: true,
      value: {name: 'Ada', email: 'ada@example.com', response: 'going', plusOnes: 1, answers: {[Q]: 'veg'}, marketingConsent: false},
    });
  });

  it('reports every wrong field in words', () => {
    const r = validateRsvp({name: '', email: 'nope', response: 'maybe', plusOnes: 9, answers: {}}, {...rules, allowMaybe: false});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.fields).sort()).toEqual(['answers.' + Q, 'email', 'name', 'plusOnes', 'response'].sort());
    }
  });

  it('only needs name and email to decline', () => {
    expect(validateRsvp({name: 'A', email: 'a@b.co', response: 'not_going'}, rules).ok).toBe(true);
  });

  it('refuses unknown questions, bad options and unlisted tickets', () => {
    const r = validateRsvp({...good, answers: {[Q]: 'steak', other: 'x'}, ticketTypeId: '33333333-3333-4333-8333-333333333333'}, rules);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fields).sort()).toEqual(['answers.other', 'answers.' + Q, 'ticketTypeId'].sort());
  });

  it('takes the email from the RSVP when it is fixed (manage form)', () => {
    const r = validateRsvp({...good, email: 'someone@else.com'}, rules, {fixedEmail: 'ada@example.com'});
    expect(r.ok && r.value.email).toBe('ada@example.com');
  });
});

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
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RsvpError ? e.code : 'other';
  }
  return null;
};

describe('place', () => {
  it('confirms while seats remain', () => {
    expect(place(base()).status).toBe('confirmed');
  });

  it('waitlists when full and numbers the line', () => {
    const wl = [{id: 'a', seats: 1, waitlistPosition: 3, createdAt: NOW}];
    expect(place(base({seatsTaken: 10, waitlist: wl}))).toMatchObject({status: 'waitlisted', waitlistPosition: 4});
  });

  it('rejects when full and the waitlist is off, or when closed', () => {
    const noList = base({seatsTaken: 10});
    noList.event.waitlistEnabled = false;
    expect(reason(() => place(noList))).toBe('event_full');
    const closed = base();
    closed.event.rsvpDeadline = new Date('2026-10-01T00:00:00Z');
    expect(reason(() => place(closed))).toBe('rsvps_closed');
  });

  it('holds approval requests as pending and takes a maybe without a seat', () => {
    const approval = base();
    approval.event.approvalRequired = true;
    expect(place(approval).status).toBe('pending');
    expect(place(base({response: 'maybe', seatsTaken: 10})).status).toBe('confirmed');
    expect(place(base({response: 'not_going'})).status).toBe('declined');
  });

  it('refuses a cancelled event', () => {
    const e = base();
    e.event.status = 'cancelled';
    expect(reason(() => place(e))).toBe('event_cancelled');
  });

  it('enforces ticket quantity and sales end', () => {
    const ticket = {id: TICKET, priceCents: 0, quantity: 2, salesEndAt: null};
    expect(reason(() => place(base({ticket, plusOnes: 1, ticketSeatsTaken: 1})))).toBe('ticket_sold_out');
    const ended = {...ticket, quantity: null, salesEndAt: new Date('2026-10-01T00:00:00Z')};
    expect(reason(() => place(base({ticket: ended})))).toBe('ticket_sales_ended');
  });

  it('holds a paid ticket as awaiting_payment only when payments are wired, else 409', () => {
    const ticket = {id: TICKET, priceCents: 2500, quantity: null, salesEndAt: null};
    expect(reason(() => place(base({ticket, anyPaidTicket: true})))).toBe('payments_unavailable');
    expect(place(base({ticket, anyPaidTicket: true, paymentsEnabled: true})).status).toBe('awaiting_payment');
    expect(reason(() => place(base({anyPaidTicket: true, paymentsEnabled: true})))).toBe('validation_failed');
  });

  it('never downgrades a confirmed guest who asks for more seats than fit', () => {
    const current = {id: 'r', response: 'going', status: 'confirmed', seats: 1, ticketTypeId: null, waitlistPosition: null, confirmedAt: NOW, claimExpiresAt: null};
    expect(reason(() => place(base({current, plusOnes: 5, seatsTaken: 8})))).toBe('event_full');
    expect(place(base({current, plusOnes: 0, seatsTaken: 9})).status).toBe('confirmed');
  });
});

describe('manageTokenAllows', () => {
  const end = new Date('2026-12-01T00:00:00Z');
  it('lets changes stop 90 days after the event and every use stop after 180', () => {
    expect(manageTokenAllows(end, 'write', new Date('2027-02-01T00:00:00Z'))).toBe(true);
    expect(manageTokenAllows(end, 'write', new Date('2027-03-15T00:00:00Z'))).toBe(false);
    expect(manageTokenAllows(end, 'read', new Date('2027-03-15T00:00:00Z'))).toBe(true);
    expect(manageTokenAllows(end, 'read', new Date('2027-06-15T00:00:00Z'))).toBe(false);
  });
});
