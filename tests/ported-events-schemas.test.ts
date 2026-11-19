import {describe, expect, it} from 'vitest';

import {formatMoney} from '../src/lib/format';
import {
  Collector,
  completeEvent,
  type EventValues,
  fromLocalInput,
  isHttpUrl,
  normalizeHex,
  parseEventFields,
  parseQuestions,
  parseReminderRules,
  parseSettingsPatch,
  parseTicket,
  SUPPORTED_CURRENCIES,
  ticketPriceError,
  toLocalInput,
} from '../src/lib/event-schemas';
import {posterFor} from '../src/lib/posters';

/**
 * Ported from CreatorCrowdHub: src/lib/schemas/schemas.test.ts (event input),
 * src/features/events-admin/lib.test.ts, src/features/tickets/money.test.ts and the
 * validation half of src/server/routes/workspace.test.ts. The new validators return
 * `{ok, fields}` instead of zod issues, and the cross-field rules run in `completeEvent`.
 */

const QID = '7d3c1f5e-4b8a-4c2d-9e1f-0a1b2c3d4e5f';

const onlineEvent = {
  title: 'Pricing your coaching offer',
  startAt: '2026-11-03T17:00:00Z',
  endAt: '2026-11-03T18:00:00Z',
  timezone: 'America/New_York',
  format: 'online',
  joinUrl: 'https://zoom.us/j/123',
};
const inPersonEvent = {...onlineEvent, format: 'in_person', joinUrl: undefined, venueName: 'The Loft', venueAddress: '12 High St, London'};

const EMPTY: EventValues = {
  title: '', description: '', coverImageUrl: null, coverPoster: null, coverStyle: null, startAt: '', endAt: '',
  timezone: 'UTC', format: 'in_person', venueName: null, venueAddress: null, mapUrl: null, joinUrl: null,
  visibility: 'public', capacity: null, rsvpDeadline: null, waitlistEnabled: true, approvalRequired: false,
  allowMaybe: true, maxPlusOnes: 0, showGuestList: false, thankYouLink: null, questions: [],
};

/** Both stages, as POST /admin-events runs them: field parsing, then the cross-field rules. */
function validate(raw: Record<string, unknown>): {ok: true; value: EventValues} | {ok: false; fields: Record<string, string>} {
  const parsed = parseEventFields(raw, false);
  if (!parsed.ok) return parsed;
  return completeEvent(EMPTY, parsed.value);
}
const paths = (raw: Record<string, unknown>) => {
  const r = validate(raw);
  return r.ok ? [] : Object.keys(r.fields).sort();
};

