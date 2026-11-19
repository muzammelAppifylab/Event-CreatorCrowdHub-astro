import {Hono, type Context} from 'hono';
import {validator} from 'hono/validator';

import {buildIcs, googleCalendarUrl, icsUid} from '../../domain/ics';
import {decideSeat, seatsFor, seatsRemaining, type SeatDecision} from '../../domain/capacity';
import {ticketCode, withUniqueRetry} from '../../domain/codes';
import {hashToken, newToken} from '../../domain/secureToken';
import {formatInZone} from '../../domain/time';
import {nextWaitlistPosition, type WaitlistEntry} from '../../domain/waitlist';
import {confirmationEmail, manageLinkEmail} from '../../emails';
import type {EmailContent, EmailData} from '../../emails/types';
import type {Prisma} from '../../generated/prisma/client';
import {
  type AnswerValue,
  type EventUnavailable,
  type FieldErrors,
  type GuestRsvpView,
  type InviteView,
  type RsvpEventView,
  type RsvpFormInput,
  type RsvpQuestion,
  type RsvpResponse,
  type RsvpRules,
  type RsvpStatus,
  type RsvpSubmitResult,
  RSVP_CONFLICTS,
  validateRsvp,
} from '../../lib/rsvp-types';
import {background} from '../../platform/auth/kit';
import {config} from '../../platform/config';
import type {PrismaClient} from '../../platform/db';
import {problem, withDb} from '../../platform/guards';
import {sendClaimEmail} from '../claim-mail';
import {sendConsentEmail} from '../consent-mail';
import {canSendEventEmail, sendEventEmail} from '../mailer';
import {confirmationRuleFor} from '../jobs/guest-emails';
// Locks the event row for the transaction (`SELECT … FOR UPDATE`), so seat counts and writes are atomic per event.
import {lockEvent} from '../jobs/shared';
import {MAX_PUBLIC_ATTENDEES, shapeAttendees} from '../../lib/guest-list';
import {notFound} from '../validate';
import {promoteWaitlist} from '../waitlist-promote';
import {emitPromoted, emitWebhook, rsvpPayload} from '../webhook-emit';

/**
 * Guest RSVP flows, mounted at `/site-api/rsvp` (ported from CreatorCrowdHub `routes/public.ts` +
 * `rsvp/rsvp-service.ts`). Public: guests prove access with a random MANAGE token (stored only as
 * its sha256, so a database leak gives away no working link) or an invite token. A bad token is
 * always the same 404.
 *
 *   GET   /events/:slug?invite=        the RSVP form's rules, tickets, seats left
 *   POST  /events/:slug                submit: ALWAYS 202 `check_email` for a new or an existing email (no
 *                                      existence oracle); the manage link is emailed; a paid ticket adds `checkoutUrl`
 *                                      (`setPaidCheckoutHook`). Residual: a full/closed event still answers 409 to a
 *                                      NEW email only (the repeat check runs first).
 *   POST  /events/:slug/manage-link    "lost my link": always 202, emails a fresh link
 *   GET   /invite/:token               invite landing (private events included)
 *   GET   /manage/:token               the guest's RSVP (confirmation + manage page)
 *   PATCH /manage/:token               change it
 *   POST  /manage/:token/cancel        cancel it
 *   GET   /manage/:token/calendar.ics  calendar file
 *
 * Every write runs in ONE transaction that first locks the event row (`SELECT … FOR UPDATE`), so two
 * last-seat RSVPs can never both confirm; waitlist promotion runs in the same transaction.
 * Emails go out after commit, in the background: a failed email never undoes a seat.
 *
 * Index: rsvps(event_id, status), unique (event_id, email), unique manage_token / ticket_code.
 * Rate limits are per Worker isolate (best effort): `AttemptKind` in the managed platform/auth/rate-limit.ts is
 * a closed union with no RSVP kind, so the DB-backed limiter can't be used without editing managed files.
 * Manage-link requests rotate the token (only a hash is stored, so the old link cannot be re-sent); capped at 3
 * per (event, email) per hour. See docs/porting/SECURITY-AUDIT.md "Follow-ups".
 */

// ---------------------------------------------------------------- paid-ticket hook (payments agent)

export interface PaidCheckoutContext {
  origin: string;
  event: {id: string; slug: string; title: string};
  rsvp: {id: string; name: string; email: string; seats: number; ticketTypeId: string};
  ticket: {id: string; name: string; priceCents: number; currency: string};
  /** The raw manage token, for the checkout's success / cancel URLs (`/r/<token>/`). */
  manageToken: string;
}

/** Returns where the guest pays, or `null` when checkout could not start (the seat hold is then released). */
export type PaidCheckoutHook = (ctx: PaidCheckoutContext) => Promise<{checkoutUrl: string} | null>;

let paidCheckout: PaidCheckoutHook | null = null;

/**
 * Payments plug in here: register once at module load. While no hook is set, a paid ticket answers
 * 409 `payments_unavailable` and holds nothing. The seat is held as `awaiting_payment` while the hook
 * runs; call `confirmRsvpPayment` when the payment lands and `releaseRsvpHold` when it expires.
 */
export function setPaidCheckoutHook(hook: PaidCheckoutHook | null) {
  paidCheckout = hook;
}

// ---------------------------------------------------------------- small helpers

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
const HELD: RsvpStatus[] = ['confirmed', 'awaiting_payment'];
const DAY_MS = 86_400_000;
/** Changes stop 90 days after the event ends, every use (view, .ics) after 180. */
export const MANAGE_WRITE_DAYS = 90;
export const MANAGE_READ_DAYS = 180;

export class RsvpError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly fields?: FieldErrors
  ) {
    super(message);
  }
}
const conflict = (reason: string) => new RsvpError(409, reason, RSVP_CONFLICTS[reason] ?? 'That cannot be done right now.');

const SLUG_RE = /^[\w-]{1,120}$/;
const TOKEN_RE = /^[\w-]{32,128}$/;
const INVITE_RE = /^[\w.-]{8,600}$/; // signed invite tokens are `<base64url>.<base64url>`

export const holdsSeat = (response: string, status: string) => response === 'going' && HELD.includes(status as RsvpStatus);

export function manageTokenAllows(endAt: Date, access: 'read' | 'write', now: Date): boolean {
  return now.getTime() < endAt.getTime() + (access === 'write' ? MANAGE_WRITE_DAYS : MANAGE_READ_DAYS) * DAY_MS;
}

/** Sliding-window limiter, per isolate. */
const hits = new Map<string, number[]>();
function hit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter(t => t > now - windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every(t => t <= now - windowMs)) hits.delete(k);
  return true;
}
const clientIp = (c: Context) => c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
const RSVP_LIMIT = {limit: 10, windowMs: 60_000};
/** Confirmation + manage-link emails per (event, email) per hour: no email bombing. */
const EMAIL_CAP = {limit: 3, windowMs: 3_600_000};

const originOf = (c: Context) => config.siteUrl ?? new URL(c.req.url).origin;

// ---------------------------------------------------------------- loading

const eventSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  startAt: true,
  endAt: true,
  timezone: true,
  format: true,
  venueName: true,
  venueAddress: true,
  mapUrl: true,
  joinUrl: true,
  visibility: true,
  status: true,
  capacity: true,
  rsvpDeadline: true,
  waitlistEnabled: true,
  approvalRequired: true,
  allowMaybe: true,
  maxPlusOnes: true,
  thankYouLink: true,
  showGuestList: true,
  rsvpQuestions: {select: {id: true, label: true, type: true, options: true, required: true}, orderBy: [{sortOrder: 'asc'}, {id: 'asc'}]},
  ticketTypes: {select: {id: true, name: true, priceCents: true, currency: true, quantity: true, salesEndAt: true}, orderBy: [{sortOrder: 'asc'}, {id: 'asc'}]},
} satisfies Prisma.EventSelect;

type EventRow = Prisma.EventGetPayload<{select: typeof eventSelect}>;

const rsvpSelect = {
  id: true,
  eventId: true,
  ticketTypeId: true,
  name: true,
  email: true,
  response: true,
  status: true,
  plusOnes: true,
  seats: true,
  ticketCode: true,
  marketingConsent: true,
  // Read so a reverted edit can put consent back exactly (never sent to the browser).
  consentConfirmedAt: true,
  waitlistPosition: true,
  claimExpiresAt: true,
  confirmedAt: true,
  createdAt: true,
} satisfies Prisma.RsvpSelect;

type RsvpRow = Prisma.RsvpGetPayload<{select: typeof rsvpSelect}>;

const questionsOf = (event: EventRow): RsvpQuestion[] =>
  event.rsvpQuestions.map(q => ({
    id: q.id,
    label: q.label,
    type: q.type,
    options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string') : [],
    required: q.required,
  }));

const rulesOf = (event: EventRow): RsvpRules => ({
  allowMaybe: event.allowMaybe,
  maxPlusOnes: event.maxPlusOnes,
  questions: questionsOf(event),
  ticketTypeIds: event.ticketTypes.map(t => t.id),
});

/** Published or cancelled, not deleted; drafts do not exist for guests. */
const findEvent = (db: PrismaClient | Tx, where: Prisma.EventWhereInput) =>
  db.event.findFirst({select: eventSelect, where: {...where, deletedAt: null, status: {in: ['published', 'cancelled']}}});

/** The invite for this event when `token` is live: exists, not bounced, event not over. */
async function liveInvite(db: PrismaClient | Tx, event: Pick<EventRow, 'id' | 'endAt'>, token: unknown, now: Date) {
  if (typeof token !== 'string' || !INVITE_RE.test(token) || now >= event.endAt) return null;
  const invite = await db.invite.findUnique({
    where: {token},
    select: {id: true, eventId: true, email: true, name: true, status: true, token: true},
  });
  return invite && invite.eventId === event.id && invite.status !== 'bounced' ? invite : null;
}

/**
 * The rows whose seats are taken: confirmed or paying, plus seats under an open paid-waitlist claim
 * (offered to someone else, so not free; audit M-10, as `ticket-checkout.ts` counts them). ONE rule
 * for the booking check (`seatsTakenExcept`) and the public "seats left" (`seatCounts`), so they match.
 */
export const seatsTakenWhere = (eventId: string, now: Date) =>
  ({
    eventId,
    response: 'going',
    OR: [{status: {in: HELD}}, {status: 'waitlisted', claimExpiresAt: {gt: now}}],
  }) satisfies Prisma.RsvpWhereInput;

/** Seats taken (`seatsTakenWhere`), grouped by ticket type, in one query. */
async function seatCounts(db: PrismaClient | Tx, eventId: string, now: Date) {
  const rows = await db.rsvp.groupBy({
    by: ['ticketTypeId'],
    where: seatsTakenWhere(eventId, now),
    _sum: {seats: true},
  });
  const byTicket = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const n = r._sum.seats ?? 0;
    total += n;
    if (r.ticketTypeId) byTicket.set(r.ticketTypeId, n);
  }
  return {total, byTicket};
}

async function buildView(db: PrismaClient | Tx, event: EventRow, now: Date): Promise<RsvpEventView> {
  // Public guest list: only when the host switched it on; first names of confirmed, going guests (explicit select, bounded).
  // Independent reads go together.
  const where = {eventId: event.id, response: 'going', status: 'confirmed'} as const;
  const [counts, guestList] = await Promise.all([
    seatCounts(db, event.id, now),
    event.showGuestList
      ? Promise.all([
          db.rsvp.findMany({where, orderBy: [{confirmedAt: 'asc'}, {createdAt: 'asc'}], take: MAX_PUBLIC_ATTENDEES, select: {name: true}}),
          db.rsvp.aggregate({where, _sum: {seats: true}}),
        ])
      : null,
  ]);
  const left = seatsRemaining(event.capacity, counts.total);
  const attendees: {name: string; initials: string}[] | null = guestList ? shapeAttendees(guestList[0].map(r => r.name)) : null;
  const goingCount = guestList ? (guestList[1]._sum.seats ?? 0) : 0;
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt.toISOString(),
    timezone: event.timezone,
    status: event.status === 'cancelled' ? 'cancelled' : 'published',
    allowMaybe: event.allowMaybe,
    maxPlusOnes: event.maxPlusOnes,
    approvalRequired: event.approvalRequired,
    waitlistEnabled: event.waitlistEnabled,
    closed: now >= event.endAt || (event.rsvpDeadline !== null && now > event.rsvpDeadline),
    seatsLeft: Number.isFinite(left) ? left : null,
    showGuestList: event.showGuestList,
    goingCount,
    attendees,
    questions: questionsOf(event),
    ticketTypes: event.ticketTypes.map(t => ({
      id: t.id,
      name: t.name,
      priceCents: t.priceCents,
      currency: t.currency,
      remaining: t.quantity === null ? null : Math.max(0, t.quantity - (counts.byTicket.get(t.id) ?? 0)),
      salesEnded: t.salesEndAt !== null && now > t.salesEndAt,
    })),
  };
}

// ---------------------------------------------------------------- placement (pure)

export interface Placement {
  status: RsvpStatus;
  waitlistPosition: number | null;
  confirmedAt: Date | null;
  claimExpiresAt: Date | null;
}

export interface CurrentRsvp {
  id: string;
  response: string;
  status: string;
  seats: number;
  ticketTypeId: string | null;
  waitlistPosition: number | null;
  confirmedAt: Date | null;
  claimExpiresAt: Date | null;
}

export interface PlaceInput {
  event: Pick<EventRow, 'status' | 'endAt' | 'capacity' | 'rsvpDeadline' | 'waitlistEnabled' | 'approvalRequired'>;
  current: CurrentRsvp | null;
  response: RsvpResponse;
  plusOnes: number;
  ticket: {id: string; priceCents: number; quantity: number | null; salesEndAt: Date | null} | null;
  /** Any ticket of the event costs money: a guest must pick one. */
  anyPaidTicket: boolean;
  /** Seats held by OTHER guests. */
  seatsTaken: number;
  /** Seats of this ticket type held by OTHER guests. */
  ticketSeatsTaken: number;
  waitlist: WaitlistEntry[];
  paymentsEnabled: boolean;
  now: Date;
}

const pick = (r: CurrentRsvp): Placement => ({
  status: r.status as RsvpStatus,
  waitlistPosition: r.waitlistPosition,
  confirmedAt: r.confirmedAt,
  claimExpiresAt: r.claimExpiresAt,
});
const AWAITING: Placement = {status: 'awaiting_payment', waitlistPosition: null, confirmedAt: null, claimExpiresAt: null};

