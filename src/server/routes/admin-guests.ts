import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {appConfig} from '../../config/app.config';
import {decideSeat, seatsFor, seatsRemaining} from '../../domain/capacity';
import {hashToken, newToken} from '../../domain/secureToken';
import {addMinutes} from '../../domain/time';
import {hasActiveClaim, nextWaitlistPosition, orderWaitlist, renumberWaitlist} from '../../domain/waitlist';
import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {attachmentHeader, type CsvValue, toCsv} from '../csv';
import {eventMailSelect, type GuestNotice, type MailEvent, notifyGuests, publicBase} from '../guest-mail';
import {PERMISSIONS} from '../permissions';
import {isUuid, normalizeEmail} from './admin-invites';

/**
 * Guest management for event organisers (`site:event:manage`). Mounted by the
 * app at `/site-api/event-admin` (docs/porting/guests.md).
 *
 *   GET    /events/:eventId/guests?status&response&ticketTypeId&checkedIn&q&before   list (keyset, 50 a page)
 *   GET    /events/:eventId/guests/export.csv?(same filters)                         CSV (20,000 rows at most)
 *   POST   /events/:eventId/guests/bulk        {action: approve|decline|promote|remove|erase, rsvpIds}
 *   GET    /events/:eventId/guests/:rsvpId     detail (answers, timeline, questions)
 *   PATCH  /events/:eventId/guests/:rsvpId     edit name, email, plus-ones, consent, attended, checked in
 *   DELETE /events/:eventId/guests/:rsvpId     remove (frees the seat; refused when the guest has an order: erase)
 *   GET    /contacts?q&consent&before          everyone who RSVP'd to any event, once per email
 *   GET    /contacts/export.csv?q&consent      the same as CSV
 *
 * A malformed or unknown event or guest id is a 404. Seat changes run in a
 * transaction that locks the event row, so two last-seat decisions cannot both win.
 * Emails to guests (approved, declined, promoted) go after the commit and never fail the action.
 */

export const GUESTS_PAGE_SIZE = 50;
export const CONTACTS_PAGE_SIZE = 50;
export const BULK_MAX = 100;
/** Most rows one CSV export holds; the `X-Export-Truncated` header says when it was cut. */
export const EXPORT_MAX_ROWS = 20_000;

const MANAGE = PERMISSIONS.EVENT_MANAGE;
const STATUSES = ['pending', 'confirmed', 'waitlisted', 'declined', 'cancelled', 'awaiting_payment'] as const;
const RESPONSES = ['going', 'maybe', 'not_going'] as const;
type Status = (typeof STATUSES)[number];
type Response = (typeof RESPONSES)[number];
const BULK_ACTIONS = ['approve', 'decline', 'promote', 'remove', 'erase'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
/** Statuses that hold seats. */
const SEAT_HOLDERS: Status[] = ['confirmed', 'awaiting_payment'];

type Tx = Prisma.TransactionClient;

/* ── Filters ────────────────────────────────────────────────────────── */

export type GuestFilter = {
  status?: Status;
  response?: Response;
  ticketTypeId?: string;
  checkedIn?: boolean;
  q?: string;
};

/** Blank values mean "no filter"; an unknown value is an error. */
export function parseGuestFilter(value: Record<string, unknown>): {filter: GuestFilter} | {error: string} {
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string).trim() : '');
  const filter: GuestFilter = {};
  const status = text('status');
  if (status) {
    if (!(STATUSES as readonly string[]).includes(status)) return {error: 'Unknown status.'};
    filter.status = status as Status;
  }
  const response = text('response');
  if (response) {
    if (!(RESPONSES as readonly string[]).includes(response)) return {error: 'Unknown response.'};
    filter.response = response as Response;
  }
  const ticket = text('ticketTypeId');
  if (ticket) {
    if (!isUuid(ticket)) return {error: 'Unknown ticket type.'};
    filter.ticketTypeId = ticket;
  }
  const checkedIn = text('checkedIn');
  if (checkedIn) {
    if (checkedIn !== 'yes' && checkedIn !== 'no') return {error: 'checkedIn must be yes or no.'};
    filter.checkedIn = checkedIn === 'yes';
  }
  const q = text('q');
  if (q) filter.q = q.slice(0, 120);
  return {filter};
}

export function guestWhere(eventId: string, filter: GuestFilter): Prisma.RsvpWhereInput {
  const where: Prisma.RsvpWhereInput = {eventId};
  if (filter.status) where.status = filter.status;
  if (filter.response) where.response = filter.response;
  if (filter.ticketTypeId) where.ticketTypeId = filter.ticketTypeId;
  if (filter.checkedIn !== undefined) where.checkedInAt = filter.checkedIn ? {not: null} : null;
  if (filter.q) {
    where.OR = [
      {name: {contains: filter.q, mode: 'insensitive'}},
      {email: {contains: filter.q, mode: 'insensitive'}},
      {ticketCode: filter.q.toUpperCase()},
    ];
  }
  return where;
}

