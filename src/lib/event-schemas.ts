/**
 * Validation for the admin side of events, shared by the Site API
 * (`src/server/routes/admin-events.ts`, `event-settings.ts`) and the portal
 * forms: "client rules = server rules". Pure TypeScript, no DOM, no server code.
 *
 * Every parser takes `unknown` and answers `{ok: true, value}` with a NORMALISED
 * value (trimmed, blank optional text -> null, dates as ISO strings) or
 * `{ok: false, fields}` with one message per field, in the shape the forms show
 * in place (`422 {error: 'invalid_input', fields}`).
 */

import {formatInZone, zonedLocalToUtc} from '../domain/time';

export const EVENT_FORMATS = ['in_person', 'online', 'hybrid'] as const;
export const EVENT_VISIBILITIES = ['public', 'unlisted', 'private'] as const;
export const QUESTION_TYPES = ['short_text', 'long_text', 'single_choice', 'multi_choice', 'checkbox'] as const;
export const FONT_PRESETS = ['inter', 'serif', 'rounded'] as const;
export const REMINDER_KINDS = ['confirmation', 'reminder', 'live_now', 'thank_you'] as const;
export const POSTER_DESIGNS = ['breakfast', 'launch', 'ama', 'mastermind', 'workshop', 'kickoff'] as const;
export const POSTER_PALETTES = ['butter', 'cobalt', 'night', 'plum', 'tomato', 'mint', 'cream', 'teal', 'pink'] as const;
export const SUPPORTED_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'SGD', 'HKD', 'INR', 'MXN', 'BRL', 'ZAR', 'PLN', 'AED',
] as const;

export type EventFormat = (typeof EVENT_FORMATS)[number];
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];
export type EventStatus = 'draft' | 'published' | 'cancelled';
export type QuestionType = (typeof QUESTION_TYPES)[number];
export type FontPreset = (typeof FONT_PRESETS)[number];
export type ReminderKind = (typeof REMINDER_KINDS)[number];
export type PosterDesign = (typeof POSTER_DESIGNS)[number];
export type PosterPalette = (typeof POSTER_PALETTES)[number];
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export const MAX_RSVP_QUESTIONS = 10;
export const MAX_PLUS_ONES = 5;
export const MAX_CHOICE_OPTIONS = 20;
export const MAX_DEFAULT_REMINDER_RULES = 12;
export const MAX_PRICE_CENTS = 99_999_999;
export const MIN_SLUG_LENGTH = 3;
export const MAX_SLUG_LENGTH = 60;
export const CHOICE_QUESTION_TYPES: readonly QuestionType[] = ['single_choice', 'multi_choice'];

const STRIPE_MIN_CHARGE_CENTS: Record<CurrencyCode, number> = {
  USD: 50, EUR: 50, GBP: 50, CAD: 50, AUD: 50, NZD: 50, CHF: 50, SEK: 300, NOK: 300,
  DKK: 250, SGD: 50, HKD: 400, INR: 50, MXN: 1000, BRL: 50, ZAR: 1000, PLN: 200, AED: 200,
};

/** Minutes relative to the start (negative = before); `thank_you` is after the END. */
export const RULE_OFFSET_LIMITS: Record<ReminderKind, {min: number; max: number}> = {
  confirmation: {min: 0, max: 0},
  reminder: {min: -14 * 24 * 60, max: 0},
  live_now: {min: -60, max: 60},
  thank_you: {min: 0, max: 7 * 24 * 60},
};

export function offsetLimitMessage(kind: ReminderKind): string {
  switch (kind) {
    case 'confirmation':
      return 'Confirmation emails go out straight away.';
    case 'reminder':
      return 'Pick a time up to 14 days before the start.';
    case 'live_now':
      return 'Pick a time within an hour of the start.';
    case 'thank_you':
      return 'Pick a time up to 7 days after the end.';
  }
}

// ------------------------------------------------------------------ shapes --

export type FieldErrors = Record<string, string>;
export type Parsed<T> = {ok: true; value: T} | {ok: false; fields: FieldErrors};

