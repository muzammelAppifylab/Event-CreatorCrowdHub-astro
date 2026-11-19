import {Hono, type Context} from 'hono';
import {validator} from 'hono/validator';

import {decideSeat, seatsFor, seatsRemaining} from '../../domain/capacity';
import {hashToken, newToken} from '../../domain/secureToken';
import {nextWaitlistPosition} from '../../domain/waitlist';
import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {attachmentHeader, csvExport, type CsvValue} from '../csv';
import {eventMailSelect, type GuestNotice, type MailEvent} from '../guest-mail';
import {notifyGuests} from '../guest-notices';
import {erasureHash, exportFilename, guestExportById} from '../privacy';
import {PERMISSIONS} from '../permissions';
import {requireEventRead} from '../guards-ext';
import {checkedInPayload, emitWebhook, emitWebhooks, rsvpPayload} from '../webhook-emit';
import {normalizeEmail} from './admin-invites';
import {isUuid, notFound, parsePageCursor} from '../validate';
import {escapeLike} from '../like';
import {keysetAfter} from '../../lib/text';
import {promoteWaitlist} from '../waitlist-promote';

/**
 * Guest management for event organisers (`site:event:manage`). Mounted by the
 * app at `/site-api/event-admin` (docs/ARCHITECTURE.md).
 *
 *   GET    /events/:eventId/guests?status&response&ticketTypeId&checkedIn&q&before   list (keyset, 50 a page)
 *   GET    /events/:eventId/guests/export.csv?(same filters)                         CSV (20,000 rows at most)
 *   POST   /events/:eventId/guests/bulk        {action: approve|decline|promote|remove|erase, rsvpIds}
 *   GET    /events/:eventId/guests/:rsvpId     detail (answers, timeline, questions)
 *   PATCH  /events/:eventId/guests/:rsvpId     edit name, email, plus-ones, consent, attended, checked in
 *   DELETE /events/:eventId/guests/:rsvpId     remove (frees the seat; refused when the guest has an order: erase)
 *   GET    /contacts?q&consent&repeat&attended&event&limit&before   everyone who RSVP'd to any event, once per email
 *   GET    /contacts/detail?key=<rsvp id>      one person: their profile and every RSVP they made
 *   GET    /contacts/export.csv?q&consent      the same as CSV
 *
 * A malformed or unknown event or guest id is a 404. Seat changes run in a
 * transaction that locks the event row, so two last-seat decisions cannot both win.
 * Emails to guests (approved, declined, promoted) are queued in the guest email outbox after the commit (the
 * request never sends them: audit M-21) and never fail the action; `emailsQueued` says how many.
 */

export const GUESTS_PAGE_SIZE = 50;
export const CONTACTS_PAGE_SIZE = 50;
export const BULK_MAX = 100;
/** Most rows one CSV export holds; the `X-Export-Truncated` header says when it was cut. */
export const EXPORT_MAX_ROWS = 20_000;
/** Rows read per query while an export is built (audit M-22): keyset pages, all read before the route answers. */
export const EXPORT_PAGE = 1000;

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
      {name: {contains: escapeLike(filter.q), mode: 'insensitive'}},
      {email: {contains: escapeLike(filter.q), mode: 'insensitive'}},
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
export const parseCursor = (raw: string): {at: Date; id: string} | null => parsePageCursor(raw);

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
  // Answers and the latest payment come with the row: one SQL query (relationJoins), never ids-then-rows.
  rsvpAnswers: {select: {questionId: true, value: true}, take: 100},
  ticketOrders: {select: {status: true}, orderBy: {createdAt: 'desc'}, take: 1},
} as const satisfies Prisma.RsvpSelect;

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

/** The event's questions and ticket types: read beside the guest rows (`Promise.all`), never after them. */
async function eventMeta(db: PrismaClient, eventId: string) {
  const [questions, types] = await Promise.all([
    db.rsvpQuestion.findMany({where: {eventId}, select: {id: true, label: true, type: true}, orderBy: [{sortOrder: 'asc'}, {id: 'asc'}], take: 50}),
    db.ticketType.findMany({
      where: {eventId},
      select: {id: true, name: true, priceCents: true, currency: true},
      orderBy: [{sortOrder: 'asc'}, {id: 'asc'}],
      take: 50,
    }),
  ]);
  return {questions, types};
}

type EventMeta = Awaited<ReturnType<typeof eventMeta>>;