describe('event input (ported eventInputSchema)', () => {
  it('accepts a valid online event and fills defaults', () => {
    const r = validate(onlineEvent);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.visibility).toBe('public');
    expect(r.value.allowMaybe).toBe(true);
    expect(r.value.maxPlusOnes).toBe(0);
    expect(r.value.questions).toEqual([]);
  });

  it('accepts a valid in-person event', () => {
    expect(validate(inPersonEvent).ok).toBe(true);
  });

  it('requires a title of at most 120 characters', () => {
    expect(paths({...onlineEvent, title: '  '})).toContain('title');
    expect(paths({...onlineEvent, title: 'x'.repeat(121)})).toContain('title');
    expect(paths({...onlineEvent, title: 'x'.repeat(120)})).toEqual([]);
  });

  it('fails when end is before start or equal to it', () => {
    expect(paths({...onlineEvent, endAt: '2026-11-03T16:00:00Z'})).toEqual(['endAt']);
    expect(paths({...onlineEvent, endAt: onlineEvent.startAt})).toEqual(['endAt']);
  });

  it('fails in person without a venue', () => {
    expect(paths({...inPersonEvent, venueName: '', venueAddress: undefined})).toEqual(['venueAddress', 'venueName']);
  });

  it('fails online without a join URL', () => {
    expect(paths({...onlineEvent, joinUrl: ''})).toEqual(['joinUrl']);
  });

  it('hybrid needs both a venue and a join URL', () => {
    expect(paths({...onlineEvent, format: 'hybrid', joinUrl: undefined})).toEqual(['joinUrl', 'venueAddress', 'venueName']);
  });

  it('leaves an omitted timezone to the route default but rejects a blank or null one', () => {
    const {timezone: _tz, ...noZone} = onlineEvent;
    expect(paths(noZone)).not.toContain('timezone');
    expect(paths({...onlineEvent, timezone: ''})).toContain('timezone');
    expect(paths({...onlineEvent, timezone: null as never})).toContain('timezone');
  });

  it('rejects an invalid timezone', () => {
    expect(paths({...onlineEvent, timezone: 'Nowhere/Land'})).toContain('timezone');
  });

  it('fails when the RSVP deadline is after the start', () => {
    expect(paths({...onlineEvent, rsvpDeadline: '2026-11-03T17:30:00Z'})).toEqual(['rsvpDeadline']);
    expect(paths({...onlineEvent, rsvpDeadline: '2026-11-03T16:30:00Z'})).toEqual([]);
  });

  it('requires capacity to be a positive whole number', () => {
    expect(paths({...onlineEvent, capacity: 0})).toContain('capacity');
    expect(paths({...onlineEvent, capacity: 2.5})).toContain('capacity');
    expect(paths({...onlineEvent, capacity: null})).toEqual([]);
  });

  it('caps plus-ones at 5', () => {
    expect(paths({...onlineEvent, maxPlusOnes: 6})).toContain('maxPlusOnes');
    expect(paths({...onlineEvent, maxPlusOnes: 5})).toEqual([]);
  });

  it('allows at most 10 questions', () => {
    const q = (n: number) => Array.from({length: n}, (_, i) => ({label: `Q${i}`, type: 'short_text'}));
    expect(paths({...onlineEvent, questions: q(11)})).toEqual(['questions']);
    expect(paths({...onlineEvent, questions: q(10)})).toEqual([]);
  });

  it('fails a choice question without options, or with a single one', () => {
    expect(paths({...onlineEvent, questions: [{label: 'Track?', type: 'single_choice'}]})).toEqual(['questions.0.options']);
    expect(paths({...onlineEvent, questions: [{label: 'Topics?', type: 'multi_choice', options: ['Pricing']}]})).toEqual(['questions.0.options']);
    expect(paths({...onlineEvent, questions: [{label: 'Track?', type: 'single_choice', options: ['A', 'B']}]})).toEqual([]);
  });

  it('rejects a malformed slug and reserved words', () => {
    expect(paths({...onlineEvent, slug: 'Has Spaces!'})).toContain('slug');
    expect(paths({...onlineEvent, slug: 'api'})).toContain('slug');
    expect(paths({...onlineEvent, slug: 'good-slug'})).toEqual([]);
  });

  it('a blank event fails only on what the creator must fill', () => {
    const r = validate({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fields)).toEqual(expect.arrayContaining(['title', 'startAt', 'endAt']));
  });

  it('questions keep their order through parsing (detailToFormValues)', () => {
    const questions = [
      {id: '2f0e7a52-0f3a-4b8e-8f00-3a4f5b6c7d82', label: 'First', type: 'checkbox', options: [], required: true},
      {id: '1f0e7a52-0f3a-4b8e-8f00-3a4f5b6c7d82', label: 'Second', type: 'short_text', options: [], required: false},
    ];
    const parsed = parseEventFields({...onlineEvent, joinUrl: 'https://zoom.example/j/1', questions}, false);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.questions!.map(q => q.label)).toEqual(['First', 'Second']);
  });

  it('a PATCH keeps only the keys sent and merges onto the stored event', () => {
    const base = validate(onlineEvent);
    if (!base.ok) throw new Error('base');
    const patch = parseEventFields({title: 'Renamed'}, true);
    expect(patch.ok && Object.keys(patch.value)).toEqual(['title']);
    if (!patch.ok) return;
    const merged = completeEvent(base.value, patch.value);
    expect(merged.ok && merged.value.joinUrl).toBe('https://zoom.us/j/123');
    // Switching format on a stored online event surfaces the venue rules.
    const hybrid = parseEventFields({format: 'hybrid'}, true);
    const res = hybrid.ok ? completeEvent(base.value, hybrid.value) : null;
    expect(res && !res.ok && Object.keys(res.fields).sort()).toEqual(['venueAddress', 'venueName']);
  });
});

describe('questions (ported)', () => {
  it('keeps an existing question id and drops options of text types', () => {
    const c = new Collector();
    const out = parseQuestions(c, [{id: QID, label: 'Diet', type: 'long_text', options: ['x', 'y']}]);
    expect(c.ok).toBe(true);
    expect(out).toEqual([{id: QID, label: 'Diet', type: 'long_text', options: [], required: false}]);
  });
  it('reports a malformed id and duplicate options', () => {
    const c = new Collector();
    parseQuestions(c, [{id: 'nope', label: 'A', type: 'short_text'}, {label: 'B', type: 'single_choice', options: ['a', 'A']}]);
    expect(Object.keys(c.fields).sort()).toEqual(['questions.0.id', 'questions.1.options']);
  });
});