export interface CoverStyle {
  palette?: PosterPalette;
  headline?: string;
  eyebrow?: string;
  footer?: string;
}

export interface QuestionInput {
  /** Present when editing a saved question; ignored unless it is one of the event's own. */
  id?: string;
  label: string;
  type: QuestionType;
  options: string[];
  required: boolean;
}

/** A normalised event body: what the database stores (dates as ISO strings). */
export interface EventValues {
  title: string;
  slug?: string;
  description: string;
  coverImageUrl: string | null;
  coverPoster: PosterDesign | null;
  coverStyle: CoverStyle | null;
  startAt: string;
  endAt: string;
  timezone: string;
  format: EventFormat;
  venueName: string | null;
  venueAddress: string | null;
  mapUrl: string | null;
  joinUrl: string | null;
  visibility: EventVisibility;
  capacity: number | null;
  rsvpDeadline: string | null;
  waitlistEnabled: boolean;
  approvalRequired: boolean;
  allowMaybe: boolean;
  maxPlusOnes: number;
  showGuestList: boolean;
  thankYouLink: string | null;
  questions: QuestionInput[];
}

export interface TicketValues {
  name: string;
  priceCents: number;
  currency: CurrencyCode;
  quantity: number | null;
  salesEndAt: string | null;
}

export interface ReminderRuleValues {
  kind: ReminderKind;
  offsetMinutes: number;
  enabled: boolean;
  subject: string;
  body: string;
}

export interface EventSettingsValues {
  brandColor: string | null;
  fontPreset: FontPreset;
  defaultTimezone: string;
  senderName: string;
  replyToEmail: string;
  defaultReminderRules: ReminderRuleValues[];
  allowMaybeDefault: boolean;
  showGuestListDefault: boolean;
  defaultCoverPoster: PosterDesign | null;
}

// --------------------------------------------------------------- primitives --

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: tz});
    return true;
  } catch {
    return false;
  }
}

/** An http(s) URL only: `javascript:` and `data:` links never get stored. */
export function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** `2026-10-20T18:00:00Z` or with an offset -> ISO UTC; null when it is not a date-time. */
export function toIso(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Collects field errors; the first message per field wins. */
export class Collector {
  readonly fields: FieldErrors = {};
  fail(name: string, message: string) {
    this.fields[name] ??= message;
  }
  get ok() {
    return Object.keys(this.fields).length === 0;
  }
}

function text(c: Collector, name: string, v: unknown, {min = 0, max, label}: {min?: number; max: number; label: string}): string | undefined {
  if (typeof v !== 'string') {
    c.fail(name, `Enter ${label}.`);
    return undefined;
  }
  const s = v.trim();
  if (s.length < min) c.fail(name, min === 1 ? `Enter ${label}.` : `${label} needs at least ${min} characters.`);
  else if (s.length > max) c.fail(name, `Keep ${label} under ${max + 1} characters.`);
  return s;
}

/** Optional text: absent/blank -> null. */
function optText(c: Collector, name: string, v: unknown, max: number, label: string): string | null | undefined {
  if (v === undefined || v === null) return null;
  const s = text(c, name, v, {max, label});
  return s === undefined ? undefined : s === '' ? null : s;
}

function optUrl(c: Collector, name: string, v: unknown): string | null | undefined {
  const s = optText(c, name, v, 2000, 'the link');
  if (s && !isHttpUrl(s)) {
    c.fail(name, 'Enter a full URL starting with https://');
    return undefined;
  }
  return s;
}

function bool(c: Collector, name: string, v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  c.fail(name, 'Choose yes or no.');
  return undefined;
}

function int(c: Collector, name: string, v: unknown, min: number, max: number, message: string): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    c.fail(name, message);
    return undefined;
  }
  return v;
}

const isBlank = (v: string | null | undefined) => v === undefined || v === null || v.trim() === '';

// ------------------------------------------------------------------- slugs --