/** Where a guest lands for this input (US-3, 4, 5, 8). Throws `RsvpError` instead of downgrading anyone. */
export function place(i: PlaceInput): Placement {
  const {event, current, now, ticket} = i;
  if (event.status === 'cancelled') throw conflict('event_cancelled');
  if (i.response === 'not_going') return {status: 'declined', waitlistPosition: null, confirmedAt: null, claimExpiresAt: null};
  if (now >= event.endAt || (event.rsvpDeadline !== null && now > event.rsvpDeadline)) throw conflict('rsvps_closed');

  if (i.response === 'maybe') {
    // Maybe holds no seat but is confirmed, so it still gets reminders.
    const confirmedAt = current?.status === 'confirmed' ? current.confirmedAt : now;
    return {status: 'confirmed', waitlistPosition: null, confirmedAt, claimExpiresAt: null};
  }

  const holder = current !== null && holdsSeat(current.response, current.status);
  const seats = seatsFor(i.plusOnes);
  const paid = !!ticket && ticket.priceCents > 0;

  // A Checkout Session is open for exactly these seats and this ticket: no changes mid-checkout.
  if (current?.status === 'awaiting_payment' && current.response === 'going') {
    if ((ticket?.id ?? null) !== current.ticketTypeId || seats !== current.seats) throw conflict('checkout_in_progress');
  }
  if (!ticket && !holder && i.anyPaidTicket) {
    throw new RsvpError(422, 'validation_failed', 'Some fields need attention.', {ticketTypeId: 'Choose a ticket.'});
  }
  if (ticket) {
    // A guest keeping the seats they already hold on the same type is never turned away by its limits.
    const keeps = holder && current?.ticketTypeId === ticket.id;
    if (!(keeps && seats <= current!.seats)) {
      if (!keeps && ticket.salesEndAt && now > ticket.salesEndAt) throw conflict('ticket_sales_ended');
      if (ticket.quantity !== null && i.ticketSeatsTaken + seats > ticket.quantity) throw conflict('ticket_sold_out');
    }
  }
  const settled = holder && current?.status === 'confirmed' ? current : null;
  if (settled) {
    const changes = settled.ticketTypeId !== (ticket?.id ?? null) || seats !== settled.seats;
    if (changes && paid) throw conflict('paid_ticket_change');
  } else if (paid && !i.paymentsEnabled && current?.status !== 'waitlisted') {
    throw conflict('payments_unavailable');
  }

  // Approval is per guest, not per edit: an approved guest is not sent back to pending.
  const approved = holder || current?.status === 'waitlisted';
  const decision: SeatDecision = decideSeat(
    {
      capacity: event.capacity,
      seatsTaken: i.seatsTaken,
      waitlistEnabled: event.waitlistEnabled,
      approvalRequired: event.approvalRequired && !approved,
      rsvpDeadline: event.rsvpDeadline,
      now,
    },
    seats
  );
  // A confirmed guest asking for more seats than fit keeps the seats they have (US-8).
  if (holder && decision.kind !== 'confirm') throw conflict('event_full');
  if (current?.status === 'pending' && decision.kind === 'pending') return pick(current);

  let placement: Placement;
  switch (decision.kind) {
    case 'confirm':
      placement =
        current && holder
          ? pick(current)
          : {status: 'confirmed', waitlistPosition: null, confirmedAt: current?.status === 'confirmed' ? current.confirmedAt : now, claimExpiresAt: null};
      break;
    case 'pending':
      placement = {status: 'pending', waitlistPosition: null, confirmedAt: null, claimExpiresAt: null};
      break;
    case 'waitlist':
      placement =
        current?.status === 'waitlisted'
          ? pick(current)
          : {status: 'waitlisted', waitlistPosition: nextWaitlistPosition(i.waitlist), confirmedAt: null, claimExpiresAt: null};
      break;
    case 'reject':
      throw conflict(decision.reason === 'closed' ? 'rsvps_closed' : 'event_full');
  }
  // A seat on a paid ticket is not confirmed until the payment lands.
  // Keyed on HOLDING a settled seat, not on `status`: a Maybe is `confirmed` without a seat or a payment,
  // so Maybe -> Going on a paid ticket must pay like a fresh RSVP (audit H1).
  if (paid && placement.status === 'confirmed' && !(holder && current?.status === 'confirmed')) {
    // A waitlisted guest skipped the up-front check (a name edit must work); starting checkout still needs payments.
    if (!i.paymentsEnabled) throw conflict('payments_unavailable');
    return AWAITING;
  }
  return placement;
}

// ---------------------------------------------------------------- transactional writes

interface Changed {
  rsvp: RsvpRow;
  /** A paid-waitlist claim offer (`sendClaimEmail` issues the claim link). */
  claim?: boolean;
  /** A free-event promotion: confirmed from the waitlist (its confirmation carries a fresh manage link). */
  promoted?: boolean;
}

/**
 * Seats taken (`seatsTakenWhere`) by guests other than `exceptId`. `ticketTypeId` narrows it to one
 * ticket type (its quantity limit).
 */
async function seatsTakenExcept(tx: Tx, eventId: string, now: Date, exceptId?: string, ticketTypeId?: string) {
  const sum = await tx.rsvp.aggregate({
    _sum: {seats: true},
    where: {
      ...seatsTakenWhere(eventId, now),
      ...(exceptId ? {id: {not: exceptId}} : {}),
      ...(ticketTypeId ? {ticketTypeId} : {}),
    },
  });
  return sum._sum.seats ?? 0;
}

async function loadPlaceInput(
  tx: Tx,
  event: EventRow,
  current: CurrentRsvp | null,
  input: Pick<RsvpFormInput, 'response' | 'plusOnes' | 'ticketTypeId'>,
  now: Date
): Promise<PlaceInput> {
  // An edit keeps the ticket the guest has (the manage form can omit it).
  const ticketId = input.ticketTypeId ?? current?.ticketTypeId ?? null;
  const ticket = event.ticketTypes.find(t => t.id === ticketId) ?? null;
  // Independent reads, together (all under the event lock taken by the caller).
  const [ticketSeatsTaken, seatsTaken, waitlist] = await Promise.all([
    ticket ? seatsTakenExcept(tx, event.id, now, current?.id, ticket.id) : Promise.resolve(0),
    seatsTakenExcept(tx, event.id, now, current?.id),
    // Only the back of the line is needed (a new guest joins after it): one row, not the whole waitlist,
    // so the next position is right however long the line is.
    tx.rsvp.findMany({
      select: {id: true, seats: true, waitlistPosition: true, createdAt: true, claimExpiresAt: true},
      where: {eventId: event.id, status: 'waitlisted', response: 'going', waitlistPosition: {not: null}},
      orderBy: [{waitlistPosition: 'desc'}],
      take: 1,
    }),
  ]);
  return {
    event,
    current,
    response: input.response,
    plusOnes: input.plusOnes,
    ticket,
    anyPaidTicket: event.ticketTypes.some(t => t.priceCents > 0),
    seatsTaken,
    ticketSeatsTaken,
    waitlist,
    paymentsEnabled: paidCheckout !== null,
    now,
  };
}

async function replaceAnswers(tx: Tx, rsvpId: string, answers: Record<string, AnswerValue>) {
  await tx.rsvpAnswer.deleteMany({where: {rsvpId}});
  const rows = Object.entries(answers)
    .filter(([, v]) => !(v === '' || v === false || (Array.isArray(v) && v.length === 0)))
    .map(([questionId, value]) => ({rsvpId, questionId, value}));
  if (rows.length > 0) await tx.rsvpAnswer.createMany({data: rows});
}