describe('URL fields (M12)', () => {
  const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(document.cookie)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'ftp://files.example/a', 'https:evil.example'];

  it('every event URL field rejects script, data and malformed URLs', () => {
    for (const v of bad) {
      expect(isHttpUrl(v), v).toBe(false);
      for (const field of ['coverImageUrl', 'mapUrl', 'joinUrl', 'thankYouLink']) {
        expect(paths({...onlineEvent, [field]: v}), `${field}=${v}`).toContain(field);
      }
    }
  });

  it('still accepts https and an empty form value', () => {
    for (const v of ['https://zoom.us/j/1', 'HTTPS://CDN.EXAMPLE/logo.png']) expect(isHttpUrl(v), v).toBe(true);
    expect(paths({...onlineEvent, mapUrl: 'https://maps.example/x', thankYouLink: ''})).toEqual([]);
  });

  // The source accepted http: links ("http://maps.example/x?q=1"); the port stores https only (see the findings file).
  it('refuses plain http: (deliberate tightening versus the source)', () => {
    expect(isHttpUrl('http://maps.example/x?q=1')).toBe(false);
  });
});

describe('ticket price rules (L30) and money', () => {
  it('free is 0; paid prices meet the per-currency minimum; a full party stays under the cap', () => {
    expect(ticketPriceError(0, 'USD')).toBeNull();
    expect(ticketPriceError(49, 'USD')).toMatch(/at least 0.50 USD/);
    expect(ticketPriceError(50, 'EUR')).toBeNull();
    expect(ticketPriceError(50, 'GBP')).toBeNull();
    expect(ticketPriceError(299, 'SEK')).toMatch(/3.00 SEK/);
    expect(ticketPriceError(999, 'MXN')).toMatch(/10.00 MXN/);
    expect(ticketPriceError(16_666_666, 'USD', 6)).toBeNull();
    expect(ticketPriceError(16_666_667, 'USD', 6)).toMatch(/too high/);
  });

  it('every supported currency has a minimum (1 cent is refused in all of them)', () => {
    for (const cur of SUPPORTED_CURRENCIES) expect(ticketPriceError(1, cur), cur).toMatch(/at least/);
  });

  it('the ticket parser refuses a paid price under the minimum and accepts free and partial input', () => {
    expect(parseTicket({name: 'A', priceCents: 30, currency: 'usd'}, false).ok).toBe(false);
    expect(parseTicket({name: 'A', priceCents: 0, currency: 'usd'}, false).ok).toBe(true);
    expect(parseTicket({name: 'Renamed'}, true)).toEqual({ok: true, value: {name: 'Renamed'}});
  });

  it('validates whole cents and a supported currency', () => {
    const r = parseTicket({name: 'X', priceCents: 10.5, currency: 'ZZZ'}, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fields).sort()).toEqual(['currency', 'priceCents']);
  });

  it('normalises currency to upper case, and defaults to a free USD ticket', () => {
    expect(parseTicket({name: 'VIP', priceCents: 4900, currency: 'usd', quantity: 20}, false)).toEqual({
      ok: true,
      value: {name: 'VIP', priceCents: 4900, currency: 'USD', quantity: 20, salesEndAt: null},
    });
    expect(parseTicket({name: 'Community'}, false)).toMatchObject({ok: true, value: {priceCents: 0, currency: 'USD', quantity: null}});
  });

  it('formats in the ticket currency', () => {
    expect(formatMoney(4900, 'USD', 'en-US')).toBe('$49.00');
    expect(formatMoney(4950, 'EUR', 'en-US')).toBe('€49.50');
  });

  // parseMajorToCents / centsToInput / currencySymbol (source money.ts) have no counterpart in the port.
  it.todo('parseMajorToCents / centsToInput helpers are not ported (see test-findings-events.md)');
});

describe('zoned date helpers', () => {
  it('round-trips wall-clock time through an IANA zone', () => {
    const iso = fromLocalInput('2026-11-14T19:00', 'Europe/London');
    expect(iso).toBe('2026-11-14T19:00:00.000Z');
    expect(toLocalInput(iso!, 'Europe/London')).toBe('2026-11-14T19:00');
  });

  it('honours daylight saving', () => {
    const iso = fromLocalInput('2026-07-01T18:00', 'America/New_York');
    expect(iso).toBe('2026-07-01T22:00:00.000Z');
    expect(toLocalInput(iso!, 'America/New_York')).toBe('2026-07-01T18:00');
  });

  it('returns null until the input is complete', () => {
    expect(fromLocalInput('2026-11-14', 'Europe/London')).toBeNull();
    expect(fromLocalInput('', 'Europe/London')).toBeNull();
  });
});