/** Rows (which carry their answers and latest payment) as the screen's guests. Pure. */
function enrich(rows: RsvpRow[], {questions, types}: EventMeta) {
  const names = new Map(types.map(t => [t.id, t.name]));
  const answersOf = (r: RsvpRow) => {
    const own: Record<string, AnswerValue> = {};
    for (const a of r.rsvpAnswers) own[a.questionId] = a.value as AnswerValue;
    return own;
  };
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
    paymentStatus: r.ticketOrders[0]?.status ?? null,
    marketingConsent: r.marketingConsent && r.consentConfirmedAt !== null,
    checkedInAt: r.checkedInAt?.toISOString() ?? null,
    attended: r.attended,
    waitlistPosition: r.waitlistPosition,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
    answers: answersOf(r),
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

function detailOf(row: RsvpRow, meta: EventMeta) {
  const {guests, questions} = enrich([row], meta);
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

async function waitlistOf(tx: Tx, eventId: string) {
  return tx.rsvp.findMany({
    where: {eventId, status: 'waitlisted'},
    select: {id: true, seats: true, waitlistPosition: true, createdAt: true, claimExpiresAt: true},
    orderBy: [{waitlistPosition: 'asc'}, {createdAt: 'asc'}],
    take: 5000,
  });
}

type PromoteResult = {notices: GuestNotice[]; succeeded: string[]; failed: {rsvpId: string; reason: string}[]};

/**
 * Hands free seats to waitlisted guests, first in line first. `only` limits it to chosen guests
 * (the host's "promote"); without it every guest who fits is promoted (a seat was released).
 * The decision and the set-based writes are the shared `promoteWaitlist`
 * (src/server/waitlist-promote.ts): free events confirm, paid events send a claim offer, seats and
 * ticket quantity under other guests' outstanding claims stay held, and the line is renumbered in
 * one statement. Here only the guests' mail rows are read back for the notices.
 */
async function promoteFromWaitlist(tx: Tx, event: MailEvent, now: Date, only?: Set<string>): Promise<PromoteResult> {
  const {promotions, failed} = await promoteWaitlist(tx, event, now, {only});
  const ids = promotions.map(p => p.rsvpId);
  const offers = new Map(promotions.flatMap(p => (p.kind === 'offer_claim' ? [[p.rsvpId, p.claimExpiresAt] as const] : [])));
  const notices: GuestNotice[] = (await mailGuests(tx, event.id, ids)).map(guest => {
    const claimExpiresAt = offers.get(guest.id);
    return claimExpiresAt ? {kind: 'waitlist_offer', guest, claimExpiresAt} : {kind: 'confirmation', guest};
  });
  return {
    notices,
    succeeded: ids,
    // A sold-out ticket type reads as "no seats left" in the dashboard's summary.
    failed: failed.map(f => (f.reason === 'ticket_sold_out' ? {rsvpId: f.rsvpId, reason: 'event_full: ticket sold out'} : f)),
  };
}

/* ── Host decisions, set-based ──────────────────────────────────────── */

/**
 * Each action reads the chosen guests in ONE query, decides in memory (in the order the host
 * picked them, so the order still decides who gets the last seat), then writes each group in one
 * statement. Everything runs inside one transaction holding the event's lock (`withEventLock`).
 */

const targetSelect = {
  id: true,
  email: true,
  status: true,
  response: true,
  seats: true,
  ticketType: {select: {priceCents: true}},
  _count: {select: {ticketOrders: true}},
} as const;

type Target = Prisma.RsvpGetPayload<{select: typeof targetSelect}>;
type Removed = {id: string; status: string; response: string};
type Outcome = Omit<BulkResult, 'emailsQueued'> & {notices: GuestNotice[]; removed: Removed[]};

/** Why `action` can't be applied to this guest, or null. Pure. */
function refusal(action: BulkAction, event: MailEvent, row: Target | undefined): string | null {
  if (!row) return 'not_found';
  if (action === 'approve' || action === 'decline') {
    if (row.status !== 'pending') return 'not_pending';
    if (action === 'approve' && event.status === 'cancelled') return 'event_cancelled';
  }
  // Orders keep payment history: those guests are erased (anonymised) instead.
  if (action === 'remove' && row._count.ticketOrders > 0) return 'has_order: use erase';
  // Mid-checkout: a payment could still complete and re-seat the row.
  if (action === 'erase' && row.status === 'awaiting_payment') return 'checkout_in_progress';
  return null;
}

/** Mail rows for `ids`, in that order (one query). */
async function mailGuests(tx: Tx, eventId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx.rsvp.findMany({where: {id: {in: ids}, eventId}, select: mailGuestSelect});
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

async function approveAll(tx: Tx, event: MailEvent, rows: Target[], now: Date, out: Outcome) {
  const [taken, waitlist] = rows.some(r => r.response === 'going')
    ? await Promise.all([seatsTaken(tx, event.id), waitlistOf(tx, event.id)])
    : [0, []];
  let seats = taken;
  let nextPosition = nextWaitlistPosition(waitlist);
  const confirmed: string[] = [];
  const awaiting: string[] = [];
  const waitlisted: {id: string; position: number}[] = [];
  for (const r of rows) {
    // A maybe holds no seat but is confirmed, so it still gets reminders.
    if (r.response !== 'going') {
      confirmed.push(r.id);
      continue;
    }
    const decision = decideSeat(
      {capacity: event.capacity, seatsTaken: seats, waitlistEnabled: event.waitlistEnabled, approvalRequired: false, rsvpDeadline: null, now},
      r.seats
    );
    if (decision.kind === 'confirm') {
      seats += r.seats;
      // Approved on a paid ticket: the seat is held until the guest pays.
      (r.ticketType && r.ticketType.priceCents > 0 ? awaiting : confirmed).push(r.id);
    } else if (decision.kind === 'waitlist') {
      waitlisted.push({id: r.id, position: nextPosition++});
    } else {
      out.failed.push({rsvpId: r.id, reason: 'event_full'});
    }
  }
  const seated = {confirmedAt: now, waitlistPosition: null, claimExpiresAt: null};
  if (confirmed.length) await tx.rsvp.updateMany({where: {id: {in: confirmed}, eventId: event.id}, data: {status: 'confirmed', ...seated}});
  if (awaiting.length) await tx.rsvp.updateMany({where: {id: {in: awaiting}, eventId: event.id}, data: {status: 'awaiting_payment', ...seated}});
  if (waitlisted.length) {
    await tx.$executeRaw`
      UPDATE rsvps r SET status = 'waitlisted', waitlist_position = v.pos, confirmed_at = NULL, updated_at = now()
      FROM unnest(${waitlisted.map(w => w.id)}::uuid[], ${waitlisted.map(w => w.position)}::int[]) AS v(id, pos)
      WHERE r.id = v.id AND r.event_id = ${event.id}::uuid`;
  }
  const done = new Set([...confirmed, ...awaiting, ...waitlisted.map(w => w.id)]);
  const ids = rows.map(r => r.id).filter(id => done.has(id));
  out.succeeded.push(...ids);
  for (const guest of await mailGuests(tx, event.id, ids)) out.notices.push({kind: 'confirmation', guest});
}

async function declineAll(tx: Tx, event: MailEvent, rows: Target[], out: Outcome) {
  const ids = rows.map(r => r.id);
  await tx.rsvp.updateMany({
    where: {id: {in: ids}, eventId: event.id, status: 'pending'},
    data: {status: 'declined', waitlistPosition: null, confirmedAt: null},
  });
  out.succeeded.push(...ids);
  for (const guest of await mailGuests(tx, event.id, ids)) out.notices.push({kind: 'declined', guest});
}

/**
 * Remove deletes the RSVPs; erase anonymises them in place (the order rows and amounts stay for
 * accounting; refunds remain a separate decision), and the manage token becomes the hash of a value
 * nobody sees, so old links stop working. Either way the freed seats then go to the waitlist, once.
 */
async function removeAll(tx: Tx, event: MailEvent, action: 'remove' | 'erase', rows: Target[], now: Date, out: Outcome) {
  const ids = rows.map(r => r.id);
  const emails = rows.map(r => r.email);
  // Erase also clears free-text poll answers, as the guest's own erase does (src/server/privacy.ts).
  await tx.pollVote.updateMany({where: {rsvpId: {in: ids}}, data: action === 'erase' ? {rsvpId: null, textValue: null} : {rsvpId: null}});
  if (action === 'remove') {
    await tx.rsvp.deleteMany({where: {id: {in: ids}, eventId: event.id}});
  } else {
    await tx.rsvpAnswer.deleteMany({where: {rsvpId: {in: ids}}});
    await tx.messageDelivery.deleteMany({where: {rsvpId: {in: ids}}});
    const tokens = ids.map(() => hashToken(newToken()));
    await tx.$executeRaw`
      UPDATE rsvps r SET name = 'Removed guest', email = 'removed+' || r.id::text || '@invalid', manage_token = v.token,
        marketing_consent = false, consent_confirmed_at = NULL, status = 'cancelled', waitlist_position = NULL,
        claim_expires_at = NULL, invite_id = NULL, utm_source = NULL, updated_at = now()
      FROM unnest(${ids}::uuid[], ${tokens}::text[]) AS v(id, token)
      WHERE r.id = v.id AND r.event_id = ${event.id}::uuid`;
    // As `eraseRsvp` (src/server/privacy.ts): the platform's payment record keeps neither the address
    // nor the RSVP id, and a hashed-address log lets the erasure be re-applied after a restore.
    await tx.$executeRaw`
      UPDATE orders SET email = NULL, metadata = CASE WHEN metadata ? 'rsvpId' THEN metadata - 'rsvpId' ELSE metadata END, updated_at = ${now}
      WHERE checkout_id IN (SELECT checkout_id FROM ticket_orders WHERE rsvp_id IN (SELECT unnest(${ids}::uuid[])))
        AND (email IS NOT NULL OR metadata ? 'rsvpId')`;
    const hashes = [...new Set(emails.filter(e => !e.endsWith('@invalid')).map(erasureHash))];
    if (hashes.length) {
      await tx.$executeRaw`
        INSERT INTO guest_erasures (email_hash, event_id, erased_at)
        SELECT h, ${event.id}::uuid, ${now} FROM unnest(${hashes}::text[]) AS h
        ON CONFLICT (email_hash, event_id) DO UPDATE SET erased_at = EXCLUDED.erased_at`;
    }
  }
  await tx.invite.deleteMany({where: {eventId: event.id, email: {in: emails}}});
  out.succeeded.push(...ids);
  out.removed.push(...rows.map(r => ({id: r.id, status: r.status, response: r.response})));
  // A held seat or a waitlist place was freed: pass it on.
  const freed = rows.some(r => (SEAT_HOLDERS.includes(r.status as Status) && r.response === 'going') || r.status === 'waitlisted');
  if (freed && event.status !== 'cancelled') out.notices.push(...(await promoteFromWaitlist(tx, event, now)).notices);
}

async function applyBulk(tx: Tx, event: MailEvent, action: Exclude<BulkAction, 'promote'>, ids: string[], now: Date): Promise<Outcome> {
  const out: Outcome = {action, succeeded: [], failed: [], notices: [], removed: []};
  const found = await tx.rsvp.findMany({where: {id: {in: ids}, eventId: event.id}, select: targetSelect});
  const byId = new Map(found.map(r => [r.id, r]));
  const ok: Target[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    const reason = refusal(action, event, row);
    if (reason) out.failed.push({rsvpId: id, reason});
    else ok.push(row!);
  }
  if (!ok.length) return out;
  if (action === 'approve') await approveAll(tx, event, ok, now, out);
  else if (action === 'decline') await declineAll(tx, event, ok, out);
  else await removeAll(tx, event, action, ok, now, out);
  return out;
}

/** Most webhooks one request may queue: a removal can promote a long waitlist. */
export const ADMIN_EMIT_CAP = 200;

type WebhookChange = {name: 'rsvp.updated' | 'rsvp.removed'; payload: ReturnType<typeof rsvpPayload>};

/**
 * One webhook per guest whose state the host changed: `rsvp.updated` for an approval, decline or a
 * waitlist promotion that confirmed a seat (an offer alone changes no status), `rsvp.removed` for
 * a deleted or erased guest (payload: their last status). Bounded; never throws into the request.
 */
export function webhookChangesFor(eventId: string, notices: GuestNotice[], removed: {id: string; status: string; response: string}[] = []): WebhookChange[] {
  const changes: WebhookChange[] = [];
  for (const r of removed) changes.push({name: 'rsvp.removed', payload: rsvpPayload({...r, eventId})});
  for (const n of notices) {
    if (n.kind === 'waitlist_offer') continue;
    changes.push({name: 'rsvp.updated', payload: rsvpPayload({id: n.guest.id, eventId, status: n.guest.status, response: n.guest.response})});
  }
  return changes.slice(0, ADMIN_EMIT_CAP);
}

function emitGuestChanges(c: Context | null, db: PrismaClient, changes: WebhookChange[]) {
  try {
    emitWebhooks(c, db, changes.map(ch => ({event: ch.name, payload: ch.payload}))); // one job for the whole bulk action
  } catch {
    // A webhook problem never fails the host's action.
  }
}

type BulkResult = {action: BulkAction; succeeded: string[]; failed: {rsvpId: string; reason: string}[]; emailsQueued: number};

/** One outcome per id; a refused guest never aborts the batch. Emails are queued after the commit (outbox). */
async function runBulk(db: PrismaClient, event: MailEvent, action: BulkAction, rawIds: string[], c: Context | null = null): Promise<BulkResult> {
  const ids = [...new Set(rawIds)];
  const result: BulkResult = {action, succeeded: [], failed: [], emailsQueued: 0};
  const notices: GuestNotice[] = [];
  const removedGuests: Removed[] = [];
  const now = new Date();

  if (action === 'promote' && event.status === 'cancelled') {
    result.failed.push(...ids.map(rsvpId => ({rsvpId, reason: 'event_cancelled'})));
    return result;
  }
  try {
    if (action === 'promote') {
      const promoted = await withEventLock(db, event.id, (tx, locked) => promoteFromWaitlist(tx, locked, now, new Set(ids)));
      result.succeeded.push(...promoted.succeeded);
      result.failed.push(...promoted.failed);
      notices.push(...promoted.notices);
    } else {
      // One transaction holding the event lock; the order of `ids` decides who gets the last seat.
      const out = await withEventLock(db, event.id, (tx, locked) => applyBulk(tx, locked, action, ids, now));
      result.succeeded.push(...out.succeeded);
      result.failed.push(...out.failed);
      // Removed and erased guests are not emailed; promotions their seats trigger are.
      notices.push(...out.notices);
      removedGuests.push(...out.removed);
    }
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    result.failed.push(...ids.map(rsvpId => ({rsvpId, reason: err.reason})));
    return result;
  }
  result.emailsQueued = await notifyGuests(db, event, notices);
  emitGuestChanges(c, db, webhookChangesFor(event.id, notices, removedGuests));
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
  /** The newest RSVP's id: the contact's opaque key in URLs (never the email address). */
  key: string;
  name: string;
  event_count: number;
  last_event_id: string;
  last_event_title: string;
  last_event_start_at: Date | string;
  marketing_consent: boolean;
  attended_count: number;
  first_seen_at: Date | string;
};

type ContactOpts = {
  q: string;
  consentOnly: boolean;
  repeatOnly: boolean;
  attendedOnly: boolean;
  eventId: string;
  after: string;
  limit: number;
};

/**
 * A contact's consent (audit M-26): their latest RSVP opted in AND confirmed, and no RSVP of theirs
 * unsubscribed (`unsubscribed_at`, set on every RSVP of the address; a fresh confirmed opt-in clears it).
 */
const CONTACT_CONSENT = Prisma.sql`((array_agg((r.marketing_consent AND r.consent_confirmed_at IS NOT NULL) ORDER BY r.created_at DESC, r.id DESC))[1] AND bool_and(r.unsubscribed_at IS NULL))`;

/**
 * Contacts, one per address, in address order. `rsvps.email` is always lower case (CHECK
 * `rsvps_email_lower`), so it groups, orders and pages by the plain column and the keyset filter
 * sits in WHERE, where `rsvps_email_idx` serves it (audit L-17).
 */
async function queryContacts(db: PrismaClient, opts: ContactOpts) {
  const having: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (opts.repeatOnly) having.push(Prisma.sql`count(DISTINCT r.event_id) >= 2`);
  if (opts.attendedOnly) having.push(Prisma.sql`bool_or(r.attended IS TRUE OR r.checked_in_at IS NOT NULL)`);
  if (opts.eventId) having.push(Prisma.sql`bool_or(r.event_id = ${opts.eventId}::uuid)`);
  if (opts.q) {
    const pattern = likePattern(opts.q);
    having.push(Prisma.sql`bool_or(r.email ILIKE ${pattern} OR r.name ILIKE ${pattern})`);
  }
  if (opts.consentOnly) having.push(CONTACT_CONSENT);
  const rows = await db.$queryRaw<ContactRaw[]>`
    SELECT r.email AS email,
      (array_agg(r.id ORDER BY r.created_at DESC, r.id DESC))[1]::text AS key,
      (array_agg(r.name ORDER BY r.created_at DESC, r.id DESC))[1] AS name,
      count(DISTINCT r.event_id)::int AS event_count,
      (array_agg(e.id ORDER BY e.start_at DESC))[1]::text AS last_event_id,
      (array_agg(e.title ORDER BY e.start_at DESC))[1] AS last_event_title,
      (array_agg(e.start_at ORDER BY e.start_at DESC))[1] AS last_event_start_at,
      ${CONTACT_CONSENT} AS marketing_consent,
      (count(DISTINCT r.event_id) FILTER (WHERE r.attended IS TRUE OR r.checked_in_at IS NOT NULL))::int AS attended_count,
      min(r.created_at) AS first_seen_at
    FROM rsvps r
    INNER JOIN events e ON e.id = r.event_id
    WHERE e.deleted_at IS NULL AND r.email NOT LIKE 'removed+%@invalid' AND r.email > ${opts.after}
    GROUP BY r.email
    HAVING ${Prisma.join(having, ' AND ')}
    ORDER BY r.email ASC
    LIMIT ${opts.limit}`;
  return rows.map(r => ({
    email: r.email,
    key: r.key,
    name: r.name,
    eventCount: r.event_count,
    lastEvent: {id: r.last_event_id, title: r.last_event_title, startAt: new Date(r.last_event_start_at).toISOString()},
    marketingConsent: r.marketing_consent,
    attendedCount: r.attended_count,
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
  }));
}

const CONTACT_PAGE_SIZES = [25, 50, 100] as const;

const contactsQuery = validator('query', value => {
  const limit = Number(value.limit);
  return {
    q: typeof value.q === 'string' ? value.q.trim().slice(0, 120) : '',
    consentOnly: value.consent === 'yes',
    repeatOnly: value.repeat === 'yes',
    attendedOnly: value.attended === 'yes',
    eventId: isUuid(value.event) ? value.event.toLowerCase() : '',
    before: typeof value.before === 'string' ? value.before.toLowerCase().slice(0, 254) : '',
    limit: (CONTACT_PAGE_SIZES as readonly number[]).includes(limit) ? limit : CONTACTS_PAGE_SIZE,
  };
});

/** `?key=<rsvp uuid>`: any RSVP of the person (the list sends the newest). Never the email: it would sit in the URL. */
const contactDetailQuery = validator('query', value => ({
  key: isUuid(value.key) ? value.key.toLowerCase() : '',
}));

const auditRemoval = (db: PrismaClient, actor: number | null | undefined, eventId: string, action: 'remove' | 'erase', done: number, failed: number) =>
  audit(db, {actorUserId: actor ?? null, action: action === 'erase' ? 'guests_erased' : 'guests_removed', target: ['event', eventId], meta: {done, failed}});

/**
 * The guest CSV export's pages (audit M-22): EXPORT_PAGE rows per query, keyset on (created_at desc, id desc),
 * at most `max + 1` rows in all (the one past the cap marks the export truncated). The cursor is the last
 * row's VALUES (`keysetAfter`, as the guest list pages), not Prisma's `cursor: {id}`: a guest removed while
 * the export runs, the one that ended a page included, never cuts the export short.
 */
export async function* guestExportPages(db: PrismaClient, where: Prisma.RsvpWhereInput, max = EXPORT_MAX_ROWS): AsyncGenerator<RsvpRow[]> {
  let read = 0;
  let after: {at: Date; id: string} | null = null;
  while (read <= max) {
    const take = Math.min(EXPORT_PAGE, max + 1 - read);
    const rows: RsvpRow[] = await db.rsvp.findMany({
      where: after ? {AND: [where, keysetAfter('createdAt', 'desc', after)]} : where,
      select: rowSelect,
      orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
      take,
    });
    if (rows.length === 0) return;
    read += rows.length;
    const last = rows[rows.length - 1]!;
    after = {at: last.createdAt, id: last.id};
    yield rows;
    if (rows.length < take) return;
  }
}

/* ── Routes ─────────────────────────────────────────────────────────── */

const guard = [withViewer, requireAuth, requirePermission(MANAGE), withDb] as const;
/** Reads (lists and one guest): see-only admins too. Exports and writes stay on `guard`. */
const readGuard = [withViewer, requireAuth, requireEventRead(), withDb] as const;

export const adminGuestRoutes = new Hono()
  // Registered before `/:rsvpId` so "export.csv" is not read as an id.
  .get('/events/:eventId/guests/export.csv', filterQuery, ...guard, async c => {
    const {db} = c.var;
    const eventId = c.req.param('eventId');
    if (!isUuid(eventId)) return notFound(c, 'Event');
    const where: Prisma.RsvpWhereInput = {...guestWhere(eventId, c.req.valid('query').filter), event: {deletedAt: null}};
    // The event, its questions and ticket types, in one round trip.
    const [event, meta] = await Promise.all([loadEvent(db, eventId), eventMeta(db, eventId)]);
    if (!event) return notFound(c, 'Event');
    const questions = meta.questions;
    const header: CsvValue[] = [
      'Name', 'Email', 'Response', 'Status', 'Seats', 'Plus-ones', 'Ticket code', 'Ticket type', 'Payment status',
      'Marketing consent', 'Checked in at', 'Attended', 'Source', 'RSVP date',
      ...questions.map(q => q.label),
    ];
    // Audit M-22: keyset pages (`guestExportPages`), turned into text page by page. Every page is read before
    // this route answers (`csvExport`), and one row past the cap marks it truncated.
    async function* pages(): AsyncGenerator<CsvValue[][]> {
      for await (const rows of guestExportPages(db, where)) {
        yield enrich(rows, meta).guests.map(g => [
          g.name, g.email, g.response, g.status, g.seats, g.plusOnes, g.ticketCode, g.ticketTypeName, g.paymentStatus,
          g.marketingConsent ? 'Yes' : 'No', g.checkedInAt, g.attended === null ? '' : g.attended ? 'Yes' : 'No', g.source, g.createdAt,
          ...questions.map(q => answerText(g.answers[q.id])),
        ]);
      }
    }
    const {csv, rows, truncated} = await csvExport(header, pages(), EXPORT_MAX_ROWS);
    await audit(db, {actorUserId: c.var.viewer.id, action: 'guests_exported', target: ['event', eventId], meta: {rows, truncated}});
    const day = new Date().toISOString().slice(0, 10);
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': attachmentHeader(`guests-${event.slug}-${day}.csv`),
      'Cache-Control': 'no-store',
      'X-Export-Truncated': truncated ? '1' : '0',
    });
  })

  .post('/events/:eventId/guests/bulk', bulkBody, ...guard, async c => {
    const event = await loadEvent(c.var.db, c.req.param('eventId'));
    if (!event) return notFound(c, 'Event');
    const {action, rsvpIds} = c.req.valid('json');
    const result = await runBulk(c.var.db, event, action, rsvpIds, c);
    if (action === 'remove' || action === 'erase') await auditRemoval(c.var.db, c.var.viewer.id, event.id, action, result.succeeded.length, result.failed.length);
    return c.json(result);
  })

  .get('/events/:eventId/guests/:rsvpId', ...readGuard, async c => {
    const {db} = c.var;
    const eventId = c.req.param('eventId');
    const rsvpId = c.req.param('rsvpId');
    if (!isUuid(eventId) || !isUuid(rsvpId)) return notFound(c, 'Guest');
    // The guest is read only through its (not deleted) event: another event's id is a 404.
    const [row, meta] = await Promise.all([
      db.rsvp.findFirst({where: {id: rsvpId, eventId, event: {deletedAt: null}}, select: rowSelect}),
      eventMeta(db, eventId),
    ]);
    return row ? c.json(detailOf(row, meta)) : notFound(c, 'Guest');
  })

  // Everything we hold about one guest (the guest's own export document), for the organiser. Audited.
  .get('/events/:eventId/guests/:rsvpId/data', ...guard, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    const rsvpId = c.req.param('rsvpId');
    if (!event || !isUuid(rsvpId)) return notFound(c, 'Guest');
    const now = new Date();
    const doc = await guestExportById(db, event.id, rsvpId, now);
    if (!doc) return notFound(c, 'Guest');
    await audit(db, {actorUserId: c.var.viewer.id, action: 'guest_data_exported', target: ['event', event.id], meta: {rsvpId}});
    return new Response(JSON.stringify(doc, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': attachmentHeader(exportFilename(event.slug, now)),
        'Cache-Control': 'no-store',
      },
    });
  })

  .patch('/events/:eventId/guests/:rsvpId', patchBody, ...guard, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    const rsvpId = c.req.param('rsvpId');
    if (!event || !isUuid(rsvpId)) return notFound(c, 'Guest');
    const patch = c.req.valid('json');
    if (patch.plusOnes !== undefined && patch.plusOnes > event.maxPlusOnes) {
      const message = `This event allows up to ${event.maxPlusOnes} plus-one${event.maxPlusOnes === 1 ? '' : 's'}.`;
      return c.json({...problem('invalid_input', message), fields: {plusOnes: message}}, 422);
    }
    const now = new Date();
    try {
      const notices: GuestNotice[] = [];
      let newlyCheckedIn = false;
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
          newlyCheckedIn = patch.checkedIn && current.checkedInAt === null;
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
      await notifyGuests(db, event, notices);
      emitGuestChanges(c, db, webhookChangesFor(event.id, notices));
      if (newlyCheckedIn) emitWebhook(c, db, 'guest.checked_in', checkedInPayload({id: row.id, eventId: event.id, checkedInAt: now}));
      return c.json(detailOf(row, await eventMeta(db, event.id)));
    } catch (err) {
      if (err instanceof Refused) {
        if (err.reason === 'not_found') return notFound(c, 'Guest');
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
    if (!event || !isUuid(rsvpId)) return notFound(c, 'Guest');
    const result = await runBulk(db, event, 'remove', [rsvpId], c);
    const failure = result.failed[0];
    if (!failure) {
      await auditRemoval(db, c.var.viewer.id, event.id, 'remove', 1, 0);
      return c.json({ok: true});
    }
    if (failure.reason === 'not_found') return notFound(c, 'Guest');
    return c.json(problem('has_order', 'This guest has a payment on record, so they cannot be removed. Erase them instead.'), 409);
  })

  .get('/events/:eventId/guests', filterQuery, ...readGuard, async c => {
    const {db} = c.var;
    const eventId = c.req.param('eventId');
    if (!isUuid(eventId)) return notFound(c, 'Event');
    const {filter, before} = c.req.valid('query');
    const cursor = parseCursor(before);
    const where = guestWhere(eventId, filter);
    const paged: Prisma.RsvpWhereInput = cursor
      ? {AND: [where, keysetAfter('createdAt', 'desc', cursor)]}
      : where;
    // One round trip: the event, the page (with answers and payments), the tiles and the questions.
    const [event, rows, counts, meta] = await Promise.all([
      loadEvent(db, eventId),
      db.rsvp.findMany({
        where: paged,
        select: rowSelect,
        orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
        take: GUESTS_PAGE_SIZE + 1,
      }),
      // Status tiles for the first page only.
      cursor ? Promise.resolve(null) : db.rsvp.groupBy({by: ['status'], where: {eventId}, _count: {_all: true}}),
      eventMeta(db, eventId),
    ]);
    if (!event) return notFound(c, 'Event');
    const page = rows.slice(0, GUESTS_PAGE_SIZE);
    const {guests, questions, types} = enrich(page, meta);
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
    const {q, consentOnly, repeatOnly, attendedOnly, eventId} = c.req.valid('query');
    const {db} = c.var;
    const filter = {q, consentOnly, repeatOnly, attendedOnly, eventId};
    // Audit M-22: EXPORT_PAGE contacts per query, keyset on the address, turned into text page by page.
    // Every page is read before this route answers (`csvExport`), and one row past the cap marks it truncated.
    async function* pages(): AsyncGenerator<CsvValue[][]> {
      let read = 0;
      let after = '';
      while (read <= EXPORT_MAX_ROWS) {
        const limit = Math.min(EXPORT_PAGE, EXPORT_MAX_ROWS + 1 - read);
        const rows = await queryContacts(db, {...filter, after, limit});
        if (rows.length === 0) return;
        read += rows.length;
        after = rows[rows.length - 1]!.email;
        yield rows.map(r => [
          r.name, r.email, r.eventCount, r.attendedCount, r.lastEvent.title, r.lastEvent.startAt, r.firstSeenAt, r.marketingConsent ? 'Yes' : 'No',
        ]);
        if (rows.length < limit) return;
      }
    }
    const header: CsvValue[] = ['Name', 'Email', 'Events', 'Attended', 'Last event', 'Last event date', 'First seen', 'Marketing consent'];
    const {csv, rows, truncated} = await csvExport(header, pages(), EXPORT_MAX_ROWS);
    await audit(db, {actorUserId: c.var.viewer.id, action: 'contacts_exported', meta: {rows, truncated}});
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': attachmentHeader(`contacts-${new Date().toISOString().slice(0, 10)}.csv`),
      'Cache-Control': 'no-store',
      'X-Export-Truncated': truncated ? '1' : '0',
    });
  })

  .get('/contacts', contactsQuery, ...readGuard, async c => {
    const {limit, before, ...filter} = c.req.valid('query');
    const rows = await queryContacts(c.var.db, {...filter, after: before, limit: limit + 1});
    const items = rows.slice(0, limit);
    return c.json({items, nextBefore: rows.length > limit ? items.at(-1)!.email : null});
  })

  // One person across every event: who they are, and each RSVP they made, newest first.
  // Keyed by one of their RSVP ids (never the address in the URL); see-only admins may read it.
  .get('/contacts/detail', contactDetailQuery, ...readGuard, async c => {
    const {key} = c.req.valid('query');
    if (!key) return notFound(c, 'Contact');
    const anchor = await c.var.db.rsvp.findFirst({where: {id: key, event: {deletedAt: null}}, select: {email: true}});
    const email = anchor?.email;
    if (!email || email.startsWith('removed+')) return notFound(c, 'Contact');
    const [rsvps, unsubscribed] = await Promise.all([
      c.var.db.rsvp.findMany({
        where: {email, event: {deletedAt: null}},
        select: {
          id: true, name: true, response: true, status: true, seats: true, plusOnes: true, ticketCode: true, checkedInAt: true,
          attended: true, source: true, createdAt: true, marketingConsent: true, consentConfirmedAt: true,
          event: {select: {id: true, title: true, startAt: true, timezone: true}},
        },
        orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
        take: 200,
      }),
      // An unsubscribe on ANY of their RSVPs, not only the newest 200 shown (the list's bool_and).
      c.var.db.rsvp.findFirst({
        where: {email, event: {deletedAt: null}, unsubscribedAt: {not: null}},
        select: {id: true},
      }),
    ]);
    const latest = rsvps[0];
    if (!latest) return notFound(c, 'Contact');
    const eventIds = new Set(rsvps.map(r => r.event.id));
    const attendedIds = new Set(rsvps.filter(r => r.attended === true || r.checkedInAt).map(r => r.event.id));
    return c.json({
      contact: {
        email,
        name: latest.name,
        eventCount: eventIds.size,
        attendedCount: attendedIds.size,
        firstSeenAt: rsvps.at(-1)!.createdAt.toISOString(),
        // The same rule as the list (CONTACT_CONSENT, audit M-26): an unsubscribe on any RSVP means out.
        marketingConsent: Boolean(latest.marketingConsent && latest.consentConfirmedAt) && unsubscribed === null,
      },
      rsvps: rsvps.map(r => ({
        id: r.id,
        eventId: r.event.id,
        eventTitle: r.event.title,
        startAt: r.event.startAt.toISOString(),
        timezone: r.event.timezone,
        response: r.response,
        status: r.status,
        seats: r.seats,
        plusOnes: r.plusOnes,
        ticketCode: r.ticketCode,
        checkedInAt: r.checkedInAt?.toISOString() ?? null,
        attended: r.attended,
        source: r.source,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  });