/**
 * Fills freed seats from the waitlist (US-4) and closes position gaps: the shared, set-based
 * `promoteWaitlist` (src/server/waitlist-promote.ts), which also respects each ticket type's
 * quantity. Runs after every write and is a no-op when nothing changed. Free events confirm (the
 * guest's link is re-issued only when the confirmation email actually goes out: `sendPromotions`);
 * paid events offer a claim instead (`claimExpiresAt`, emailed by `sendClaimEmail`).
 */
async function promote(tx: Tx, event: EventRow, now: Date): Promise<Changed[]> {
  if (event.status !== 'published' || now >= event.endAt) return [];
  const {promotions} = await promoteWaitlist(tx, event, now);
  if (promotions.length === 0) return [];
  const rows = await tx.rsvp.findMany({where: {id: {in: promotions.map(p => p.rsvpId)}, eventId: event.id}, select: rsvpSelect});
  const byId = new Map(rows.map(r => [r.id, r]));
  return promotions.flatMap(p => {
    const rsvp = byId.get(p.rsvpId);
    return rsvp ? [{rsvp, claim: p.kind === 'offer_claim', promoted: p.kind === 'confirm'}] : [];
  });
}

type InviteStatus = Prisma.InviteGetPayload<{select: {status: true}}>['status'];

type Submitted =
  /** `inviteStatus`: the linked invite's status before this RSVP marked it `responded` (null: no invite). */
  | {created: true; rsvp: RsvpRow; token: string; promoted: Changed[]; inviteStatus: InviteStatus | null}
  | {created: false; rsvp: RsvpRow};

/**
 * The status an invite goes back to when its new RSVP is discarded (audit M-1): what it was before
 * the RSVP, else `sent` when it was sent, else `queued`. Never `responded`: no RSVP is left.
 */
export function inviteStatusAfterDiscard(previous: InviteStatus | null | undefined, sentAt: Date | null): InviteStatus {
  if (previous && previous !== 'responded') return previous;
  return sentAt ? 'sent' : 'queued';
}

async function submitRsvp(
  db: PrismaClient,
  eventId: string,
  input: RsvpFormInput,
  inviteId: string | null,
  source: {utm: string | null},
  now: Date
): Promise<Submitted> {
  return db.$transaction(async tx => {
    await lockEvent(tx, eventId);
    const event = await findEvent(tx, {id: eventId});
    if (!event) throw new RsvpError(404, 'not_found', 'No such event.');
    // Knowing an email must not let anyone overwrite (or read) that guest's RSVP: it only emails them a link.
    const existing = await tx.rsvp.findUnique({where: {eventId_email: {eventId, email: input.email}}, select: rsvpSelect});
    if (existing) return {created: false, rsvp: existing};

    const placement = place(await loadPlaceInput(tx, event, null, input, now));
    const token = newToken();
    const code = await withUniqueRetry(ticketCode, async c => (await tx.rsvp.findUnique({where: {ticketCode: c}, select: {id: true}})) !== null);
    const rsvp = await tx.rsvp.create({
      data: {
        eventId,
        inviteId,
        ticketTypeId: input.response === 'maybe' ? null : (input.ticketTypeId ?? null),
        name: input.name,
        email: input.email,
        response: input.response,
        plusOnes: input.plusOnes,
        seats: seatsFor(input.plusOnes),
        ticketCode: code,
        manageToken: hashToken(token),
        marketingConsent: input.marketingConsent,
        source: inviteId ? 'invite' : 'direct',
        utmSource: source.utm,
        ...placement,
      },
      select: rsvpSelect,
    });
    await replaceAnswers(tx, rsvp.id, input.answers);
    let inviteStatus: InviteStatus | null = null;
    if (inviteId) {
      // Kept so a discarded RSVP (checkout could not start) can put the invite back (audit M-1).
      inviteStatus = (await tx.invite.findUnique({where: {id: inviteId}, select: {status: true}}))?.status ?? null;
      await tx.invite.update({where: {id: inviteId}, data: {status: 'responded'}, select: {id: true}});
    }
    return {created: true, rsvp, token, promoted: await promote(tx, event, now), inviteStatus};
  });
}

async function updateRsvp(db: PrismaClient, rsvpId: string, input: RsvpFormInput, now: Date) {
  return db.$transaction(async tx => {
    const found = await tx.rsvp.findUnique({where: {id: rsvpId}, select: {eventId: true}});
    if (!found) throw new RsvpError(404, 'not_found', 'RSVP not found.');
    await lockEvent(tx, found.eventId);
    const event = await findEvent(tx, {id: found.eventId});
    const current = await tx.rsvp.findUnique({where: {id: rsvpId}, select: rsvpSelect});
    if (!event || !current) throw new RsvpError(404, 'not_found', 'RSVP not found.');
    const placement = place(await loadPlaceInput(tx, event, current, input, now));
    const rsvp = await tx.rsvp.update({
      where: {id: rsvpId},
      data: {
        name: input.name,
        response: input.response,
        plusOnes: input.plusOnes,
        seats: seatsFor(input.plusOnes),
        marketingConsent: input.marketingConsent,
        // Unticking withdraws consent: its confirmation goes too, so ticking again needs a new one (audit L-41).
        ...(input.marketingConsent ? {} : {consentConfirmedAt: null}),
        // A Maybe holds no seat and implies no ticket: it is dropped, so Going must choose (and pay for) one.
        ticketTypeId: input.response === 'maybe' ? null : (input.ticketTypeId ?? current.ticketTypeId),
        ...placement,
      },
      select: rsvpSelect,
    });
    await replaceAnswers(tx, rsvpId, input.answers);
    return {rsvp, previous: current, promoted: await promote(tx, event, now)};
  });
}

/** Shared by cancel, payment confirmation and hold release: one status change, then promotion. */
async function transition(
  db: PrismaClient,
  rsvpId: string,
  apply: (current: RsvpRow, event: EventRow, now: Date) => Prisma.RsvpUncheckedUpdateInput | null
) {
  const now = new Date();
  return db.$transaction(async tx => {
    const found = await tx.rsvp.findUnique({where: {id: rsvpId}, select: {eventId: true}});
    if (!found) throw new RsvpError(404, 'not_found', 'RSVP not found.');
    await lockEvent(tx, found.eventId);
    const event = await findEvent(tx, {id: found.eventId});
    const current = await tx.rsvp.findUnique({where: {id: rsvpId}, select: rsvpSelect});
    if (!event || !current) throw new RsvpError(404, 'not_found', 'RSVP not found.');
    const data = apply(current, event, now);
    const rsvp = data ? await tx.rsvp.update({where: {id: rsvpId}, data, select: rsvpSelect}) : current;
    return {rsvp, event, previous: current, promoted: await promote(tx, event, now)};
  });
}

/**
 * HOOK for payments: the payment landed, `awaiting_payment` → `confirmed`. Idempotent. `seated` is
 * false when it can no longer buy a seat (the hold lapsed and the event filled, the guest switched to
 * Maybe, or the event was cancelled): the caller refunds. Sends the confirmation email.
 */