const filterQuery = validator('query', (value, c) => {
  const parsed = parseGuestFilter(value);
  if ('error' in parsed) return c.json(problem('invalid_input', parsed.error), 422);
  return {filter: parsed.filter, before: typeof value.before === 'string' ? value.before : ''};
});

/** `<createdAt ISO>_<id>`; anything malformed means the first page. */
export function parseCursor(raw: string): {at: Date; id: string} | null {
  const [iso, id] = raw.split('_');
  const at = new Date(iso ?? '');
  return id && isUuid(id) && !Number.isNaN(at.getTime()) ? {at, id} : null;
}

/* ── Shapes ─────────────────────────────────────────────────────────── */

const rowSelect = {
  id: true,
  name: true,
  email: true,
  response: true,
  status: true,
  plusOnes: true,
  seats: true,
  ticketCode: true,
  ticketTypeId: true,
  marketingConsent: true,
  consentConfirmedAt: true,
  checkedInAt: true,
  attended: true,
  waitlistPosition: true,
  source: true,
  createdAt: true,
  confirmedAt: true,
  claimExpiresAt: true,
  updatedAt: true,
} as const;

const mailGuestSelect = {
  id: true,
  name: true,
  email: true,
  response: true,
  status: true,
  ticketCode: true,
  waitlistPosition: true,
} as const;

type AnswerValue = string | string[] | boolean;
type RsvpRow = Prisma.RsvpGetPayload<{select: typeof rowSelect}>;

const answerText = (value: AnswerValue | undefined): string =>
  value === undefined ? '' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : Array.isArray(value) ? value.join('; ') : value;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Answers, latest payment status and ticket names for a set of rows, in a few bounded queries. */
async function enrich(db: PrismaClient, eventId: string, rows: RsvpRow[]) {
  const ids = rows.map(r => r.id);
  const [questions, types] = await Promise.all([
    db.rsvpQuestion.findMany({where: {eventId}, select: {id: true, label: true, type: true}, orderBy: {id: 'asc'}, take: 50}),
    db.ticketType.findMany({
      where: {eventId},
      select: {id: true, name: true, priceCents: true, currency: true},
      orderBy: {id: 'asc'},
      take: 50,
    }),
  ]);
  const answers = new Map<string, Record<string, AnswerValue>>();
  const payment = new Map<string, string>();
  for (const part of chunks(ids, 500)) {
    const [answerRows, orders] = await Promise.all([
      db.rsvpAnswer.findMany({where: {rsvpId: {in: part}}, select: {rsvpId: true, questionId: true, value: true}}),
      db.ticketOrder.findMany({
        where: {rsvpId: {in: part}},
        select: {rsvpId: true, status: true},
        orderBy: {createdAt: 'desc'},
      }),
    ]);
    for (const a of answerRows) {
      const own = answers.get(a.rsvpId) ?? {};
      own[a.questionId] = a.value as AnswerValue;
      answers.set(a.rsvpId, own);
    }
    for (const o of orders) if (!payment.has(o.rsvpId)) payment.set(o.rsvpId, o.status);
  }
  const names = new Map(types.map(t => [t.id, t.name]));
  const guests = rows.map(r => ({
    id: r.id,
    name: r.name,
    email: r.email,
    response: r.response,
    status: r.status,
    plusOnes: r.plusOnes,
    seats: r.seats,
    ticketCode: r.ticketCode,
    ticketTypeId: r.ticketTypeId,
    ticketTypeName: r.ticketTypeId ? (names.get(r.ticketTypeId) ?? null) : null,
    paymentStatus: payment.get(r.id) ?? null,
    marketingConsent: r.marketingConsent && r.consentConfirmedAt !== null,
    checkedInAt: r.checkedInAt?.toISOString() ?? null,
    attended: r.attended,
    waitlistPosition: r.waitlistPosition,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    answers: answers.get(r.id) ?? {},
  }));
  return {guests, questions, types};
}

