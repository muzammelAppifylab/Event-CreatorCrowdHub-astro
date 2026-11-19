/**
 * Guest RSVP types and validation, shared by the Site API (`src/server/routes/rsvp.ts`) and the
 * browser forms (`src/components/rsvp/`). Pure: no database, no Node APIs, so the form and the
 * route reject exactly the same things (US-7, US-8, US-16).
 */

import {hasNul, isUuid, NUL_MESSAGE} from './text';

export type RsvpResponse = 'going' | 'maybe' | 'not_going';
export type RsvpStatus = 'pending' | 'confirmed' | 'waitlisted' | 'declined' | 'cancelled' | 'awaiting_payment';
export type QuestionType = 'short_text' | 'long_text' | 'single_choice' | 'multi_choice' | 'checkbox';
export type AnswerValue = string | string[] | boolean;

export interface RsvpQuestion {
  id: string;
  label: string;
  type: QuestionType;
  options: string[];
  required: boolean;
}

export interface RsvpTicketType {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  /** Seats still on sale for this type (`null` = unlimited). */
  remaining: number | null;
  salesEnded: boolean;
}

/** What the RSVP form needs about one event (`GET /site-api/rsvp/events/:slug`). */
export interface RsvpEventView {
  id: string;
  slug: string;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  status: 'published' | 'cancelled';
  allowMaybe: boolean;
  maxPlusOnes: number;
  approvalRequired: boolean;
  waitlistEnabled: boolean;
  /** `true` once the deadline passed or the event ended. */
  closed: boolean;
  /** Free seats (`null` = unlimited). */
  seatsLeft: number | null;
  /** The host's "Show guest list" switch; when off `attendees` is null. */
  showGuestList?: boolean;
  /** Confirmed going seats (0 unless the guest list is on). */
  goingCount?: number;
  /** First name + initials only, bounded; null unless the guest list is on. */
  attendees?: {name: string; initials: string}[] | null;
  questions: RsvpQuestion[];
  ticketTypes: RsvpTicketType[];
}

export interface RsvpFormInput {
  name: string;
  email: string;
  response: RsvpResponse;
  plusOnes: number;
  answers: Record<string, AnswerValue>;
  marketingConsent: boolean;
  ticketTypeId?: string;
}

/** The rules an event puts on its RSVP form. */
export interface RsvpRules {
  allowMaybe: boolean;
  maxPlusOnes: number;
  questions: ReadonlyArray<RsvpQuestion>;
  ticketTypeIds: ReadonlyArray<string>;
}

export const RSVP_RESPONSES: readonly RsvpResponse[] = ['going', 'maybe', 'not_going'];
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const NAME_MAX = 120;
export const EMAIL_MAX = 254;

/** Result of `result` on `POST /rsvp/events/:slug`. */
export interface RsvpSubmitResult {
  status: RsvpStatus | 'check_email';
  /** Site-relative link to the guest's page, e.g. `/r/<token>/`; absent for `check_email`. */
  managePath?: string;
  waitlistPosition?: number | null;
  /** Paid tickets: where to pay (set by the payments hook); `null` for free tickets. */
  checkoutUrl?: string | null;
  message?: string;
}

/** A guest's own RSVP (`GET /site-api/rsvp/manage/:token`). */
export interface GuestRsvpView {
  event: RsvpEventView & {
    description: string;
    venueName: string | null;
    venueAddress: string | null;
    mapUrl: string | null;
    format: 'in_person' | 'online' | 'hybrid';
    /** Confirmed guests only. */
    joinUrl: string | null;
    pageUrl: string;
  };
  rsvp: {
    name: string;
    email: string;
    response: RsvpResponse;
    status: RsvpStatus;
    plusOnes: number;
    seats: number;
    ticketCode: string | null;
    ticketTypeId: string | null;
    marketingConsent: boolean;
    waitlistPosition: number | null;
    answers: Record<string, AnswerValue>;
    /** `false` once changes are no longer accepted (90 days after the event). */
    canEdit: boolean;
  };
  calendar: {icsPath: string; googleUrl: string};
}

/** `invite` landing (`GET /site-api/rsvp/invite/:token`). */
export interface InviteView {
  event: RsvpEventView & {
    description: string;
    venueName: string | null;
    venueAddress: string | null;
    /** A private event only accepts the invited email, so the invite form shows it read-only. */
    visibility: 'public' | 'unlisted' | 'private';
  };
  invite: {name: string | null; email: string; token: string};
  /** This email already has an RSVP: the page points the guest to their email link. */
  alreadyResponded: boolean;
}

/**
 * 410 from `GET /site-api/rsvp/manage/:token` and `/invite/:token` when the token is valid but the host
 * unpublished or deleted the event: only its title, never guest data. An unknown token is a 404.
 */
export interface EventUnavailable {
  error: 'event_unavailable';
  message: string;
  event: {title: string};
}