export async function confirmRsvpPayment(
  db: PrismaClient,
  rsvpId: string,
  origin: string,
  /** The guest's raw manage token when the caller has it (the checkout's success URL); else a new link is issued. */
  manageToken?: string
): Promise<{seated: boolean}> {
  let seated = true;
  const out = await transition(db, rsvpId, (current, event, now) => {
    if (current.status === 'confirmed' && current.response === 'going') return null;
    if (event.status === 'cancelled' || current.response !== 'going' || current.status !== 'awaiting_payment') {
      seated = false;
      return null;
    }
    return {status: 'confirmed', confirmedAt: now, waitlistPosition: null, claimExpiresAt: null};
  });
  if (seated && out.previous.status === 'awaiting_payment') {
    // Without the guest's own token a new link is issued, but only if the email carrying it goes out.
    if (manageToken) await sendConfirmation(db, origin, out.event, out.rsvp, manageToken);
    else await sendConfirmationWithFreshLink(db, origin, out.event, out.rsvp);
  }
  await sendPromotions(db, origin, out.event, out.promoted);
  return {seated};
}

/** A payment could not start for an EDIT: put the RSVP back exactly as it was (a Maybe stays a Maybe). */
async function revertEdit(db: PrismaClient, previous: RsvpRow, origin: string): Promise<void> {
  const out = await transition(db, previous.id, current =>
    current.status === 'awaiting_payment'
      ? {
          response: previous.response,
          status: previous.status,
          plusOnes: previous.plusOnes,
          seats: previous.seats,
          ticketTypeId: previous.ticketTypeId,
          waitlistPosition: previous.waitlistPosition,
          confirmedAt: previous.confirmedAt,
          claimExpiresAt: previous.claimExpiresAt,
          // The whole edit is undone, consent included (and no consent email goes out for it).
          marketingConsent: previous.marketingConsent,
          consentConfirmedAt: previous.consentConfirmedAt,
        }
      : null
  );
  await sendPromotions(db, origin, out.event, out.promoted);
}

/** Runs the paid-checkout hook for an `awaiting_payment` RSVP; `null` when checkout could not start. */
async function startPayment(origin: string, event: EventRow, rsvp: RsvpRow, token: string): Promise<string | null> {
  const ticket = event.ticketTypes.find(t => t.id === rsvp.ticketTypeId);
  if (!paidCheckout || !ticket || !rsvp.ticketTypeId) return null;
  const started = await paidCheckout({
    origin,
    event: {id: event.id, slug: event.slug, title: event.title},
    rsvp: {id: rsvp.id, name: rsvp.name, email: rsvp.email, seats: rsvp.seats, ticketTypeId: rsvp.ticketTypeId},
    ticket: {id: ticket.id, name: ticket.name, priceCents: ticket.priceCents, currency: ticket.currency},
    manageToken: token,
  }).catch(() => null);
  return started?.checkoutUrl ?? null;
}

/** HOOK for payments: checkout expired or abandoned; the held seats go back to the waitlist. */
export async function releaseRsvpHold(db: PrismaClient, rsvpId: string, origin: string): Promise<void> {
  const out = await transition(db, rsvpId, current =>
    current.status === 'awaiting_payment' ? {status: 'cancelled', waitlistPosition: null, claimExpiresAt: null, confirmedAt: null} : null
  );
  await sendPromotions(db, origin, out.event, out.promoted);
}

/**
 * Checkout could not start for a NEW RSVP: delete the row (the guest never had a seat or a page to
 * show for it), so the same email can simply RSVP again (audit M-1). A row that already has an order
 * is payment history: it is only released, like an expired hold.
 */
async function discardNewRsvp(db: PrismaClient, rsvpId: string, origin: string, inviteStatus: InviteStatus | null): Promise<void> {
  const now = new Date();
  const out = await db.$transaction(async tx => {
    const found = await tx.rsvp.findUnique({where: {id: rsvpId}, select: {eventId: true, invite: {select: {id: true, sentAt: true}}}});
    if (!found) return null;
    await lockEvent(tx, found.eventId);
    const gone = await tx.rsvp.deleteMany({where: {id: rsvpId, status: 'awaiting_payment', ticketOrders: {none: {}}, pollVotes: {none: {}}}});
    if (gone.count === 0) return 'release' as const;
    // The invite said `responded` for this RSVP: with the RSVP gone, put it back (still only if it says so).
    if (found.invite) {
      await tx.invite.updateMany({
        where: {id: found.invite.id, status: 'responded'},
        data: {status: inviteStatusAfterDiscard(inviteStatus, found.invite.sentAt)},
      });
    }
    const event = await findEvent(tx, {id: found.eventId});
    return event ? {event, promoted: await promote(tx, event, now)} : null;
  });
  if (out === 'release') return releaseRsvpHold(db, rsvpId, origin);
  if (out) await sendPromotions(db, origin, out.event, out.promoted);
}

// ---------------------------------------------------------------- email

/**
 * The event's link for this guest: its public page, or for a PRIVATE event (whose page answers 404
 * without an invite) the guest's own manage page, which shows the event (audit L-1).
 */
const eventLink = (origin: string, event: Pick<EventRow, 'slug' | 'visibility'>, token: string) =>
  event.visibility === 'private' ? `${origin}/r/${token}/` : `${origin}/events/${event.slug}/`;

async function emailDataFor(db: PrismaClient, origin: string, event: EventRow, rsvp: RsvpRow, token: string): Promise<EmailData> {
  const settings = await db.eventSettings.findUnique({where: {id: 1}, select: {senderName: true, replyToEmail: true, brandColor: true}});
  const now = new Date();
  let startLocal: string;
  try {
    startLocal = formatInZone(event.startAt, event.timezone);
  } catch {
    startLocal = event.startAt.toISOString();
  }
  return {
    now,
    brand: {
      senderName: settings?.senderName || 'Events',
      replyToEmail: settings?.replyToEmail || null,
      brandColor: settings?.brandColor ?? null,
    },
    event: {
      title: event.title,
      startAt: event.startAt,
      endAt: event.endAt,
      timezone: event.timezone,
      startLocal,
      format: event.format,
      venueName: event.venueName,
      venueAddress: event.venueAddress,
      mapUrl: event.mapUrl,
      joinUrl: event.joinUrl,
      pageUrl: eventLink(origin, event, token),
      pollUrl: null,
      thankYouLink: event.thankYouLink,
    },
    guest: {
      rsvpId: rsvp.id,
      name: rsvp.name,
      response: rsvp.response,
      status: rsvp.status,
      // Only a confirmed Going guest holds a ticket: a Maybe, waitlisted or unpaid guest gets none.
      ticketCode: rsvp.response === 'going' && rsvp.status === 'confirmed' ? rsvp.ticketCode : null,
      manageUrl: `${origin}/r/${token}/`,
      waitlistPosition: rsvp.waitlistPosition,
      consentUrl: null,
    },
  };
}

type GuestEmailKind = 'confirmation' | 'manage-link';

/**
 * The provider's idempotency key for one inline guest email: the same (kind, RSVP, status, link) is
 * sent once; a new link (every fresh-link send) or a new status is a new email. The raw token never
 * leaves the server: only a hash of it, derived apart from the stored `manageToken` hash.
 */
export function guestEmailKey(kind: GuestEmailKind, rsvpId: string, status: string, token: string): string {
  return `rsvp-${kind}:${rsvpId}:${status}:${hashToken(`idempotency:${token}`).slice(0, 32)}`;
}