function timeline(r: RsvpRow) {
  const entries: Array<{kind: string; at: Date | null}> = [
    {kind: 'rsvped', at: r.createdAt},
    {kind: 'confirmed', at: r.confirmedAt},
    {kind: 'checked_in', at: r.checkedInAt},
  ];
  const latest = Math.max(...entries.map(e => e.at?.getTime() ?? 0));
  if (r.updatedAt.getTime() > latest) entries.push({kind: 'updated', at: r.updatedAt});
  return entries
    .filter((e): e is {kind: string; at: Date} => e.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(e => ({kind: e.kind, at: e.at.toISOString()}));
}

async function detailOf(db: PrismaClient, eventId: string, row: RsvpRow) {
  const {guests, questions} = await enrich(db, eventId, [row]);
  return {
    ...guests[0]!,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    claimExpiresAt: row.claimExpiresAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    questions,
    timeline: timeline(row),
  };
}

/* ── Event and seat helpers ─────────────────────────────────────────── */

const notFound = (what: string) => problem('not_found', `${what} not found.`);

async function loadEvent(db: PrismaClient, id: string) {
  if (!isUuid(id)) return null;
  return db.event.findFirst({where: {id, deletedAt: null}, select: eventMailSelect}) as Promise<MailEvent | null>;
}

class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Runs `fn` in a transaction holding the event row's lock. */
async function withEventLock<T>(db: PrismaClient, eventId: string, fn: (tx: Tx, event: MailEvent) => Promise<T>): Promise<T> {
  return db.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT "id" FROM "events" WHERE "id" = ${eventId}::uuid FOR UPDATE`;
      const event = (await tx.event.findFirst({where: {id: eventId, deletedAt: null}, select: eventMailSelect})) as MailEvent | null;
      if (!event) throw new Refused('not_found');
      return fn(tx, event);
    },
    {timeout: 15_000}
  );
}

async function seatsTaken(tx: Tx, eventId: string, excludeId?: string): Promise<number> {
  const sum = await tx.rsvp.aggregate({
    _sum: {seats: true},
    where: {eventId, status: {in: SEAT_HOLDERS}, response: 'going', ...(excludeId ? {id: {not: excludeId}} : {})},
  });
  return sum._sum.seats ?? 0;
}

const isPaid = async (tx: Tx, eventId: string) => (await tx.ticketType.count({where: {eventId, priceCents: {gt: 0}}})) > 0;

async function waitlistOf(tx: Tx, eventId: string) {
  return tx.rsvp.findMany({
    where: {eventId, status: 'waitlisted'},
    select: {id: true, seats: true, waitlistPosition: true, createdAt: true, claimExpiresAt: true},
    orderBy: [{waitlistPosition: 'asc'}, {createdAt: 'asc'}],
    take: 5000,
  });
}

async function renumber(tx: Tx, eventId: string) {
  for (const r of renumberWaitlist(await waitlistOf(tx, eventId))) {
    await tx.rsvp.update({where: {id: r.id}, data: {waitlistPosition: r.waitlistPosition}, select: {id: true}});
  }
}

type PromoteResult = {notices: GuestNotice[]; succeeded: string[]; failed: {rsvpId: string; reason: string}[]};

/**
 * Hands free seats to waitlisted guests, first in line first. `only` limits it to chosen guests
 * (the host's "promote"); without it every guest who fits is promoted (a seat was released).
 * Free events confirm; paid events send a claim offer, since a seat without payment would be a free ticket.
 * Seats held by other guests' outstanding claims stay held.
 */
async function promoteFromWaitlist(tx: Tx, event: MailEvent, now: Date, only?: Set<string>): Promise<PromoteResult> {
  const result: PromoteResult = {notices: [], succeeded: [], failed: []};
  const list = orderWaitlist(await waitlistOf(tx, event.id));
  const paid = await isPaid(tx, event.id);
  if (only) {
    const present = new Set(list.map(w => w.id));
    for (const id of only) if (!present.has(id)) result.failed.push({rsvpId: id, reason: 'not_waitlisted'});
  }
  const held = list.filter(w => hasActiveClaim(w, now)).reduce((sum, w) => sum + w.seats, 0);
  let available = seatsRemaining(event.capacity, await seatsTaken(tx, event.id)) - held;
  for (const entry of list) {
    if (only && !only.has(entry.id)) continue;
    const ownHold = hasActiveClaim(entry, now) ? entry.seats : 0;
    if (!only && entry.claimExpiresAt != null) continue; // offered already: the claim job decides
    if (paid && ownHold > 0) {
      result.failed.push({rsvpId: entry.id, reason: 'claim_pending'});
      continue;
    }
    if (entry.seats > available + ownHold) {
      if (only) result.failed.push({rsvpId: entry.id, reason: 'event_full'});
      continue;
    }
    available = available + ownHold - entry.seats;
    if (paid) {
      const claimExpiresAt = addMinutes(now, appConfig.waitlistClaimMinutes);
      const guest = await tx.rsvp.update({where: {id: entry.id}, data: {claimExpiresAt}, select: mailGuestSelect});
      result.notices.push({kind: 'waitlist_offer', guest, claimExpiresAt});
    } else {
      const guest = await tx.rsvp.update({
        where: {id: entry.id},
        data: {status: 'confirmed', confirmedAt: now, waitlistPosition: null, claimExpiresAt: null},
        select: mailGuestSelect,
      });
      result.notices.push({kind: 'confirmation', guest});
    }
    result.succeeded.push(entry.id);
  }
  await renumber(tx, event.id);
  return result;
}

/* ── Single-guest decisions ─────────────────────────────────────────── */

type Decided = {notices: GuestNotice[]};

async function approve(tx: Tx, event: MailEvent, rsvpId: string, now: Date): Promise<Decided> {
  const current = await tx.rsvp.findFirst({
    where: {id: rsvpId, eventId: event.id},
    select: {id: true, status: true, response: true, seats: true, ticketTypeId: true},
  });
  if (!current) throw new Refused('not_found');
  if (current.status !== 'pending') throw new Refused('not_pending');
  if (event.status === 'cancelled') throw new Refused('event_cancelled');

  const decision = decideSeat(
    {
      capacity: event.capacity,
      seatsTaken: await seatsTaken(tx, event.id, rsvpId),
      waitlistEnabled: event.waitlistEnabled,
      approvalRequired: false,
      rsvpDeadline: null,
      now,
    },
    current.seats
  );
  let data: Prisma.RsvpUpdateInput;
  if (current.response !== 'going') {
    // A maybe holds no seat but is confirmed, so it still gets reminders.
    data = {status: 'confirmed', confirmedAt: now, waitlistPosition: null, claimExpiresAt: null};
  } else if (decision.kind === 'confirm') {
    const ticket = current.ticketTypeId
      ? await tx.ticketType.findFirst({where: {id: current.ticketTypeId}, select: {priceCents: true}})
      : null;
    // Approved on a paid ticket: the seat is held until the guest pays.
    data = {status: ticket && ticket.priceCents > 0 ? 'awaiting_payment' : 'confirmed', confirmedAt: now, waitlistPosition: null, claimExpiresAt: null};
  } else if (decision.kind === 'waitlist') {
    data = {status: 'waitlisted', waitlistPosition: nextWaitlistPosition(await waitlistOf(tx, event.id)), confirmedAt: null};
  } else {
    throw new Refused('event_full');
  }
  const guest = await tx.rsvp.update({where: {id: rsvpId}, data, select: mailGuestSelect});
  return {notices: [{kind: 'confirmation', guest}]};
}

async function decline(tx: Tx, event: MailEvent, rsvpId: string): Promise<Decided> {
  const current = await tx.rsvp.findFirst({where: {id: rsvpId, eventId: event.id}, select: {status: true}});
  if (!current) throw new Refused('not_found');
  if (current.status !== 'pending') throw new Refused('not_pending');
  const guest = await tx.rsvp.update({
    where: {id: rsvpId},
    data: {status: 'declined', waitlistPosition: null, confirmedAt: null},
    select: mailGuestSelect,
  });
  return {notices: [{kind: 'declined', guest}]};
}

/** Takes a guest's seat away (delete or erase) and passes it on to the waitlist. */
async function releaseAndPromote(tx: Tx, event: MailEvent, was: {status: string; response: string}, now: Date) {
  const heldSeat = SEAT_HOLDERS.includes(was.status as Status) && was.response === 'going';
  if (event.status === 'cancelled' || (!heldSeat && was.status !== 'waitlisted')) return [] as GuestNotice[];
  return (await promoteFromWaitlist(tx, event, now)).notices;
}

async function removeGuest(tx: Tx, event: MailEvent, rsvpId: string, now: Date): Promise<GuestNotice[]> {
  const current = await tx.rsvp.findFirst({
    where: {id: rsvpId, eventId: event.id},
    select: {id: true, email: true, status: true, response: true, _count: {select: {ticketOrders: true}}},
  });
  if (!current) throw new Refused('not_found');
  // Orders keep payment history: those guests are erased (anonymised) instead.
  if (current._count.ticketOrders > 0) throw new Refused('has_order: use erase');
  await tx.pollVote.updateMany({where: {rsvpId}, data: {rsvpId: null}});
  await tx.rsvp.delete({where: {id: rsvpId}, select: {id: true}});
  await tx.invite.deleteMany({where: {eventId: event.id, email: current.email}});
  return releaseAndPromote(tx, event, current, now);
}

/**
 * Erasure: the seat is released, then the RSVP is anonymised in place. The
 * order rows and amounts stay for accounting; refunds remain a separate decision.
 * The manage token becomes the hash of a value nobody sees, so old links stop working.
 */
async function eraseGuest(tx: Tx, event: MailEvent, rsvpId: string, now: Date): Promise<GuestNotice[]> {
  const current = await tx.rsvp.findFirst({
    where: {id: rsvpId, eventId: event.id},
    select: {id: true, email: true, status: true, response: true},
  });
  if (!current) throw new Refused('not_found');
  // Mid-checkout: a payment could still complete and re-seat the row.
  if (current.status === 'awaiting_payment') throw new Refused('checkout_in_progress');
  await tx.pollVote.updateMany({where: {rsvpId}, data: {rsvpId: null}});
  await tx.rsvpAnswer.deleteMany({where: {rsvpId}});
  await tx.messageDelivery.deleteMany({where: {rsvpId}});
  await tx.invite.deleteMany({where: {eventId: event.id, email: current.email}});
  await tx.rsvp.update({
    where: {id: rsvpId},
    data: {
      name: 'Removed guest',
      email: `removed+${rsvpId}@invalid`,
      manageToken: hashToken(newToken()),
      marketingConsent: false,
      consentConfirmedAt: null,
      status: 'cancelled',
      waitlistPosition: null,
      claimExpiresAt: null,
      inviteId: null,
      utmSource: null,
    },
    select: {id: true},
  });
  return releaseAndPromote(tx, event, current, now);
}

type BulkResult = {action: BulkAction; succeeded: string[]; failed: {rsvpId: string; reason: string}[]};

/** One outcome per id; a failure never aborts the batch. Emails go out after each commit. */
async function runBulk(db: PrismaClient, base: string, event: MailEvent, action: BulkAction, rawIds: string[]): Promise<BulkResult> {
  const ids = [...new Set(rawIds)];
  const result: BulkResult = {action, succeeded: [], failed: []};
  const notices: GuestNotice[] = [];
  const now = new Date();
  const reasonOf = (err: unknown) => {
    if (err instanceof Refused) return err.reason;
    throw err;
  };

  if (action === 'promote') {
    if (event.status === 'cancelled') {
      result.failed.push(...ids.map(rsvpId => ({rsvpId, reason: 'event_cancelled'})));
      return result;
    }
    const promoted = await withEventLock(db, event.id, (tx, locked) => promoteFromWaitlist(tx, locked, now, new Set(ids)));
    result.succeeded.push(...promoted.succeeded);
    result.failed.push(...promoted.failed);
    notices.push(...promoted.notices);
  } else {
    // Sequential: each call takes the event lock, and the order decides who gets the last seat.
    for (const rsvpId of ids) {
      try {
        const out = await withEventLock(db, event.id, async (tx, locked) => {
          if (action === 'approve') return (await approve(tx, locked, rsvpId, now)).notices;
          if (action === 'decline') return (await decline(tx, locked, rsvpId)).notices;
          if (action === 'remove') return removeGuest(tx, locked, rsvpId, now);
          return eraseGuest(tx, locked, rsvpId, now);
        });
        result.succeeded.push(rsvpId);
        // Removed and erased guests are not emailed; promotions their seat triggers are.
        notices.push(...out);
      } catch (err) {
        result.failed.push({rsvpId, reason: reasonOf(err)});
      }
    }
  }
  await notifyGuests(db, base, event, notices);
  return result;
}

/* ── Validation ─────────────────────────────────────────────────────── */

const jsonObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const bulkBody = validator('json', (value, c) => {
  const v = jsonObject(value);
  const action = BULK_ACTIONS.find(a => a === v.action);
  const ids = Array.isArray(v.rsvpIds) ? v.rsvpIds : [];
  if (!action) return c.json(problem('invalid_input', 'Unknown action.'), 422);
  if (ids.length < 1 || ids.length > BULK_MAX || !ids.every(isUuid)) {
    const message = `Pick between 1 and ${BULK_MAX} guests.`;
    return c.json({...problem('invalid_input', message), fields: {rsvpIds: message}}, 422);
  }
  return {action, rsvpIds: ids as string[]};
});

export type GuestPatch = {
  name?: string;
  email?: string;
  plusOnes?: number;
  marketingConsent?: boolean;
  attended?: boolean | null;
  checkedIn?: boolean;
};

export function checkGuestPatch(value: unknown): {patch: GuestPatch} | {fields: Record<string, string>} {
  const v = jsonObject(value);
  const fields: Record<string, string> = {};
  const patch: GuestPatch = {};
  if (v.name !== undefined) {
    const name = typeof v.name === 'string' ? v.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 1 || name.length > 120) fields.name = 'A name needs 1 to 120 characters.';
    else patch.name = name;
  }
  if (v.email !== undefined) {
    const email = normalizeEmail(v.email);
    if (!email) fields.email = 'Enter a valid email address.';
    else patch.email = email;
  }
  if (v.plusOnes !== undefined) {
    if (typeof v.plusOnes === 'number' && Number.isInteger(v.plusOnes) && v.plusOnes >= 0 && v.plusOnes <= 10) patch.plusOnes = v.plusOnes;
    else fields.plusOnes = 'Plus-ones are a whole number from 0 to 10.';
  }
  if (v.marketingConsent !== undefined) {
    if (typeof v.marketingConsent === 'boolean') patch.marketingConsent = v.marketingConsent;
    else fields.marketingConsent = 'Use yes or no.';
  }
  if (v.attended !== undefined) {
    if (v.attended === null || typeof v.attended === 'boolean') patch.attended = v.attended;
    else fields.attended = 'Use yes, no or unset.';
  }
  if (v.checkedIn !== undefined) {
    if (typeof v.checkedIn === 'boolean') patch.checkedIn = v.checkedIn;
    else fields.checkedIn = 'Use yes or no.';
  }
  if (!Object.keys(fields).length && !Object.keys(patch).length) fields.name = 'Nothing to change.';
  return Object.keys(fields).length ? {fields} : {patch};
}

const patchBody = validator('json', (value, c) => {
  const checked = checkGuestPatch(value);
  return 'fields' in checked
    ? c.json({...problem('invalid_input', Object.values(checked.fields)[0]!), fields: checked.fields}, 422)
    : checked.patch;
});

/* ── Contacts ───────────────────────────────────────────────────────── */

export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

type ContactRaw = {
  email: string;
  name: string;
  event_count: number;
  last_event_id: string;
  last_event_title: string;
  last_event_start_at: Date | string;
  marketing_consent: boolean;
};

async function queryContacts(db: PrismaClient, opts: {q: string; consentOnly: boolean; after: string; limit: number}) {
  const having: Prisma.Sql[] = [Prisma.sql`lower(r.email) > ${opts.after}`];
  if (opts.q) {
    const pattern = likePattern(opts.q);
    having.push(Prisma.sql`bool_or(r.email ILIKE ${pattern} OR r.name ILIKE ${pattern})`);
  }
  if (opts.consentOnly) {
    having.push(Prisma.sql`(array_agg((r.marketing_consent AND r.consent_confirmed_at IS NOT NULL) ORDER BY r.created_at DESC))[1]`);
  }
  const rows = await db.$queryRaw<ContactRaw[]>`
    SELECT lower(r.email) AS email,
      (array_agg(r.name ORDER BY r.created_at DESC))[1] AS name,
      count(DISTINCT r.event_id)::int AS event_count,
      (array_agg(e.id ORDER BY e.start_at DESC))[1]::text AS last_event_id,
      (array_agg(e.title ORDER BY e.start_at DESC))[1] AS last_event_title,
      (array_agg(e.start_at ORDER BY e.start_at DESC))[1] AS last_event_start_at,
      (array_agg((r.marketing_consent AND r.consent_confirmed_at IS NOT NULL) ORDER BY r.created_at DESC))[1] AS marketing_consent
    FROM rsvps r
    INNER JOIN events e ON e.id = r.event_id
    WHERE e.deleted_at IS NULL AND r.email NOT LIKE 'removed+%@invalid'
    GROUP BY lower(r.email)
    HAVING ${Prisma.join(having, ' AND ')}
    ORDER BY lower(r.email) ASC
    LIMIT ${opts.limit}`;
  return rows.map(r => ({
    email: r.email,
    name: r.name,
    eventCount: r.event_count,
    lastEvent: {id: r.last_event_id, title: r.last_event_title, startAt: new Date(r.last_event_start_at).toISOString()},
    marketingConsent: r.marketing_consent,
  }));
}

const contactsQuery = validator('query', value => ({
  q: typeof value.q === 'string' ? value.q.trim().slice(0, 120) : '',
  consentOnly: value.consent === 'yes',
  before: typeof value.before === 'string' ? value.before.toLowerCase().slice(0, 254) : '',
}));

const auditRemoval = (db: PrismaClient, actor: number | null | undefined, eventId: string, action: 'remove' | 'erase', done: number, failed: number) =>
  audit(db, {actorUserId: actor ?? null, action: action === 'erase' ? 'guests_erased' : 'guests_removed', target: ['event', eventId], meta: {done, failed}});

/* ── Routes ─────────────────────────────────────────────────────────── */

const guard = [withViewer, requireAuth, requirePermission(MANAGE), withDb] as const;

export const adminGuestRoutes = new Hono()
  // Registered before `/:rsvpId` so "export.csv" is not read as an id.
  .get('/events/:eventId/guests/export.csv', filterQuery, ...guard, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const rows = await db.rsvp.findMany({
      where: guestWhere(event.id, c.req.valid('query').filter),
      select: rowSelect,
      orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
      take: EXPORT_MAX_ROWS + 1,
    });
    const truncated = rows.length > EXPORT_MAX_ROWS;
    const {guests, questions} = await enrich(db, event.id, rows.slice(0, EXPORT_MAX_ROWS));
    const header: CsvValue[] = [
      'Name', 'Email', 'Response', 'Status', 'Seats', 'Plus-ones', 'Ticket code', 'Ticket type', 'Payment status',
      'Marketing consent', 'Checked in at', 'Attended', 'Source', 'RSVP date',
      ...questions.map(q => q.label),
    ];
    const body: CsvValue[][] = guests.map(g => [
      g.name, g.email, g.response, g.status, g.seats, g.plusOnes, g.ticketCode, g.ticketTypeName, g.paymentStatus,
      g.marketingConsent ? 'Yes' : 'No', g.checkedInAt, g.attended === null ? '' : g.attended ? 'Yes' : 'No', g.source, g.createdAt,
      ...questions.map(q => answerText(g.answers[q.id])),
    ]);
    await audit(db, {actorUserId: c.var.viewer.id, action: 'guests_exported', target: ['event', event.id], meta: {rows: guests.length}});
    const day = new Date().toISOString().slice(0, 10);
    return c.body(toCsv([header, ...body]), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': attachmentHeader(`guests-${event.slug}-${day}.csv`),
      'Cache-Control': 'no-store',
      'X-Export-Truncated': truncated ? '1' : '0',
    });
  })

  .post('/events/:eventId/guests/bulk', bulkBody, ...guard, async c => {
    const event = await loadEvent(c.var.db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const {action, rsvpIds} = c.req.valid('json');
    const result = await runBulk(c.var.db, publicBase(c.req.url), event, action, rsvpIds);
    if (action === 'remove' || action === 'erase') await auditRemoval(c.var.db, c.var.viewer.id, event.id, action, result.succeeded.length, result.failed.length);
    return c.json(result);
  })

  .get('/events/:eventId/guests/:rsvpId', ...guard, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    const rsvpId = c.req.param('rsvpId');
    if (!event || !isUuid(rsvpId)) return c.json(notFound('Guest'), 404);
    const row = await db.rsvp.findFirst({where: {id: rsvpId, eventId: event.id}, select: rowSelect});
    return row ? c.json(await detailOf(db, event.id, row)) : c.json(notFound('Guest'), 404);
  })

  .patch('/events/:eventId/guests/:rsvpId', patchBody, ...guard, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    const rsvpId = c.req.param('rsvpId');
    if (!event || !isUuid(rsvpId)) return c.json(notFound('Guest'), 404);
    const patch = c.req.valid('json');
    if (patch.plusOnes !== undefined && patch.plusOnes > event.maxPlusOnes) {
      const message = `This event allows up to ${event.maxPlusOnes} plus-one${event.maxPlusOnes === 1 ? '' : 's'}.`;
      return c.json({...problem('invalid_input', message), fields: {plusOnes: message}}, 422);
    }
    const now = new Date();
    try {
      const notices: GuestNotice[] = [];
      const row = await withEventLock(db, event.id, async (tx, locked) => {
        const current = await tx.rsvp.findFirst({
          where: {id: rsvpId, eventId: locked.id},
          select: {id: true, status: true, response: true, seats: true, plusOnes: true, checkedInAt: true},
        });
        if (!current) throw new Refused('not_found');
        const data: Prisma.RsvpUpdateInput = {};
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.email !== undefined) data.email = patch.email;
        if (patch.marketingConsent !== undefined) {
          data.marketingConsent = patch.marketingConsent;
          // Opting someone in needs the guest's own confirmation; the host can only switch it off.
          if (!patch.marketingConsent) data.consentConfirmedAt = null;
        }
        if (patch.attended !== undefined) data.attended = patch.attended;
        if (patch.checkedIn !== undefined) {
          if (patch.checkedIn && current.status !== 'confirmed') throw new Refused('not_confirmed');
          data.checkedInAt = patch.checkedIn ? (current.checkedInAt ?? now) : null;
        }
        let released = false;
        if (patch.plusOnes !== undefined && patch.plusOnes !== current.plusOnes) {
          const seats = seatsFor(patch.plusOnes);
          if (seats > current.seats && SEAT_HOLDERS.includes(current.status) && current.response === 'going') {
            const taken = await seatsTaken(tx, locked.id, rsvpId);
            if (seats > seatsRemaining(locked.capacity, taken)) throw new Refused('event_full');
          }
          data.plusOnes = patch.plusOnes;
          data.seats = seats;
          released = seats < current.seats;
        }
        const updated = await tx.rsvp.update({where: {id: rsvpId}, data, select: rowSelect});
        if (released && locked.status !== 'cancelled') notices.push(...(await promoteFromWaitlist(tx, locked, now)).notices);
        return updated;
      });
      await notifyGuests(db, publicBase(c.req.url), event, notices);
      return c.json(await detailOf(db, event.id, row));
    } catch (err) {
      if (err instanceof Refused) {
        if (err.reason === 'not_found') return c.json(notFound('Guest'), 404);
        if (err.reason === 'event_full') return c.json(problem('event_full', 'There are not enough free seats for that.'), 409);
        return c.json(problem(err.reason, 'Only confirmed guests can be checked in.'), 409);
      }
      if ((err as {code?: string} | null)?.code === 'P2002') {
        const message = 'Another guest of this event already uses that email.';
        return c.json({...problem('email_taken', message), fields: {email: message}}, 409);
      }
      throw err;
    }
  })

  .delete('/events/:eventId/guests/:rsvpId', ...guard, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    const rsvpId = c.req.param('rsvpId');
    if (!event || !isUuid(rsvpId)) return c.json(notFound('Guest'), 404);
    const result = await runBulk(db, publicBase(c.req.url), event, 'remove', [rsvpId]);
    const failure = result.failed[0];
    if (!failure) {
      await auditRemoval(db, c.var.viewer.id, event.id, 'remove', 1, 0);
      return c.json({ok: true});
    }
    if (failure.reason === 'not_found') return c.json(notFound('Guest'), 404);
    return c.json(problem('has_order', 'This guest has a payment on record, so they cannot be removed. Erase them instead.'), 409);
  })

  .get('/events/:eventId/guests', filterQuery, ...guard, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const {filter, before} = c.req.valid('query');
    const cursor = parseCursor(before);
    const where = guestWhere(event.id, filter);
    const paged: Prisma.RsvpWhereInput = cursor
      ? {AND: [where, {OR: [{createdAt: {lt: cursor.at}}, {createdAt: cursor.at, id: {lt: cursor.id}}]}]}
      : where;
    const [rows, counts] = await Promise.all([
      db.rsvp.findMany({
        where: paged,
        select: rowSelect,
        orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
        take: GUESTS_PAGE_SIZE + 1,
      }),
      // Status tiles for the first page only.
      cursor ? Promise.resolve(null) : db.rsvp.groupBy({by: ['status'], where: {eventId: event.id}, _count: {_all: true}}),
    ]);
    const page = rows.slice(0, GUESTS_PAGE_SIZE);
    const {guests, questions, types} = await enrich(db, event.id, page);
    const last = page.at(-1);
    return c.json({
      items: guests,
      questions,
      ticketTypes: types,
      statusCounts: counts ? Object.fromEntries(counts.map(g => [g.status, g._count._all])) : null,
      nextBefore: rows.length > GUESTS_PAGE_SIZE && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
    });
  })

  .get('/contacts/export.csv', contactsQuery, ...guard, async c => {
    const {q, consentOnly} = c.req.valid('query');
    const rows = await queryContacts(c.var.db, {q, consentOnly, after: '', limit: EXPORT_MAX_ROWS + 1});
    const truncated = rows.length > EXPORT_MAX_ROWS;
    const body: CsvValue[][] = rows.slice(0, EXPORT_MAX_ROWS).map(r => [
      r.name, r.email, r.eventCount, r.lastEvent.title, r.lastEvent.startAt, r.marketingConsent ? 'Yes' : 'No',
    ]);
    await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'contacts_exported', meta: {rows: body.length}});
    const header: CsvValue[] = ['Name', 'Email', 'Events', 'Last event', 'Last event date', 'Marketing consent'];
    return c.body(toCsv([header, ...body]), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': attachmentHeader(`contacts-${new Date().toISOString().slice(0, 10)}.csv`),
      'Cache-Control': 'no-store',
      'X-Export-Truncated': truncated ? '1' : '0',
    });
  })

  .get('/contacts', contactsQuery, ...guard, async c => {
    const {q, consentOnly, before} = c.req.valid('query');
    const rows = await queryContacts(c.var.db, {q, consentOnly, after: before, limit: CONTACTS_PAGE_SIZE + 1});
    const items = rows.slice(0, CONTACTS_PAGE_SIZE);
    return c.json({items, nextBefore: rows.length > CONTACTS_PAGE_SIZE ? items.at(-1)!.email : null});
  });