export function slugError(slug: string): string | null {
  if (slug.length < MIN_SLUG_LENGTH) return `Use at least ${MIN_SLUG_LENGTH} characters.`;
  if (slug.length > MAX_SLUG_LENGTH) return `Keep the link under ${MAX_SLUG_LENGTH + 1} characters.`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return 'Use lowercase letters, numbers and hyphens only.';
  return null;
}

/** `/e/<slug>` is public: these first segments belong to other routes. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(['sitemap', 'new', 'api']);

// ------------------------------------------------------------------ events --

function parseCoverStyle(c: Collector, v: unknown): CoverStyle | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObject(v)) {
    c.fail('coverStyle', 'Poster tweaks are not valid.');
    return undefined;
  }
  const out: CoverStyle = {};
  if (v.palette !== undefined && v.palette !== null && v.palette !== '') {
    if (isIn(POSTER_PALETTES, v.palette)) out.palette = v.palette;
    else c.fail('coverStyle', 'Pick one of the colour sets.');
  }
  for (const [key, max] of [['headline', 80], ['eyebrow', 40], ['footer', 60]] as const) {
    const s = optText(c, 'coverStyle', v[key], max, `the poster ${key}`);
    if (s) out[key] = s;
  }
  return Object.keys(out).length ? out : null;
}

export function parseQuestions(c: Collector, v: unknown, field = 'questions'): QuestionInput[] | undefined {
  if (!Array.isArray(v)) {
    c.fail(field, 'Questions must be a list.');
    return undefined;
  }
  if (v.length > MAX_RSVP_QUESTIONS) {
    c.fail(field, `Use at most ${MAX_RSVP_QUESTIONS} questions.`);
    return undefined;
  }
  const out: QuestionInput[] = [];
  v.forEach((raw, i) => {
    const name = `${field}.${i}`;
    if (!isObject(raw)) return c.fail(name, 'This question is not valid.');
    const label = text(c, `${name}.label`, raw.label, {min: 1, max: 200, label: 'the question'});
    const type = isIn(QUESTION_TYPES, raw.type) ? raw.type : undefined;
    if (!type) c.fail(`${name}.type`, 'Pick a question type.');
    const rawOptions = raw.options === undefined ? [] : raw.options;
    const options: string[] = [];
    if (!Array.isArray(rawOptions) || rawOptions.length > MAX_CHOICE_OPTIONS) {
      c.fail(`${name}.options`, `Use at most ${MAX_CHOICE_OPTIONS} options.`);
    } else {
      for (const o of rawOptions) {
        const s = typeof o === 'string' ? o.trim() : '';
        if (!s || s.length > 100) c.fail(`${name}.options`, 'Options need 1 to 100 characters.');
        else options.push(s);
      }
      if (new Set(options.map(o => o.toLowerCase())).size !== options.length) c.fail(`${name}.options`, 'Each option must be different.');
    }
    if (type && CHOICE_QUESTION_TYPES.includes(type) && options.length < 2) c.fail(`${name}.options`, 'Add at least 2 options to choose from.');
    const required = raw.required === undefined ? false : bool(c, `${name}.required`, raw.required);
    let id: string | undefined;
    if (raw.id !== undefined && raw.id !== null) {
      if (isUuid(raw.id)) id = raw.id;
      else c.fail(`${name}.id`, 'Invalid id.');
    }
    if (label !== undefined && type && required !== undefined) {
      out.push({...(id ? {id} : {}), label, type, options: type === 'short_text' || type === 'long_text' || type === 'checkbox' ? [] : options, required});
    }
  });
  return out;
}

/** The cross-field rules on a COMPLETE event (create, or a patch merged onto the stored one). */
export function eventRuleErrors(e: EventValues): FieldErrors {
  const c = new Collector();
  if (Date.parse(e.endAt) <= Date.parse(e.startAt)) c.fail('endAt', 'End must be after the start.');
  if (e.format !== 'online') {
    if (isBlank(e.venueName)) c.fail('venueName', 'Add the venue name.');
    if (isBlank(e.venueAddress)) c.fail('venueAddress', 'Add the venue address.');
  }
  if (e.format !== 'in_person' && isBlank(e.joinUrl)) c.fail('joinUrl', 'Add the link guests use to join online.');
  if (e.rsvpDeadline && Date.parse(e.rsvpDeadline) > Date.parse(e.startAt)) {
    c.fail('rsvpDeadline', 'The RSVP deadline must be before the event starts.');
  }
  return c.fields;
}

