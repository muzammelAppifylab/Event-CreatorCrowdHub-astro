import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import type {Prisma, PrismaClient} from '../../generated/prisma/client';
import {can, forbidden, problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import type {Viewer} from '../../platform/types';
import {PERMISSIONS} from '../permissions';
import {checkedInPayload, emitWebhook} from '../webhook-emit';
import {escapeLike} from '../like';

/**
 * Door check-in and online attendance (ported from CreatorCrowdHub, US-27 / US-28).
 * Mount: `.route('/checkin', adminCheckinRoutes)`.
 *
 * Holders of `site:event:checkin` OR `site:event:manage` (a `checkin_staff` role holds only the first):
 *   GET  /checkin/events                      events to check guests into (picker)
 *   GET  /checkin/events/:eventId?q=          the door list (<= 200, by name) + counts
 *   GET  /checkin/codes/:code                 one guest by ticket code
 *   POST /checkin/codes/:code {checkedIn}     check in / undo
 * Holders of `site:event:manage` only (names AND emails):
 *   GET  /checkin/events/:eventId/attendees?before=   confirmed guests, keyset by id
 *   POST /checkin/events/:eventId/attendance {rsvpIds, attended}
 *   POST /checkin/events/:eventId/attendance/import {emails}  match an attendee export by email
 *
 * Door staff see names, ticket codes, seats, status and check-in time only: never an email, and the
 * search matches name and code only, so the box cannot confirm who is on the list. Counts come from
 * ONE aggregate scoped to the event (rsvps_event idx); the list is capped, search narrows it.
 */

export const DOOR_LIST_LIMIT = 200;
const EVENT_LIMIT = 50;
const ATTENDEE_PAGE = 50;
const MAX_IDS = 200;
const MAX_EMAILS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ticket codes are 8 characters; allow slack for hand-typed ones. */
const CODE_SHAPE = /^[A-Z0-9]{4,12}$/;
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export const normalizeTicketCode = (raw: string) => raw.trim().toUpperCase();

/** Door-visible shape of a guest: never the email, the RSVP id or the manage token. */
const guestSelect = {name: true, ticketCode: true, seats: true, status: true, checkedInAt: true} as const;
type GuestRow = Prisma.RsvpGetPayload<{select: typeof guestSelect}>;

export const toDoorGuest = (r: GuestRow) => ({
  name: r.name,
  ticketCode: r.ticketCode,
  seats: r.seats,
  status: r.status,
  checkedInAt: r.checkedInAt?.toISOString() ?? null,
});

const eventSelect = {id: true, title: true, startAt: true, endAt: true, timezone: true, format: true} as const;
type EventRow = Prisma.EventGetPayload<{select: typeof eventSelect}>;

const toEvent = (e: EventRow) => ({
  ...e,
  startAt: e.startAt.toISOString(),
  endAt: e.endAt.toISOString(),
});

/** Door work only makes sense for live, published events. */
const doorEvent = {status: 'published', deletedAt: null} as const;

/** Either capability opens the door screens: managers may also work the door. */
const doorAccess = createMiddleware<{Variables: {viewer: Viewer}}>(async (c, next) => {
  if (!(await can(c, PERMISSIONS.EVENT_CHECKIN)) && !(await can(c as never, PERMISSIONS.EVENT_MANAGE))) return forbidden(c);
  await next();
});

type Counts = {checkedInSeats: number; expectedSeats: number; checkedInGuests: number; expectedGuests: number};

async function doorCounts(db: PrismaClient, eventId: string): Promise<Counts> {
  const rows = await db.$queryRaw<Counts[]>`
    select
      coalesce(sum(seats) filter (where checked_in_at is not null), 0)::int as "checkedInSeats",
      coalesce(sum(seats) filter (where response = 'going' and status = 'confirmed'), 0)::int as "expectedSeats",
      (count(*) filter (where checked_in_at is not null))::int as "checkedInGuests",
      (count(*) filter (where response = 'going' and status = 'confirmed'))::int as "expectedGuests"
    from rsvps
    where event_id = ${eventId}::uuid`;
  return rows[0] ?? {checkedInSeats: 0, expectedSeats: 0, checkedInGuests: 0, expectedGuests: 0};
}

const eventParam = validator('param', (value, c) => {
  const id = typeof value.eventId === 'string' ? value.eventId : '';
  if (!UUID.test(id)) return c.json(problem('not_found', 'Event not found.'), 404);
  return {eventId: id.toLowerCase()};
});

const codeParam = validator('param', (value, c) => {
  const code = normalizeTicketCode(typeof value.code === 'string' ? value.code : '');
  // A malformed code looks exactly like an unknown one.
  if (!CODE_SHAPE.test(code)) return c.json(problem('not_found', 'No guest has that ticket code.'), 404);
  return {code};
});

const searchQuery = validator('query', value => ({
  q: typeof value.q === 'string' ? value.q.trim().slice(0, 120) : '',
}));

const toggleBody = validator('json', (value, c) => {
  const checkedIn = (value as {checkedIn?: unknown} | null)?.checkedIn;
  if (typeof checkedIn !== 'boolean') {
    return c.json({...problem('invalid_input', 'Say whether to check in or undo.'), fields: {checkedIn: 'Required.'}}, 422);
  }
  return {checkedIn};
});

const attendanceBody = validator('json', (value, c) => {
  const v = (value ?? {}) as {rsvpIds?: unknown; attended?: unknown};
  const ids = Array.isArray(v.rsvpIds) ? v.rsvpIds : [];
  if (
    typeof v.attended !== 'boolean' ||
    ids.length === 0 ||
    ids.length > MAX_IDS ||
    !ids.every(id => typeof id === 'string' && UUID.test(id))
  ) {
    return c.json(problem('invalid_input', `Pick 1 to ${MAX_IDS} guests and say whether they attended.`), 422);
  }
  return {rsvpIds: [...new Set((ids as string[]).map(id => id.toLowerCase()))], attended: v.attended};
});

const importBody = validator('json', (value, c) => {
  const raw = (value as {emails?: unknown} | null)?.emails;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EMAILS) {
    return c.json(problem('invalid_input', `Send 1 to ${MAX_EMAILS} email addresses.`), 422);
  }
  const emails = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const email = item.trim().toLowerCase();
    if (EMAIL_SHAPE.test(email)) emails.add(email);
  }
  if (emails.size === 0) return c.json(problem('invalid_input', 'No valid email addresses found.'), 422);
  return {emails: [...emails]};
});