describe('posterFor', () => {
  it('is stable for the same seed', () => {
    expect(posterFor('abc')).toBe(posterFor('abc'));
  });
});

describe('settings patch (ported workspace PATCH validation)', () => {
  it('normalises colour and email; unknown keys never survive', () => {
    const r = parseSettingsPatch({brandColor: '#4F46E5', fontPreset: 'serif', defaultTimezone: 'America/New_York', replyToEmail: ' Hello@Clara.Example ', stripeConnected: true, id: 'w2'});
    expect(r).toEqual({ok: true, value: {brandColor: '#4f46e5', fontPreset: 'serif', defaultTimezone: 'America/New_York', replyToEmail: 'hello@clara.example'}});
  });

  it('accepts null to reset the brand colour; expands short hex', () => {
    expect(parseSettingsPatch({brandColor: null})).toEqual({ok: true, value: {brandColor: null}});
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('red')).toBeNull();
  });

  it('422s invalid values with one message per field', () => {
    const r = parseSettingsPatch({brandColor: 'red', fontPreset: 'comic', defaultTimezone: 'Mars/Olympus_Mons', replyToEmail: 'not-an-email', senderName: 42});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fields).sort()).toEqual(['brandColor', 'defaultTimezone', 'fontPreset', 'replyToEmail', 'senderName']);
  });

  it('422s default reminder offsets outside the per-kind limits and unknown posters', () => {
    const r = parseSettingsPatch({defaultCoverPoster: 'neon', defaultReminderRules: [{kind: 'reminder', offsetMinutes: 60, subject: 'Late', body: 'Too late'}]});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fields).sort()).toEqual(['defaultCoverPoster', 'defaultReminderRules.0.offsetMinutes']);
  });

  it('takes a default poster and valid rules, keeping the disabled one', () => {
    const rules = [
      {kind: 'reminder', offsetMinutes: -1440, enabled: true, subject: 'Tomorrow', body: 'See you tomorrow'},
      {kind: 'reminder', offsetMinutes: -60, enabled: false, subject: 'Soon', body: 'Starting soon'},
    ];
    expect(parseSettingsPatch({defaultCoverPoster: 'launch', defaultReminderRules: rules})).toEqual({ok: true, value: {defaultCoverPoster: 'launch', defaultReminderRules: rules}});
  });
});

describe('default reminder rules (ported DefaultRemindersEditor expectations)', () => {
  it('rules of each kind with valid copy parse unchanged', () => {
    for (const kind of ['reminder', 'live_now', 'thank_you'] as const) {
      const c = new Collector();
      const rule = {kind, offsetMinutes: kind === 'reminder' ? -60 : 0, enabled: true, subject: 'S {{event.title}}', body: 'B'};
      expect(parseReminderRules(c, [rule], 'r')).toEqual([rule]);
      expect(c.ok).toBe(true);
    }
  });
  it('enforces per-kind offset limits and a max of 12 rules', () => {
    const c = new Collector();
    parseReminderRules(c, [{kind: 'confirmation', offsetMinutes: -5, subject: 'a', body: 'b'}, {kind: 'live_now', offsetMinutes: 61, subject: 'a', body: 'b'}], 'r');
    expect(Object.keys(c.fields).sort()).toEqual(['r.0.offsetMinutes', 'r.1.offsetMinutes']);
    const many = new Collector();
    parseReminderRules(many, Array.from({length: 13}, () => ({kind: 'reminder', offsetMinutes: -60, subject: 'a', body: 'b'})), 'r');
    expect(many.fields.r).toBeTruthy();
  });
  it('drops out-of-limit rules from the parsed list', () => {
    const good = {kind: 'reminder', offsetMinutes: -60, enabled: true, subject: 'a', body: 'b'};
    const out = parseReminderRules(new Collector(), [{kind: 'reminder', offsetMinutes: 99999, subject: 'a', body: 'b'}, good], 'r');
    expect(out).toEqual([good]);
  });
  // setReminderOffsets / setKindEnabled / offsetLabel / REMINDER_PRESETS lived in the source React component and were not ported.
  it.todo('setReminderOffsets / setKindEnabled editor helpers are not ported (see test-findings-events.md)');
});