/**
 * Parses an event body. `partial` (PATCH) keeps ONLY the keys that were sent,
 * so a patch of the title never resets the other fields; otherwise every key
 * is required or defaulted. Cross-field rules are NOT run here: call
 * `eventRuleErrors` on the complete event.
 */
export function parseEventFields(raw: unknown, partial: boolean): Parsed<Partial<EventValues>> {
  if (!isObject(raw)) return {ok: false, fields: {_: 'Send the event as a JSON object.'}};
  const c = new Collector();
  const out: Partial<EventValues> = {};
  const has = (k: string) => raw[k] !== undefined;
  const need = (k: string) => (partial ? has(k) : true);
  const set = <K extends keyof EventValues>(k: K, v: EventValues[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };

  if (need('title')) set('title', text(c, 'title', raw.title, {min: 1, max: 120, label: 'a title'}));
  if (has('slug') && raw.slug !== null && raw.slug !== '') {
    const slug = typeof raw.slug === 'string' ? raw.slug.trim().toLowerCase() : '';
    const err = slug ? slugError(slug) : 'Use lowercase letters, numbers and hyphens only.';
    if (err) c.fail('slug', err);
    else if (RESERVED_SLUGS.has(slug)) c.fail('slug', 'That link is reserved. Pick another.');
    else out.slug = slug;
  }
  if (has('description') || !partial) set('description', raw.description === undefined ? '' : text(c, 'description', raw.description, {max: 20_000, label: 'the description'}) );
  if (has('coverImageUrl') || !partial) set('coverImageUrl', optUrl(c, 'coverImageUrl', raw.coverImageUrl));
  if (has('coverPoster')) {
    if (raw.coverPoster === null || raw.coverPoster === '') out.coverPoster = null;
    else if (isIn(POSTER_DESIGNS, raw.coverPoster)) out.coverPoster = raw.coverPoster;
    else c.fail('coverPoster', 'Pick one of the posters.');
  }
  if (has('coverStyle') || !partial) set('coverStyle', parseCoverStyle(c, raw.coverStyle));
  for (const key of ['startAt', 'endAt'] as const) {
    if (need(key)) {
      const iso = toIso(raw[key]);
      if (iso) out[key] = iso;
      else c.fail(key, 'Enter a valid date and time.');
    }
  }
  if (need('timezone')) {
    const tz = typeof raw.timezone === 'string' ? raw.timezone.trim() : '';
    if (tz && isValidTimeZone(tz)) out.timezone = tz;
    else c.fail('timezone', tz ? 'Choose a valid timezone, e.g. Europe/London.' : 'Choose a timezone.');
  }
  if (need('format')) {
    if (isIn(EVENT_FORMATS, raw.format)) out.format = raw.format;
    else c.fail('format', 'Choose in person, online or hybrid.');
  }
  if (has('venueName') || !partial) set('venueName', optText(c, 'venueName', raw.venueName, 200, 'the venue name'));
  if (has('venueAddress') || !partial) set('venueAddress', optText(c, 'venueAddress', raw.venueAddress, 500, 'the address'));
  if (has('mapUrl') || !partial) set('mapUrl', optUrl(c, 'mapUrl', raw.mapUrl));
  if (has('joinUrl') || !partial) set('joinUrl', optUrl(c, 'joinUrl', raw.joinUrl));
  if (has('visibility') || !partial) {
    const v = raw.visibility === undefined ? 'public' : raw.visibility;
    if (isIn(EVENT_VISIBILITIES, v)) out.visibility = v;
    else c.fail('visibility', 'Choose public, unlisted or private.');
  }
  if (has('capacity') || !partial) {
    if (raw.capacity === null || raw.capacity === undefined) out.capacity = null;
    else set('capacity', int(c, 'capacity', raw.capacity, 1, 1_000_000, 'Capacity must be a whole number, at least 1.'));
  }
  if (has('rsvpDeadline') || !partial) {
    if (raw.rsvpDeadline === null || raw.rsvpDeadline === undefined) out.rsvpDeadline = null;
    else {
      const iso = toIso(raw.rsvpDeadline);
      if (iso) out.rsvpDeadline = iso;
      else c.fail('rsvpDeadline', 'Enter a valid date and time.');
    }
  }
  for (const [key, fallback] of [['waitlistEnabled', true], ['approvalRequired', false], ['allowMaybe', true], ['showGuestList', false]] as const) {
    if (has(key) || !partial) set(key, raw[key] === undefined ? fallback : bool(c, key, raw[key]));
  }
  if (has('maxPlusOnes') || !partial) {
    set('maxPlusOnes', raw.maxPlusOnes === undefined ? 0 : int(c, 'maxPlusOnes', raw.maxPlusOnes, 0, MAX_PLUS_ONES, `Allow between 0 and ${MAX_PLUS_ONES} plus-ones.`));
  }
  if (has('thankYouLink') || !partial) set('thankYouLink', optUrl(c, 'thankYouLink', raw.thankYouLink));
  if (has('questions') || !partial) set('questions', raw.questions === undefined ? [] : parseQuestions(c, raw.questions));

  return c.ok ? {ok: true, value: out} : {ok: false, fields: c.fields};
}

/** A complete event: `base` (defaults or the stored event) with the sent keys on top, then the cross-field rules. */
export function completeEvent(base: EventValues, patch: Partial<EventValues>): Parsed<EventValues> {
  const merged: EventValues = {
    title: patch.title ?? base.title,
    slug: patch.slug ?? base.slug,
    description: patch.description ?? base.description,
    coverImageUrl: patch.coverImageUrl !== undefined ? patch.coverImageUrl : base.coverImageUrl,
    coverPoster: patch.coverPoster !== undefined ? patch.coverPoster : base.coverPoster,
    coverStyle: patch.coverStyle !== undefined ? patch.coverStyle : base.coverStyle,
    startAt: patch.startAt ?? base.startAt,
    endAt: patch.endAt ?? base.endAt,
    timezone: patch.timezone ?? base.timezone,
    format: patch.format ?? base.format,
    venueName: patch.venueName !== undefined ? patch.venueName : base.venueName,
    venueAddress: patch.venueAddress !== undefined ? patch.venueAddress : base.venueAddress,
    mapUrl: patch.mapUrl !== undefined ? patch.mapUrl : base.mapUrl,
    joinUrl: patch.joinUrl !== undefined ? patch.joinUrl : base.joinUrl,
    visibility: patch.visibility ?? base.visibility,
    capacity: patch.capacity !== undefined ? patch.capacity : base.capacity,
    rsvpDeadline: patch.rsvpDeadline !== undefined ? patch.rsvpDeadline : base.rsvpDeadline,
    waitlistEnabled: patch.waitlistEnabled ?? base.waitlistEnabled,
    approvalRequired: patch.approvalRequired ?? base.approvalRequired,
    allowMaybe: patch.allowMaybe ?? base.allowMaybe,
    maxPlusOnes: patch.maxPlusOnes ?? base.maxPlusOnes,
    showGuestList: patch.showGuestList ?? base.showGuestList,
    thankYouLink: patch.thankYouLink !== undefined ? patch.thankYouLink : base.thankYouLink,
    questions: patch.questions ?? base.questions,
  };
  const fields = eventRuleErrors(merged);
  return Object.keys(fields).length ? {ok: false, fields} : {ok: true, value: merged};
}

// ----------------------------------------------------------------- tickets --

/** Why a ticket price cannot be charged, or null (0 = free). `maxSeats` = 1 + the event's plus-ones. */
export function ticketPriceError(priceCents: number, currency: string, maxSeats = 1): string | null {
  if (priceCents === 0) return null;
  const min = STRIPE_MIN_CHARGE_CENTS[currency.toUpperCase() as CurrencyCode];
  if (min !== undefined && priceCents < min) {
    return `Paid tickets must cost at least ${(min / 100).toFixed(2)} ${currency.toUpperCase()}.`;
  }
  if (priceCents * Math.max(1, maxSeats) > MAX_PRICE_CENTS) return 'That price is too high for a full party.';
  return null;
}

/** `partial` (PATCH) keeps only the keys sent. Price x seats is re-checked by the route against the event. */
export function parseTicket(raw: unknown, partial: boolean): Parsed<Partial<TicketValues>> {
  if (!isObject(raw)) return {ok: false, fields: {_: 'Send the ticket as a JSON object.'}};
  const c = new Collector();
  const out: Partial<TicketValues> = {};
  const has = (k: string) => raw[k] !== undefined;
  if (has('name') || !partial) {
    const name = text(c, 'name', raw.name, {min: 1, max: 80, label: 'a ticket name'});
    if (name !== undefined) out.name = name;
  }
  if (has('priceCents') || !partial) {
    const p = raw.priceCents === undefined ? 0 : int(c, 'priceCents', raw.priceCents, 0, MAX_PRICE_CENTS, 'Price must be a whole number of cents, 0 or more.');
    if (p !== undefined) out.priceCents = p;
  }
  if (has('currency') || !partial) {
    const cur = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : raw.currency === undefined ? 'USD' : '';
    if (isIn(SUPPORTED_CURRENCIES, cur)) out.currency = cur;
    else c.fail('currency', 'Choose a supported currency.');
  }
  if (has('quantity') || !partial) {
    if (raw.quantity === null || raw.quantity === undefined) out.quantity = null;
    else {
      const q = int(c, 'quantity', raw.quantity, 1, 100_000, 'Use a whole number from 1 to 100,000.');
      if (q !== undefined) out.quantity = q;
    }
  }
  if (has('salesEndAt') || !partial) {
    if (raw.salesEndAt === null || raw.salesEndAt === undefined) out.salesEndAt = null;
    else {
      const iso = toIso(raw.salesEndAt);
      if (iso) out.salesEndAt = iso;
      else c.fail('salesEndAt', 'Enter a valid date and time.');
    }
  }
  if (out.priceCents !== undefined && out.currency !== undefined) {
    const err = ticketPriceError(out.priceCents, out.currency);
    if (err) c.fail('priceCents', err);
  }
  return c.ok ? {ok: true, value: out} : {ok: false, fields: c.fields};
}

// ---------------------------------------------------------------- settings --

export function parseReminderRules(c: Collector, v: unknown, field: string): ReminderRuleValues[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_DEFAULT_REMINDER_RULES) {
    c.fail(field, `Use at most ${MAX_DEFAULT_REMINDER_RULES} default emails.`);
    return undefined;
  }
  const out: ReminderRuleValues[] = [];
  v.forEach((raw, i) => {
    const name = `${field}.${i}`;
    if (!isObject(raw)) return c.fail(name, 'This email is not valid.');
    const kind = isIn(REMINDER_KINDS, raw.kind) ? raw.kind : undefined;
    if (!kind) c.fail(`${name}.kind`, 'Pick a kind of email.');
    const offset = int(c, `${name}.offsetMinutes`, raw.offsetMinutes, -10_000_000, 10_000_000, 'Use whole minutes.');
    if (kind && offset !== undefined) {
      const {min, max} = RULE_OFFSET_LIMITS[kind];
      if (offset < min || offset > max) c.fail(`${name}.offsetMinutes`, offsetLimitMessage(kind));
    }
    const subject = text(c, `${name}.subject`, raw.subject, {min: 1, max: 200, label: 'a subject'});
    const body = text(c, `${name}.body`, raw.body, {min: 1, max: 10_000, label: 'a message'});
    const enabled = raw.enabled === undefined ? true : bool(c, `${name}.enabled`, raw.enabled);
    if (kind && offset !== undefined && subject !== undefined && body !== undefined && enabled !== undefined) {
      out.push({kind, offsetMinutes: offset, enabled, subject, body});
    }
  });
  return out;
}