const attendeesQuery = validator('query', value => ({
  before: typeof value.before === 'string' && UUID.test(value.before) ? value.before.toLowerCase() : '',
}));

export const adminCheckinRoutes = new Hono()
  // --- door staff (checkin OR manage) --------------------------------------
  .get('/events', withViewer, requireAuth, doorAccess, withDb, async c => {
    // Today's and upcoming events: anything that ended more than a day ago is done.
    const since = new Date(Date.now() - 24 * 3_600_000);
    const rows = await c.var.db.event.findMany({
      select: eventSelect,
      where: {...doorEvent, endAt: {gte: since}},
      orderBy: [{startAt: 'asc'}, {id: 'asc'}],
      take: EVENT_LIMIT,
    });
    return c.json({events: rows.map(toEvent)});
  })

  .get('/events/:eventId', eventParam, searchQuery, withViewer, requireAuth, doorAccess, withDb, async c => {
    const {eventId} = c.req.valid('param');
    const {q} = c.req.valid('query');
    const event = await c.var.db.event.findFirst({select: eventSelect, where: {id: eventId, ...doorEvent}});
    if (!event) return c.json(problem('not_found', 'Event not found.'), 404);

    // Staff search name and code only; managers may match email too (they see emails anyway).
    const manager = await can(c as never, PERMISSIONS.EVENT_MANAGE);
    const search: Prisma.RsvpWhereInput[] = q
      ? [
          {name: {contains: escapeLike(q), mode: 'insensitive' as const}},
          {ticketCode: {contains: escapeLike(q.toUpperCase())}},
          ...(manager ? [{email: {contains: escapeLike(q), mode: 'insensitive' as const}}] : []),
        ]
      : [];
    const [rows, counts] = await Promise.all([
      c.var.db.rsvp.findMany({
        select: guestSelect,
        where: {eventId, AND: [{OR: [{status: 'confirmed', response: 'going'}, {checkedInAt: {not: null}}]}, ...(search.length ? [{OR: search}] : [])]},
        orderBy: [{name: 'asc'}, {id: 'asc'}],
        take: DOOR_LIST_LIMIT,
      }),
      doorCounts(c.var.db, eventId),
    ]);
    return c.json({event: toEvent(event), guests: rows.map(toDoorGuest), counts, canManage: manager});
  })

  .get('/codes/:code', codeParam, withViewer, requireAuth, doorAccess, withDb, async c => {
    const {code} = c.req.valid('param');
    const rsvp = await c.var.db.rsvp.findUnique({where: {ticketCode: code}, select: {...guestSelect, event: {select: {...eventSelect, status: true, deletedAt: true}}}});
    if (!rsvp || rsvp.event.status !== 'published' || rsvp.event.deletedAt) {
      return c.json(problem('not_found', 'No guest has that ticket code.'), 404);
    }
    return c.json({event: toEvent(rsvp.event), guest: toDoorGuest(rsvp)});
  })

  .post('/codes/:code', codeParam, toggleBody, withViewer, requireAuth, doorAccess, withDb, async c => {
    const {code} = c.req.valid('param');
    const {checkedIn} = c.req.valid('json');
    const db = c.var.db;
    const rsvp = await db.rsvp.findUnique({
      where: {ticketCode: code},
      select: {id: true, eventId: true, status: true, response: true, checkedInAt: true, event: {select: {status: true, deletedAt: true}}},
    });
    if (!rsvp || rsvp.event.status !== 'published' || rsvp.event.deletedAt) {
      return c.json(problem('not_found', 'No guest has that ticket code.'), 404);
    }
    // Only a confirmed guest has a place to check into; the door can still undo any check-in.
    if (checkedIn && (rsvp.status !== 'confirmed' || rsvp.response !== 'going')) {
      return c.json(problem('not_confirmed', 'Only confirmed (going) guests can be checked in; this RSVP is waitlisted, unpaid, pending, maybe, declined or cancelled.'), 409);
    }
    // Conditional writes: re-checking keeps the FIRST timestamp, two scanners never race it.
    const changed = await db.rsvp.updateMany({
      where: {id: rsvp.id, checkedInAt: checkedIn ? null : {not: null}},
      data: {checkedInAt: checkedIn ? new Date() : null},
    });
    const [guest, counts] = await Promise.all([
      db.rsvp.findUniqueOrThrow({where: {id: rsvp.id}, select: guestSelect}),
      doorCounts(db, rsvp.eventId),
    ]);
    if (checkedIn && changed.count === 1) emitWebhook(c, db, 'guest.checked_in', checkedInPayload({id: rsvp.id, eventId: rsvp.eventId, checkedInAt: guest.checkedInAt}));
    return c.json({guest: toDoorGuest(guest), counts});
  })

  // --- online attendance (manage only) -------------------------------------
  .get('/events/:eventId/attendees', eventParam, attendeesQuery, withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const {eventId} = c.req.valid('param');
    const {before} = c.req.valid('query');
    const rows = await c.var.db.rsvp.findMany({
      select: {id: true, name: true, email: true, seats: true, attended: true, checkedInAt: true},
      where: {eventId, status: 'confirmed', ...(before ? {id: {gt: before}} : {})},
      orderBy: {id: 'asc'},
      take: ATTENDEE_PAGE + 1,
    });
    const page = rows.slice(0, ATTENDEE_PAGE);
    return c.json({
      attendees: page.map(r => ({...r, checkedInAt: r.checkedInAt?.toISOString() ?? null})),
      nextBefore: rows.length > ATTENDEE_PAGE ? page.at(-1)!.id : null,
    });
  })

  .post('/events/:eventId/attendance', eventParam, attendanceBody, withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const {eventId} = c.req.valid('param');
    const {rsvpIds, attended} = c.req.valid('json');
    // The event id in the WHERE is what scopes this: ids from another event just don't match.
    const {count} = await c.var.db.rsvp.updateMany({
      where: {eventId, id: {in: rsvpIds}, status: 'confirmed'},
      data: {attended},
    });
    return c.json({updated: count});
  })

  .post('/events/:eventId/attendance/import', eventParam, importBody, withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const {eventId} = c.req.valid('param');
    const {emails} = c.req.valid('json');
    const db = c.var.db;
    // Emails are stored lowercase; one indexed read for the event's matches, one write.
    const found = await db.rsvp.findMany({
      select: {id: true, email: true},
      where: {eventId, status: 'confirmed', email: {in: emails}},
      take: MAX_EMAILS,
    });
    if (found.length > 0) {
      await db.rsvp.updateMany({where: {eventId, id: {in: found.map(r => r.id)}}, data: {attended: true}});
    }
    const matched = new Set(found.map(r => r.email));
    return c.json({matched: found.length, unmatched: emails.filter(e => !matched.has(e)).slice(0, 100)});
  });
