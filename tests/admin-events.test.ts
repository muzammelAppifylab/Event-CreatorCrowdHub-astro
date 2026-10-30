import {describe, expect, it} from 'vitest';

import {
  completeEvent,
  type EventValues,
  fromLocalInput,
  parseEventFields,
  parseSettingsPatch,
  parseTicket,
  slugError,
  ticketPriceError,
  toLocalInput,
} from '../src/lib/event-schemas';
import {uuidV7} from '../src/server/routes/admin-events';

const valid = {
  title: '  Launch party ',
  startAt: '2026-11-20T18:00:00Z',
  endAt: '2026-11-20T20:00:00Z',
  timezone: 'Europe/London',
  format: 'in_person',
  venueName: 'The Hall',
  venueAddress: '1 High Street',
};

const base: EventValues = {
  title: 'Base',
  description: '',
  coverImageUrl: null,
  coverPoster: null,
  coverStyle: null,
  startAt: '2026-11-20T18:00:00.000Z',
  endAt: '2026-11-20T20:00:00.000Z',
  timezone: 'UTC',
  format: 'in_person',
  venueName: 'Hall',
  venueAddress: 'Street',
  mapUrl: null,
  joinUrl: null,
  visibility: 'public',
  capacity: null,
  rsvpDeadline: null,
  waitlistEnabled: true,
  approvalRequired: false,
  allowMaybe: true,
  maxPlusOnes: 0,
  showGuestList: false,
  thankYouLink: null,
  questions: [],
};