async function sendGuestEmail(
  db: PrismaClient,
  origin: string,
  event: EventRow,
  rsvp: RsvpRow,
  token: string,
  kind: GuestEmailKind,
  template: (data: EmailData) => EmailContent
) {
  const data = await emailDataFor(db, origin, event, rsvp, token);
  return sendEventEmail({
    to: rsvp.email,
    content: template(data),
    fromName: data.brand.senderName,
    replyTo: data.brand.replyToEmail,
    idempotencyKey: guestEmailKey(kind, rsvp.id, rsvp.status, token),
  });
}

/**
 * Emails the guest a NEW manage link (older links die) with `template`. Without a mail provider the
 * new link could not reach the guest, so nothing changes and their working link stays (audit M-8);
 * the new token is stored only once the email carrying it was accepted, so a failed send never kills
 * the old link either. The write is conditional on the RSVP still having this email (an erased row
 * never gets a working link back).
 */
async function sendWithFreshLink(
  db: PrismaClient,
  origin: string,
  event: EventRow,
  rsvp: RsvpRow,
  kind: GuestEmailKind,
  template: (data: EmailData) => EmailContent
): Promise<boolean> {
  if (!canSendEventEmail()) return false;
  const token = newToken();
  const sent = await sendGuestEmail(db, origin, event, rsvp, token, kind, template);
  if (sent) await db.rsvp.updateMany({where: {id: rsvp.id, email: rsvp.email}, data: {manageToken: hashToken(token)}});
  return sent;
}

/**
 * The confirmation email, honouring the event's `confirmation` rule: nothing when the host turned it
 * off, their edited copy when set. Only a confirmed guest is governed by the rule; waitlist, pending
 * and awaiting-payment mails explain the guest's status and always go out.
 */
async function confirmationTemplate(db: PrismaClient, event: EventRow, rsvp: RsvpRow): Promise<((data: EmailData) => EmailContent) | null> {
  let copy: {subject: string; body: string} | null = null;
  if (rsvp.status === 'confirmed') {
    const rule = await confirmationRuleFor(db, event.id);
    if (rule.skip) return null;
    copy = rule.copy;
  }
  return data => confirmationEmail(data, copy);
}

async function sendConfirmation(db: PrismaClient, origin: string, event: EventRow, rsvp: RsvpRow, token: string) {
  const template = await confirmationTemplate(db, event, rsvp);
  if (template) await sendGuestEmail(db, origin, event, rsvp, token, 'confirmation', template);
}

/** The confirmation when the caller has no raw token: it carries a new link, issued only if it is sent. */
async function sendConfirmationWithFreshLink(db: PrismaClient, origin: string, event: EventRow, rsvp: RsvpRow) {
  const template = await confirmationTemplate(db, event, rsvp);
  if (template) await sendWithFreshLink(db, origin, event, rsvp, 'confirmation', template);
}

const sendPromotions = (db: PrismaClient, origin: string, event: EventRow, changed: Changed[]) =>
  Promise.all<unknown>(
    changed.flatMap((c): Promise<unknown>[] =>
      c.claim
        ? [sendClaimEmail(db, c.rsvp.id, {origin})]
        : c.promoted
          ? [sendConfirmationWithFreshLink(db, origin, event, c.rsvp)]
          : []
    )
  );

/** Emails a new link (older links die), capped per (event, email); see `sendWithFreshLink`. */
async function mailManageLink(db: PrismaClient, origin: string, event: EventRow, rsvp: RsvpRow) {
  if (!canSendEventEmail() || !hit(`mail:${event.id}:${rsvp.email}`, EMAIL_CAP.limit, EMAIL_CAP.windowMs)) return;
  await sendWithFreshLink(db, origin, event, rsvp, 'manage-link', manageLinkEmail);
}

// ---------------------------------------------------------------- manage token

/** Guests see an event only while it is published or cancelled and not deleted (as `findEvent`). */
const guestVisible = (event: {status: string; deletedAt: Date | null}) =>
  event.deletedAt === null && (event.status === 'published' || event.status === 'cancelled');

/**
 * A valid link whose event the host has unpublished or deleted: 410 with only the event's title, which
 * the link's holder already knows. No guest data and nothing to edit. An unknown token stays a 404.
 */
const eventUnavailable = (c: Context, title: string) =>
  c.json({error: 'event_unavailable', message: 'This event is no longer available.', event: {title}} satisfies EventUnavailable, 410);

/**
 * The RSVP and its event in ONE query (same rules as `findEvent`: published or cancelled, not deleted).
 * `unavailable`: the token is valid but the event is now a draft or deleted (the route answers 410).
 */
async function fromManageToken(
  db: PrismaClient,
  token: string,
  access: 'read' | 'write'
): Promise<{rsvp: RsvpRow; event: EventRow; unavailable?: undefined} | {unavailable: {title: string}} | null> {
  const found = await db.rsvp.findUnique({
    where: {manageToken: hashToken(token)},
    select: {...rsvpSelect, event: {select: {...eventSelect, deletedAt: true}}},
  });
  if (!found) return null;
  const {event: withDeleted, ...rsvp} = found;
  const {deletedAt, ...event} = withDeleted;
  if (!guestVisible({status: event.status, deletedAt})) {
    // Same lifetime as a readable link: a long-dead token stays a plain 404.
    return manageTokenAllows(event.endAt, 'read', new Date()) ? {unavailable: {title: event.title}} : null;
  }
  if (!manageTokenAllows(event.endAt, access, new Date())) return null;
  return {rsvp: rsvp as RsvpRow, event: event as EventRow};
}


function fail(c: Context, err: unknown) {
  if (err instanceof RsvpError) {
    return c.json({...problem(err.code, err.message), ...(err.fields ? {fields: err.fields} : {})}, err.status);
  }
  throw err;
}

/** Keeps a guest's link private: never cached, never sent on as a Referer. */
function privateHeaders(c: Context) {
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex');
}

// ---------------------------------------------------------------- validators

const slugParam = validator('param', (value, c) => {
  const slug = (value as Record<string, string>).slug;
  return typeof slug === 'string' && SLUG_RE.test(slug) ? {slug} : c.json(problem('not_found', 'No such event.'), 404);
});
const tokenParam = validator('param', (value, c) => {
  const token = (value as Record<string, string>).token;
  return typeof token === 'string' && TOKEN_RE.test(token) ? {token} : c.json(problem('not_found', 'RSVP not found.'), 404);
});
const inviteParam = validator('param', (value, c) => {
  const token = (value as Record<string, string>).token;
  return typeof token === 'string' && INVITE_RE.test(token) ? {token} : c.json(problem('not_found', 'Invite not found.'), 404);
});
const inviteQuery = validator('query', value => ({
  invite: typeof value.invite === 'string' ? value.invite.slice(0, 600) : '',
}));
/** A JSON object (the field-by-field check needs the event's rules, so it runs in the handler). */
const objectBody = validator('json', (value, c) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : c.json(problem('invalid_body', 'Send the RSVP as a JSON object.'), 422)
);
const emailBody = validator('json', (value, c) => {
  const email = typeof (value as Record<string, unknown>)?.email === 'string' ? ((value as {email: string}).email.trim().toLowerCase()) : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254
    ? {email}
    : c.json({...problem('validation_failed', 'Enter a valid email address.'), fields: {email: 'Enter a valid email address, like name@example.com.'}}, 422);
});

const CHECK_EMAIL: RsvpSubmitResult = {
  status: 'check_email',
  checkoutUrl: null,
  message: 'If that email can RSVP, we have sent it a link to view or change the RSVP.',
};