export type FieldErrors = Record<string, string>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function answerOk(q: RsvpQuestion, value: AnswerValue): boolean {
  switch (q.type) {
    case 'short_text':
      return typeof value === 'string' && value.length <= 200;
    case 'long_text':
      return typeof value === 'string' && value.length <= 2000;
    case 'checkbox':
      return typeof value === 'boolean';
    case 'single_choice':
      return typeof value === 'string' && (value === '' || q.options.includes(value));
    case 'multi_choice':
      return Array.isArray(value) && value.length <= 20 && value.every(v => typeof v === 'string' && q.options.includes(v));
  }
}

function answerEmpty(value: AnswerValue | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return value === false;
}

/**
 * Validates an RSVP body against the event's rules. Field-by-field output (never the raw body),
 * so nothing unknown reaches the database. `email` is optional when `fixedEmail` is given (the
 * manage form never changes it).
 */
export function validateRsvp(
  raw: unknown,
  rules: RsvpRules,
  options: {fixedEmail?: string} = {}
): {ok: true; value: RsvpFormInput} | {ok: false; fields: FieldErrors} {
  const fields: FieldErrors = {};
  const v = isRecord(raw) ? raw : {};

  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name) fields.name = 'Add your name.';
  // Postgres text and jsonb can't hold NUL: a field error, never a 500.
  else if (hasNul(name)) fields.name = NUL_MESSAGE;
  else if (name.length > NAME_MAX) fields.name = `Use at most ${NAME_MAX} characters.`;

  let email = options.fixedEmail ?? '';
  if (!options.fixedEmail) {
    email = typeof v.email === 'string' ? v.email.trim().toLowerCase() : '';
    if (!email) fields.email = 'Add your email.';
    else if (hasNul(email)) fields.email = NUL_MESSAGE;
    else if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) fields.email = 'Enter a valid email address, like name@example.com.';
  }

  const response = v.response as RsvpResponse;
  if (!RSVP_RESPONSES.includes(response)) fields.response = 'Choose Going or Can’t go.';
  else if (response === 'maybe' && !rules.allowMaybe) fields.response = 'This event takes Going or Can’t go only.';

  const plusRaw = v.plusOnes === undefined || v.plusOnes === '' ? 0 : Number(v.plusOnes);
  const plusOnes = Number.isInteger(plusRaw) ? plusRaw : -1;
  if (plusOnes < 0) fields.plusOnes = 'Use a whole number, 0 or more.';
  else if (plusOnes > rules.maxPlusOnes) {
    fields.plusOnes =
      rules.maxPlusOnes === 0
        ? 'This event does not allow plus-ones.'
        : `You can bring up to ${rules.maxPlusOnes} ${rules.maxPlusOnes === 1 ? 'guest' : 'guests'}.`;
  }

  let ticketTypeId: string | undefined;
  if (v.ticketTypeId !== undefined && v.ticketTypeId !== null && v.ticketTypeId !== '') {
    if (!isUuid(v.ticketTypeId) || !rules.ticketTypeIds.includes(v.ticketTypeId)) {
      fields.ticketTypeId = 'Choose one of the listed tickets.';
    } else ticketTypeId = v.ticketTypeId;
  }

  const answers: Record<string, AnswerValue> = {};
  const rawAnswers = isRecord(v.answers) ? v.answers : {};
  const known = new Map(rules.questions.map(q => [q.id, q]));
  for (const [id, value] of Object.entries(rawAnswers)) {
    const q = known.get(id);
    if (!q) {
      fields[`answers.${id}`] = 'Unknown question.';
      continue;
    }
    if (!(typeof value === 'string' || typeof value === 'boolean' || Array.isArray(value)) || !answerOk(q, value as AnswerValue)) {
      fields[`answers.${id}`] = 'Choose one of the listed options.';
      continue;
    }
    if (typeof value === 'string' ? hasNul(value) : Array.isArray(value) && value.some(x => typeof x === 'string' && hasNul(x))) {
      fields[`answers.${id}`] = NUL_MESSAGE;
      continue;
    }
    answers[id] = value as AnswerValue;
  }
  for (const q of rules.questions) {
    // A decline only needs name and email.
    if (q.required && response !== 'not_going' && answerEmpty(answers[q.id]) && !fields[`answers.${q.id}`]) {
      fields[`answers.${q.id}`] = 'This question needs an answer.';
    }
  }

  if (Object.keys(fields).length > 0) return {ok: false, fields};
  return {
    ok: true,
    value: {
      name,
      email,
      response,
      plusOnes,
      answers,
      marketingConsent: v.marketingConsent === true,
      ...(ticketTypeId ? {ticketTypeId} : {}),
    },
  };
}

/** Plain-words copy for the 409 reasons the route answers (`error` code → message). */
export const RSVP_CONFLICTS: Record<string, string> = {
  rsvps_closed: 'RSVPs for this event have closed.',
  event_full: 'This event is full.',
  event_cancelled: 'This event was cancelled.',
  ticket_sales_ended: 'Sales for that ticket have ended.',
  ticket_sold_out: 'That ticket is sold out.',
  payments_unavailable: 'Paid tickets cannot be bought on this site yet. Try again later.',
  paid_ticket_change: 'A paid ticket cannot be changed here. Cancel it and book again.',
  checkout_in_progress: 'A payment is in progress for this RSVP. Finish or cancel it first.',
};