describe('parseEventFields', () => {
  it('normalises a full body and fills defaults', () => {
    const r = parseEventFields(valid, false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe('Launch party');
    expect(r.value.startAt).toBe('2026-11-20T18:00:00.000Z');
    expect(r.value.visibility).toBe('public');
    expect(r.value.allowMaybe).toBe(true);
    expect(r.value.capacity).toBeNull();
    expect(r.value.mapUrl).toBeNull();
    expect(r.value.questions).toEqual([]);
  });

  it('a patch keeps only the keys that were sent', () => {
    expect(parseEventFields({title: 'New'}, true)).toEqual({ok: true, value: {title: 'New'}});
  });

  it('ignores keys it does not know (no smuggled columns)', () => {
    const r = parseEventFields({...valid, status: 'published', deletedAt: '2020-01-01', id: 'x', pollJoinCode: 'AAAAAA'}, false);
    expect(r.ok).toBe(true);
    const keys = r.ok ? Object.keys(r.value) : [];
    for (const smuggled of ['status', 'deletedAt', 'id', 'pollJoinCode']) expect(keys).not.toContain(smuggled);
  });

  it('reports one message per bad field', () => {
    const r = parseEventFields(
      {title: '', startAt: 'tomorrow', endAt: '2026-11-20T20:00', timezone: 'Mars/Base', format: 'x', mapUrl: 'javascript:alert(1)', capacity: 0, maxPlusOnes: 9},
      false
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    for (const key of ['title', 'startAt', 'endAt', 'timezone', 'format', 'mapUrl', 'capacity', 'maxPlusOnes']) {
      expect(r.fields[key], key).toBeTruthy();
    }
  });

  it('refuses a body that is not an object', () => {
    expect(parseEventFields([], false).ok).toBe(false);
    expect(parseEventFields(null, true).ok).toBe(false);
  });

  it('validates slugs and reserves route words', () => {
    expect(slugError('ab')).toBeTruthy();
    expect(slugError('Has Caps')).toBeTruthy();
    expect(slugError('good-slug-2')).toBeNull();
    expect(parseEventFields({slug: 'sitemap'}, true).ok).toBe(false);
  });

  it('validates questions: options for choices, unique options, limits', () => {
    const bad = parseEventFields(
      {questions: [{label: 'Pick', type: 'single_choice', options: ['a']}, {label: '', type: 'short_text'}, {label: 'Dup', type: 'multi_choice', options: ['a', 'A']}]},
      true
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.fields['questions.0.options']).toBeTruthy();
    expect(bad.fields['questions.1.label']).toBeTruthy();
    expect(bad.fields['questions.2.options']).toBeTruthy();
    const many = parseEventFields({questions: Array.from({length: 11}, () => ({label: 'q', type: 'short_text'}))}, true);
    expect(many.ok).toBe(false);
    const ok = parseEventFields({questions: [{label: ' Diet ', type: 'short_text', options: ['ignored'], required: true}]}, true);
    expect(ok).toEqual({ok: true, value: {questions: [{label: 'Diet', type: 'short_text', options: [], required: true}]}});
  });
});

describe('completeEvent (cross-field rules)', () => {
  it('needs the end after the start', () => {
    const r = completeEvent(base, {endAt: '2026-11-20T17:00:00.000Z'});
    expect(!r.ok && r.fields.endAt).toBeTruthy();
  });

  it('needs a venue unless online and a join link unless in person', () => {
    const online = completeEvent(base, {format: 'online', venueName: null, venueAddress: null});
    expect(!online.ok && online.fields.joinUrl).toBeTruthy();
    expect(!online.ok && online.fields.venueName).toBeUndefined();
    const hybrid = completeEvent(base, {format: 'hybrid', venueName: null});
    expect(!hybrid.ok && hybrid.fields.venueName).toBeTruthy();
    expect(!hybrid.ok && hybrid.fields.joinUrl).toBeTruthy();
  });

  it('keeps the RSVP deadline before the start', () => {
    const r = completeEvent(base, {rsvpDeadline: '2026-11-21T00:00:00.000Z'});
    expect(!r.ok && r.fields.rsvpDeadline).toBeTruthy();
  });

  it('merges a patch onto the stored event', () => {
    const r = completeEvent(base, {title: 'Renamed', capacity: 50});
    expect(r.ok && r.value.title).toBe('Renamed');
    expect(r.ok && r.value.venueName).toBe('Hall');
    expect(r.ok && r.value.capacity).toBe(50);
  });
});

describe('tickets', () => {
  it('rejects prices Stripe cannot charge', () => {
    expect(ticketPriceError(0, 'USD')).toBeNull();
    expect(ticketPriceError(10, 'USD')).toMatch(/at least 0.50/);
    expect(ticketPriceError(99_999_999, 'USD', 6)).toMatch(/too high/);
  });

  it('parses a full ticket and a partial one', () => {
    expect(parseTicket({name: ' VIP ', priceCents: 2500, currency: 'eur', quantity: 10}, false)).toEqual({
      ok: true,
      value: {name: 'VIP', priceCents: 2500, currency: 'EUR', quantity: 10, salesEndAt: null},
    });
    expect(parseTicket({quantity: null}, true)).toEqual({ok: true, value: {quantity: null}});
    const bad = parseTicket({name: '', priceCents: 1.5, currency: 'XXX', quantity: 0, salesEndAt: 'soon'}, false);
    expect(!bad.ok && Object.keys(bad.fields).sort()).toEqual(['currency', 'name', 'priceCents', 'quantity', 'salesEndAt']);
  });
});

describe('settings patch', () => {
  it('normalises the colour and validates the rest', () => {
    expect(parseSettingsPatch({brandColor: '#ABC'})).toEqual({ok: true, value: {brandColor: '#aabbcc'}});
    expect(parseSettingsPatch({brandColor: ''})).toEqual({ok: true, value: {brandColor: null}});
    const bad = parseSettingsPatch({brandColor: 'red', fontPreset: 'comic', defaultTimezone: 'No/Where', replyToEmail: 'nope', senderName: ''});
    expect(!bad.ok && Object.keys(bad.fields).sort()).toEqual(['brandColor', 'defaultTimezone', 'fontPreset', 'replyToEmail', 'senderName']);
  });

  it('checks default email rules against the offset limits', () => {
    const rule = {kind: 'reminder', offsetMinutes: -60, enabled: true, subject: 'Soon', body: 'Hi'};
    expect(parseSettingsPatch({defaultReminderRules: [rule]}).ok).toBe(true);
    const bad = parseSettingsPatch({defaultReminderRules: [{...rule, offsetMinutes: 60}, {...rule, kind: 'confirmation', offsetMinutes: 5}]});
    expect(!bad.ok && bad.fields['defaultReminderRules.0.offsetMinutes']).toBeTruthy();
    expect(!bad.ok && bad.fields['defaultReminderRules.1.offsetMinutes']).toBeTruthy();
  });
});

describe('time and ids', () => {
  it('round-trips wall-clock input through the event timezone', () => {
    const iso = fromLocalInput('2026-07-01T18:00', 'Europe/London');
    expect(iso).toBe('2026-07-01T17:00:00.000Z');
    expect(toLocalInput(iso!, 'Europe/London')).toBe('2026-07-01T18:00');
    expect(fromLocalInput('', 'UTC')).toBeNull();
  });

  it('uuidV7 is a uuid and sorts by time', () => {
    const a = uuidV7(1_000_000);
    const b = uuidV7(2_000_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