// ---------------------------------------------------------------- routes

export const rsvpRoutes = new Hono()
  .get('/events/:slug', slugParam, inviteQuery, withDb, async c => {
    const db = c.var.db;
    const now = new Date();
    const event = await findEvent(db, {slug: c.req.valid('param').slug});
    if (!event) return notFound(c, 'Event');
    if (event.visibility === 'private' && !(await liveInvite(db, event, c.req.valid('query').invite, now))) return notFound(c, 'Event');
    c.header('Cache-Control', 'private, no-store');
    return c.json({event: await buildView(db, event, now)});
  })

  .post('/events/:slug', slugParam, objectBody, withDb, async c => {
    // Every answer from here carries the same headers, so a new and a repeat RSVP look alike (audit L-6).
    privateHeaders(c);
    if (!hit(`rsvp:${clientIp(c)}`, RSVP_LIMIT.limit, RSVP_LIMIT.windowMs)) {
      return c.json(problem('rate_limited', 'Too many RSVPs. Try again in a minute.'), 429);
    }
    const db = c.var.db;
    const raw = c.req.valid('json');
    const now = new Date();
    const event = await findEvent(db, {slug: c.req.valid('param').slug});
    if (!event) return notFound(c, 'Event');
    const invite = await liveInvite(db, event, raw.inviteToken, now);
    // A private event without a valid invite is the same 404 as a missing one.
    if (event.visibility === 'private' && !invite) return notFound(c, 'Event');
    // Honeypot: only bots fill the hidden field. Same answer as a repeat RSVP, nothing stored or sent.
    if (typeof raw.website === 'string' && raw.website.trim() !== '') return c.json(CHECK_EMAIL, 202);

    const parsed = validateRsvp(raw, rulesOf(event));
    if (!parsed.ok) return c.json({...problem('validation_failed', 'Some fields need attention.'), fields: parsed.fields}, 422);
    const utm = typeof raw.utmSource === 'string' ? raw.utmSource.slice(0, 80) : null;

    // An invite is for the person it was sent to (audit M-5): on a private event only that email may
    // RSVP with it, so a forwarded link can't let anyone else in (one invite, one guest: emails are
    // unique per event). The invite's holder already sees that address on the invite page. On a public
    // or unlisted event anyone may RSVP anyway: a different email simply isn't credited to the invite.
    let inviteId = invite?.id ?? null;
    if (invite && parsed.value.email !== invite.email.trim().toLowerCase()) {
      if (event.visibility === 'private') {
        return c.json(
          {...problem('validation_failed', 'Some fields need attention.'), fields: {email: 'Use the email address this invite was sent to.'}},
          422
        );
      }
      inviteId = null;
    }

    let out: Submitted;
    try {
      out = await submitRsvp(db, event.id, parsed.value, inviteId, {utm}, now);
    } catch (err) {
      return fail(c, err);
    }
    const origin = originOf(c);
    if (!out.created) {
      background(c, mailManageLink(db, origin, event, out.rsvp));
      return c.json(CHECK_EMAIL, 202);
    }
    const {rsvp, token} = out;
    let checkoutUrl: string | null = null;

    if (rsvp.status === 'awaiting_payment') {
      // HOOK: paid ticket. The seat is held; the payments agent starts the checkout, and a failure frees the seat.
      checkoutUrl = await startPayment(origin, event, rsvp, token);
      if (!checkoutUrl) {
        // Undo the new RSVP entirely, so this email isn't stuck with a cancelled row (audit M-1).
        await discardNewRsvp(db, rsvp.id, origin, out.inviteStatus).catch(err => console.error('[rsvp] could not discard unpaid RSVP', rsvp.id, err instanceof Error ? err.message : 'failed'));
        return c.json(problem('payments_unavailable', RSVP_CONFLICTS.payments_unavailable!), 409);
      }
    }

    hit(`mail:${event.id}:${rsvp.email}`, EMAIL_CAP.limit, EMAIL_CAP.windowMs);
    // No confirmation yet for a guest who still has to pay: the paid confirmation follows the payment.
    if (rsvp.status !== 'awaiting_payment') background(c, sendConfirmation(db, origin, event, rsvp, token));
    if (rsvp.marketingConsent) background(c, sendConsentEmail(db, rsvp.id, {origin}));
    background(c, sendPromotions(db, origin, event, out.promoted));
    emitWebhook(c, db, 'rsvp.created', rsvpPayload(rsvp));
    emitPromoted(c, db, out.promoted);
    // Same status and shape as a repeat RSVP (no existence oracle): the manage link, the only way to the
    // guest's page, goes to their inbox and never into this response. Only a paid RSVP adds the pay link.
    const body: RsvpSubmitResult = {...CHECK_EMAIL, checkoutUrl};
    return c.json(body, 202);
  })

  // "Lost my link": always 202, so it can't tell anyone whether an email has RSVP'd.
  .post('/events/:slug/manage-link', slugParam, emailBody, withDb, async c => {
    privateHeaders(c);
    if (!hit(`link:${clientIp(c)}`, 10, 60_000)) return c.json(problem('rate_limited', 'Too many requests. Try again in a minute.'), 429);
    const db = c.var.db;
    const event = await findEvent(db, {slug: c.req.valid('param').slug});
    const rsvp = event
      ? await db.rsvp.findUnique({where: {eventId_email: {eventId: event.id, email: c.req.valid('json').email}}, select: rsvpSelect})
      : null;
    if (event && rsvp) background(c, mailManageLink(db, originOf(c), event, rsvp));
    return c.json(CHECK_EMAIL, 202);
  })

  .get('/invite/:token', inviteParam, withDb, async c => {
    const db = c.var.db;
    const now = new Date();
    privateHeaders(c);
    // The invite and its event in ONE query; the event is checked here with `findEvent`'s rules.
    const found = await db.invite.findUnique({
      where: {token: c.req.valid('param').token},
      select: {id: true, eventId: true, email: true, name: true, status: true, token: true, event: {select: {...eventSelect, deletedAt: true}}},
    });
    if (!found || found.status === 'bounced') return notFound(c, 'Invite');
    const {deletedAt, ...event} = found.event;
    // A live invite whose event the host unpublished or deleted: a friendly "no longer available" (410).
    if (!guestVisible({status: event.status, deletedAt})) return eventUnavailable(c, event.title);
    if (now >= event.endAt) return notFound(c, 'Invite');
    const existing = await db.rsvp.findUnique({where: {eventId_email: {eventId: event.id, email: found.email.toLowerCase()}}, select: {id: true}});
    const view = await buildView(db, event, now);
    const body: InviteView = {
      // `visibility`: a private event takes an RSVP only from the invited address, so the form locks its email (M-5).
      event: {...view, description: event.description, venueName: event.venueName, venueAddress: event.venueAddress, visibility: event.visibility},
      invite: {name: found.name, email: found.email.toLowerCase(), token: found.token},
      // A repeat visit never reveals the guest's manage token (only its hash is stored).
      alreadyResponded: existing !== null,
    };
    return c.json(body);
  })

  .get('/manage/:token', tokenParam, withDb, async c => {
    const db = c.var.db;
    privateHeaders(c);
    const found = await fromManageToken(db, c.req.valid('param').token, 'read');
    if (!found) return notFound(c, 'RSVP');
    if (found.unavailable) return eventUnavailable(c, found.unavailable.title);
    const {rsvp, event} = found;
    const now = new Date();
    const answerRows = await db.rsvpAnswer.findMany({where: {rsvpId: rsvp.id}, select: {questionId: true, value: true}, take: 100});
    const answers: Record<string, AnswerValue> = {};
    for (const a of answerRows) {
      if (typeof a.value === 'string' || typeof a.value === 'boolean' || Array.isArray(a.value)) answers[a.questionId] = a.value as AnswerValue;
    }
    const view = await buildView(db, event, now);
    const confirmed = rsvp.status === 'confirmed';
    const origin = originOf(c);
    const body: GuestRsvpView = {
      event: {
        ...view,
        description: event.description,
        venueName: event.venueName,
        venueAddress: event.venueAddress,
        mapUrl: event.mapUrl,
        format: event.format,
        // The private join link is for confirmed guests only (US-2).
        joinUrl: confirmed && rsvp.response === 'going' ? event.joinUrl : null,
        pageUrl: eventLink(origin, event, c.req.valid('param').token),
      },
      rsvp: {
        name: rsvp.name,
        email: rsvp.email,
        response: rsvp.response,
        status: rsvp.status,
        plusOnes: rsvp.plusOnes,
        seats: rsvp.seats,
        ticketCode: confirmed && rsvp.response === 'going' ? rsvp.ticketCode : null,
        ticketTypeId: rsvp.ticketTypeId,
        marketingConsent: rsvp.marketingConsent,
        waitlistPosition: rsvp.status === 'waitlisted' ? rsvp.waitlistPosition : null,
        answers,
        // A declined or cancelled guest may re-open their RSVP from this page (audit M-11): placement treats it as new.
        canEdit: manageTokenAllows(event.endAt, 'write', now) && event.status !== 'cancelled',
      },
      calendar: {
        icsPath: `/site-api/rsvp/manage/${c.req.valid('param').token}/calendar.ics`,
        googleUrl: googleCalendarUrl({
          title: event.title,
          // A Google link is an outside URL: never the manage token in it (a private event gets no link).
          description: event.visibility === 'private' ? null : `${origin}/events/${event.slug}/`,
          startAt: event.startAt,
          endAt: event.endAt,
          location: [event.venueName, event.venueAddress].filter(Boolean).join(', ') || (event.format === 'in_person' ? null : 'Online'),
          timezone: event.timezone,
        }),
      },
    };
    return c.json(body);
  })

  .patch('/manage/:token', tokenParam, objectBody, withDb, async c => {
    if (!hit(`rsvp:${clientIp(c)}`, RSVP_LIMIT.limit, RSVP_LIMIT.windowMs)) {
      return c.json(problem('rate_limited', 'Too many changes. Try again in a minute.'), 429);
    }
    const db = c.var.db;
    privateHeaders(c);
    const found = await fromManageToken(db, c.req.valid('param').token, 'write');
    if (!found) return notFound(c, 'RSVP');
    if (found.unavailable) return eventUnavailable(c, found.unavailable.title);
    // The email is the RSVP's identity: it never changes here.
    const parsed = validateRsvp(c.req.valid('json'), rulesOf(found.event), {fixedEmail: found.rsvp.email});
    if (!parsed.ok) return c.json({...problem('validation_failed', 'Some fields need attention.'), fields: parsed.fields}, 422);
    try {
      const out = await updateRsvp(db, found.rsvp.id, parsed.value, new Date());
      let checkoutUrl: string | null = null;
      if (out.rsvp.status === 'awaiting_payment') {
        // A move to a seat on a paid ticket (e.g. Maybe -> Going) pays exactly like a fresh RSVP.
        checkoutUrl = await startPayment(originOf(c), found.event, out.rsvp, c.req.valid('param').token);
        if (!checkoutUrl) {
          await revertEdit(db, out.previous, originOf(c)).catch(err => console.error('[rsvp] could not revert paid edit', out.previous.id, err instanceof Error ? err.message : 'failed'));
          return c.json(problem('payments_unavailable', RSVP_CONFLICTS.payments_unavailable!), 409);
        }
      }
      background(c, sendPromotions(db, originOf(c), found.event, out.promoted));
      emitWebhook(c, db, out.rsvp.status === 'cancelled' ? 'rsvp.cancelled' : 'rsvp.updated', rsvpPayload(out.rsvp));
      emitPromoted(c, db, out.promoted);
      // Newly ticked "send me updates": the inbox owner confirms it (double opt-in, as a new RSVP does).
      if (out.rsvp.marketingConsent && !out.previous.marketingConsent) background(c, sendConsentEmail(db, out.rsvp.id, {origin: originOf(c)}));
      // Tell the guest when their status changed (a new seat, the waitlist, awaiting approval). Same link.
      if (out.rsvp.status !== out.previous.status && out.rsvp.status !== 'awaiting_payment') {
        background(c, sendConfirmation(db, originOf(c), found.event, out.rsvp, c.req.valid('param').token));
      }
      return c.json({ok: true, status: out.rsvp.status, checkoutUrl});
    } catch (err) {
      return fail(c, err);
    }
  })

  .post('/manage/:token/cancel', tokenParam, withDb, async c => {
    const db = c.var.db;
    privateHeaders(c);
    const found = await fromManageToken(db, c.req.valid('param').token, 'write');
    if (!found) return notFound(c, 'RSVP');
    if (found.unavailable) return eventUnavailable(c, found.unavailable.title);
    try {
      const out = await transition(db, found.rsvp.id, current =>
        current.status === 'cancelled' ? null : {status: 'cancelled', waitlistPosition: null, claimExpiresAt: null}
      );
      background(c, sendPromotions(db, originOf(c), out.event, out.promoted));
      if (out.previous.status !== 'cancelled') emitWebhook(c, db, 'rsvp.cancelled', rsvpPayload(out.rsvp));
      emitPromoted(c, db, out.promoted);
      return c.json({ok: true, status: 'cancelled'});
    } catch (err) {
      return fail(c, err);
    }
  })

  .get('/manage/:token/calendar.ics', tokenParam, withDb, async c => {
    const db = c.var.db;
    privateHeaders(c);
    const found = await fromManageToken(db, c.req.valid('param').token, 'read');
    if (!found) return notFound(c, 'RSVP');
    if (found.unavailable) return eventUnavailable(c, found.unavailable.title);
    const {rsvp, event} = found;
    const gone = event.status === 'cancelled' || rsvp.status === 'cancelled' || rsvp.status === 'declined';
    const settings = await db.eventSettings.findUnique({where: {id: 1}, select: {senderName: true, replyToEmail: true}});
    const ics = buildIcs({
      uid: icsUid(rsvp.id),
      title: event.title,
      description: eventLink(originOf(c), event, c.req.valid('param').token),
      startAt: event.startAt,
      endAt: event.endAt,
      timezone: event.timezone,
      location: [event.venueName, event.venueAddress].filter(Boolean).join(', ') || null,
      url: eventLink(originOf(c), event, c.req.valid('param').token),
      organizerName: settings?.senderName || null,
      organizerEmail: settings?.replyToEmail || null,
      method: gone ? 'CANCEL' : 'PUBLISH',
      sequence: Math.floor(Date.now() / 1000),
      now: new Date(),
    });
    return c.body(ics, 200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${event.slug.replace(/[^\w-]/g, '')}.ics"`,
    });
  });