export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '');
  const hex = raw.length === 3 ? raw.replace(/./g, ch => ch + ch) : raw;
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** PATCH of the settings singleton: only the keys sent. */
export function parseSettingsPatch(raw: unknown): Parsed<Partial<EventSettingsValues>> {
  if (!isObject(raw)) return {ok: false, fields: {_: 'Send the settings as a JSON object.'}};
  const c = new Collector();
  const out: Partial<EventSettingsValues> = {};
  const has = (k: string) => raw[k] !== undefined;
  if (has('brandColor')) {
    if (raw.brandColor === null || raw.brandColor === '') out.brandColor = null;
    else {
      const hex = typeof raw.brandColor === 'string' ? normalizeHex(raw.brandColor) : null;
      if (hex) out.brandColor = hex;
      else c.fail('brandColor', 'Use a hex colour like #4f46e5.');
    }
  }
  if (has('fontPreset')) {
    if (isIn(FONT_PRESETS, raw.fontPreset)) out.fontPreset = raw.fontPreset;
    else c.fail('fontPreset', 'Choose a font.');
  }
  if (has('defaultTimezone')) {
    const tz = typeof raw.defaultTimezone === 'string' ? raw.defaultTimezone.trim() : '';
    if (tz && tz.length <= 64 && isValidTimeZone(tz)) out.defaultTimezone = tz;
    else c.fail('defaultTimezone', 'Choose a valid timezone, e.g. Europe/London.');
  }
  if (has('senderName')) {
    const s = text(c, 'senderName', raw.senderName, {min: 1, max: 80, label: 'a sender name'});
    if (s !== undefined) out.senderName = s;
  }
  if (has('replyToEmail')) {
    const s = typeof raw.replyToEmail === 'string' ? raw.replyToEmail.trim().toLowerCase() : '';
    if (s.length <= 254 && EMAIL.test(s)) out.replyToEmail = s;
    else c.fail('replyToEmail', 'Enter a valid email address.');
  }
  if (has('defaultReminderRules')) {
    const rules = parseReminderRules(c, raw.defaultReminderRules, 'defaultReminderRules');
    if (rules) out.defaultReminderRules = rules;
  }
  for (const key of ['allowMaybeDefault', 'showGuestListDefault'] as const) {
    if (has(key)) {
      const b = bool(c, key, raw[key]);
      if (b !== undefined) out[key] = b;
    }
  }
  if (has('defaultCoverPoster')) {
    if (raw.defaultCoverPoster === null || raw.defaultCoverPoster === '') out.defaultCoverPoster = null;
    else if (isIn(POSTER_DESIGNS, raw.defaultCoverPoster)) out.defaultCoverPoster = raw.defaultCoverPoster;
    else c.fail('defaultCoverPoster', 'Pick one of the posters.');
  }
  return c.ok ? {ok: true, value: out} : {ok: false, fields: c.fields};
}

/** The settings of a site that never saved any: what the singleton row starts as. */
export const DEFAULT_EVENT_SETTINGS: EventSettingsValues = {
  brandColor: null,
  fontPreset: 'inter',
  defaultTimezone: 'UTC',
  senderName: '',
  replyToEmail: '',
  defaultReminderRules: [],
  allowMaybeDefault: true,
  showGuestListDefault: false,
  defaultCoverPoster: null,
};

/** Starting copy when a creator adds an email rule. */
export const DEFAULT_RULE_COPY: Record<ReminderKind, Omit<ReminderRuleValues, 'kind' | 'enabled'>> = {
  confirmation: {
    offsetMinutes: 0,
    subject: "You're in: {{event.title}}",
    body: "Hi {{guest.first_name}},\n\nThanks for your RSVP. We've saved your place for {{event.start_local}}.",
  },
  reminder: {
    offsetMinutes: -24 * 60,
    subject: 'Tomorrow: {{event.title}}',
    body: 'Hi {{guest.first_name}},\n\nA quick reminder that {{event.title}} starts {{event.start_local}}.\n\nCan’t make it any more? Update your RSVP: {{rsvp.manage_url}}',
  },
  live_now: {
    offsetMinutes: 0,
    subject: "We're live: {{event.title}}",
    body: "Hi {{guest.first_name}},\n\nWe're starting now. Join here: {{event.join_url}}",
  },
  thank_you: {
    offsetMinutes: 120,
    subject: 'Thanks for coming to {{event.title}}',
    body: "Hi {{guest.first_name}},\n\nThank you for joining us. We'd love your feedback.",
  },
};

// ---------------------------------------------------------------- responses --

export type EventListTab = 'upcoming' | 'past' | 'drafts';
export const EVENT_LIST_TABS: readonly EventListTab[] = ['upcoming', 'past', 'drafts'];

/** RSVP rows per status (a quick glance on the list, not seat totals). */
export interface RsvpCounts {
  confirmed: number;
  waitlisted: number;
  pending: number;
}

export interface AdminEventSummary {
  id: string;
  slug: string;
  title: string;
  status: EventStatus;
  visibility: EventVisibility;
  format: EventFormat;
  startAt: string;
  endAt: string;
  timezone: string;
  capacity: number | null;
  coverImageUrl: string | null;
  coverPoster: string | null;
  counts: RsvpCounts;
}

export interface AdminQuestion {
  id: string;
  label: string;
  type: QuestionType;
  options: string[];
  required: boolean;
}

export interface AdminEventDetail extends AdminEventSummary {
  description: string;
  coverStyle: CoverStyle | null;
  venueName: string | null;
  venueAddress: string | null;
  mapUrl: string | null;
  joinUrl: string | null;
  rsvpDeadline: string | null;
  waitlistEnabled: boolean;
  approvalRequired: boolean;
  allowMaybe: boolean;
  maxPlusOnes: number;
  showGuestList: boolean;
  pollJoinCode: string;
  thankYouLink: string | null;
  questions: AdminQuestion[];
  /** The public page: `/e/<slug>`. */
  publicPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminTicketType {
  id: string;
  eventId: string;
  name: string;
  priceCents: number;
  currency: string;
  quantity: number | null;
  salesEndAt: string | null;
  /** Seats held by confirmed and awaiting-payment "going" RSVPs on this type. */
  sold: number;
  salesEnded: boolean;
}

export interface AdminEventsPage {
  events: AdminEventSummary[];
  /** Pass as `before` for the next page; null on the last. */
  nextBefore: string | null;
}

export interface CancelPreview {
  guestsToEmail: number;
  ordersToRefund: number;
  refundTotalCents: number;
  currency: string | null;
}

export interface EventSettingsDto extends EventSettingsValues {
  updatedAt: string | null;
}

// ------------------------------------------------------------- local times --

/** An instant as the value of a datetime-local input, shown in `timeZone` ("2026-10-25T18:00"). */
export function toLocalInput(iso: string, timeZone: string): string {
  return formatInZone(new Date(iso), timeZone, "yyyy-MM-dd'T'HH:mm");
}

/** A datetime-local value typed in `timeZone`, as an ISO instant; null when empty or not a date. */
export function fromLocalInput(local: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const date = zonedLocalToUtc(local, timeZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Every IANA zone the browser knows, for a Select (falls back to a short list). */
export function timeZoneOptions(current?: string): {value: string; label: string}[] {
  const supported = (Intl as unknown as {supportedValuesOf?: (key: string) => string[]}).supportedValuesOf?.('timeZone');
  const zones = new Set(supported ?? ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Dhaka', 'Asia/Tokyo', 'Australia/Sydney']);
  zones.add('UTC');
  if (current) zones.add(current);
  return [...zones].sort().map(value => ({value, label: value.replace(/_/g, ' ')}));
}
