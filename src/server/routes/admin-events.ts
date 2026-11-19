import {Hono, type Context} from 'hono';
import {validator} from 'hono/validator';

import {Prisma} from '../../generated/prisma/client';
import type {PrismaClient} from '../../generated/prisma/client';
import {pollJoinCode, withUniqueRetry} from '../../domain/codes';
import {uniqueSlug} from '../../domain/slug';
import {clearPublicEvents} from '../event-cache';
import {
  type AdminEventDetail,
  type AdminEventSummary,
  type AdminQuestion,
  type AdminTicketType,
  type CancelPreview,
  type CoverStyle,
  completeEvent,
  type EventListTab,
  EVENT_LIST_TABS,
  type EventValues,
  type FieldErrors,
  isUuid,
  parseEventFields,
  parseReminderRules,
  parseTicket,
  Collector,
  type PosterDesign,
  type QuestionInput,
  type QuestionType,
  type ReminderRuleValues,
  RESERVED_SLUGS,
  ticketPriceError,
  type TicketValues,
  toIso,
  DEFAULT_EVENT_SETTINGS,
} from '../../lib/event-schemas';
import {keysetAfter} from '../../lib/text';
import {audit} from '../../platform/auth';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import type {Viewer} from '../../platform/types';
import {STARTER_REMINDER_RULES} from '../../domain/reminders';
import {PERMISSIONS} from '../permissions';
import {EVENT_READERS, requireReadOrWrite} from '../guards-ext';
import {nextSortOrder, validateOrder} from '../sort-order';
import {enqueueEventCancelledEmails, kickGuestEmails} from '../jobs/outbox';
import {notifyPromoted} from '../jobs/holds';
import {type Db, lockEvent} from '../jobs/shared';
import {promoteWaitlist} from '../jobs/waitlist';
import {markEventOrdersRefundDue} from '../ticket-checkout';
import {emitSeated} from '../webhook-emit';
import {notFound as notFoundProblem, parsePageCursor} from '../validate';

/**
 * Events, admin side. Everything here needs `site:event:manage` (`EVENT_MANAGE`);
 * the public side is `routes/events.ts`. Mounted at `/site-api/admin-events`.
 *
 *   GET    /?tab=upcoming|past|drafts&before=     events, keyset-paged (no count)
 *   POST   /                                      create a draft (defaults from event settings)
 *   GET    /:id                                   one event, with its questions
 *   PATCH  /:id                                   edit; only the keys sent change
 *   POST   /:id/publish | /unpublish | /cancel    status changes (unpublish: 409 event_has_guests while guests or paid orders remain)
 *   GET    /:id/cancel-preview                    who a cancellation affects
 *   POST   /:id/duplicate {startAt,endAt,title?}  a draft copy (questions, tickets, email rules)
 *   DELETE /:id                                   soft delete (drafts with no guests or paid orders only)
 *   GET    /:id/ticket-types                      ticket types of an event
 *   POST   /:id/ticket-types                      add one
 *   PATCH  /:id/ticket-types/:ticketId            edit
 *   DELETE /:id/ticket-types/:ticketId            remove (refused once RSVPs use it)
 *
 * Lists use the partial indexes on `events` and (start_at, id) / (updated_at, id) keysets.
 * TicketType and RsvpQuestion are listed by (`sortOrder`, `id`); new ticket types go last (`nextSortOrder`).
 */

const PAGE_SIZE = 20;
const MAX_TICKET_TYPES = 20;

type Env = {Variables: {viewer: Viewer; db: PrismaClient}};

/** Hooks other slices register to react to a cancellation (guest emails, refunds). */
export const eventCancelHooks: Array<(db: PrismaClient, eventId: string) => Promise<void>> = [];

// ----------------------------------------------------------------- helpers --

/** A time-ordered UUID (v7): sorting by id sorts by creation time. */
export function uuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const t = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const invalid = (fields: FieldErrors) => ({
  ...problem('invalid_input', 'Some fields need attention.'),
  fields,
});

const eventSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  coverImageUrl: true,
  coverPoster: true,
  coverStyle: true,
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
  showGuestList: true,
  pollJoinCode: true,
  thankYouLink: true,
  createdAt: true,
  updatedAt: true,
} as const;

const summarySelect = {
  id: true,
  slug: true,
  title: true,
  status: true,
  visibility: true,
  format: true,
  startAt: true,
  endAt: true,
  timezone: true,
  capacity: true,
  coverImageUrl: true,
  coverPoster: true,
} as const;

const questionSelect = {id: true, label: true, type: true, options: true, required: true} as const;
const ticketSelect = {id: true, eventId: true, name: true, priceCents: true, currency: true, quantity: true, salesEndAt: true} as const;

type EventRow = Prisma.EventGetPayload<{select: typeof eventSelect}>;
type SummaryRow = Prisma.EventGetPayload<{select: typeof summarySelect}>;
type QuestionRow = Prisma.RsvpQuestionGetPayload<{select: typeof questionSelect}>;
type TicketRow = Prisma.TicketTypeGetPayload<{select: typeof ticketSelect}>;

const stringsOf = (json: unknown): string[] => (Array.isArray(json) ? json.filter((x): x is string => typeof x === 'string') : []);

function coverStyleOf(json: unknown): CoverStyle | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const out: CoverStyle = {};
  if (typeof o.palette === 'string') out.palette = o.palette as CoverStyle['palette'];
  if (typeof o.headline === 'string') out.headline = o.headline;
  if (typeof o.eyebrow === 'string') out.eyebrow = o.eyebrow;
  if (typeof o.footer === 'string') out.footer = o.footer;
  return Object.keys(out).length ? out : null;
}

const toQuestion = (q: QuestionRow): AdminQuestion => ({
  id: q.id,
  label: q.label,
  type: q.type,
  options: stringsOf(q.options),
  required: q.required,
});

function toSummary(e: SummaryRow, guests: GuestState): AdminEventSummary {
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    status: e.status,
    visibility: e.visibility,
    format: e.format,
    startAt: e.startAt.toISOString(),
    endAt: e.endAt.toISOString(),
    timezone: e.timezone,
    capacity: e.capacity,
    coverImageUrl: e.coverImageUrl,
    coverPoster: e.coverPoster,
    counts: guests.counts,
    hasHeld: guests.hasHeld,
  };
}

function toDetail(e: EventRow, questions: QuestionRow[], guests: GuestState): AdminEventDetail {
  return {
    ...toSummary(e, guests),
    description: e.description,
    coverStyle: coverStyleOf(e.coverStyle),
    venueName: e.venueName,
    venueAddress: e.venueAddress,
    mapUrl: e.mapUrl,
    joinUrl: e.joinUrl,
    rsvpDeadline: e.rsvpDeadline?.toISOString() ?? null,
    waitlistEnabled: e.waitlistEnabled,
    approvalRequired: e.approvalRequired,
    allowMaybe: e.allowMaybe,
    maxPlusOnes: e.maxPlusOnes,
    showGuestList: e.showGuestList,
    pollJoinCode: e.pollJoinCode,
    thankYouLink: e.thankYouLink,
    questions: questions.map(toQuestion),
    publicPath: `/events/${encodeURIComponent(e.slug)}/`,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

function toTicket(t: TicketRow, sold: number, now: Date): AdminTicketType {
  return {
    id: t.id,
    eventId: t.eventId,
    name: t.name,
    priceCents: t.priceCents,
    currency: t.currency,
    quantity: t.quantity,
    salesEndAt: t.salesEndAt?.toISOString() ?? null,
    sold,
    salesEnded: t.salesEndAt !== null && t.salesEndAt <= now,
  };
}

/** A stored event as a complete body, to merge a PATCH onto and re-run the cross-field rules. */
function valuesOf(e: EventRow, questions: QuestionRow[]): EventValues {
  return {
    title: e.title,
    slug: e.slug,
    description: e.description,
    coverImageUrl: e.coverImageUrl,
    coverPoster: e.coverPoster as PosterDesign | null,
    coverStyle: coverStyleOf(e.coverStyle),
    startAt: e.startAt.toISOString(),
    endAt: e.endAt.toISOString(),
    timezone: e.timezone,
    format: e.format,
    venueName: e.venueName,
    venueAddress: e.venueAddress,
    mapUrl: e.mapUrl,
    joinUrl: e.joinUrl,
    visibility: e.visibility,
    capacity: e.capacity,
    rsvpDeadline: e.rsvpDeadline?.toISOString() ?? null,
    waitlistEnabled: e.waitlistEnabled,
    approvalRequired: e.approvalRequired,
    allowMaybe: e.allowMaybe,
    maxPlusOnes: e.maxPlusOnes,
    showGuestList: e.showGuestList,
    thankYouLink: e.thankYouLink,
    questions: questions.map(q => ({id: q.id, label: q.label, type: q.type as QuestionType, options: stringsOf(q.options), required: q.required})),
  };
}

/** The columns of a normalised event, one by one (never a spread of client input). */
function columnsOf(v: EventValues) {
  return {
    title: v.title,
    description: v.description,
    coverImageUrl: v.coverImageUrl,
    coverPoster: v.coverPoster,
    coverStyle: v.coverStyle ? (v.coverStyle as Prisma.InputJsonObject) : Prisma.DbNull,
    startAt: new Date(v.startAt),
    endAt: new Date(v.endAt),
    timezone: v.timezone,
    format: v.format,
    venueName: v.venueName,
    venueAddress: v.venueAddress,
    mapUrl: v.mapUrl,
    joinUrl: v.joinUrl,
    visibility: v.visibility,
    capacity: v.capacity,
    rsvpDeadline: v.rsvpDeadline ? new Date(v.rsvpDeadline) : null,
    waitlistEnabled: v.waitlistEnabled,
    approvalRequired: v.approvalRequired,
    allowMaybe: v.allowMaybe,
    maxPlusOnes: v.maxPlusOnes,
    showGuestList: v.showGuestList,
    thankYouLink: v.thankYouLink,
  };
}

const isUniqueViolation = (err: unknown) => (err as {code?: unknown} | null)?.code === 'P2002';
const slugTaken = () => invalid({slug: 'Another event already uses this link.'});

/** Per event: the guest counts the dashboard shows, and whether the server would refuse unpublish / delete. */
export type GuestState = {counts: AdminEventSummary['counts']; hasHeld: boolean};

type GuestStateRow = {eventId: string; confirmed: number; waitlisted: number; pending: number; hasHeld: boolean};

/**
 * ONE query for a page of events (at most PAGE_SIZE ids): the counts, plus `hasHeld`, the same rule
 * as `hasGuestsOrPaidOrders` (a guest holding or waiting for a place, awaiting payment included, or a
 * paid order), so the dashboard offers Unpublish / Delete only when the server will accept it.
 * Indexed EXISTS probes, no extra round trip; the 409 stays the safety net.
 */
async function guestStateFor(db: PrismaClient, ids: string[]): Promise<Map<string, GuestState>> {
  const byEvent = new Map<string, GuestState>();
  for (const id of ids) byEvent.set(id, {counts: {confirmed: 0, waitlisted: 0, pending: 0}, hasHeld: false});
  if (!ids.length) return byEvent;
  const rows = await db.$queryRaw<GuestStateRow[]>`
    SELECT e.id::text AS "eventId", c.confirmed, c.waitlisted, c.pending,
      (c.confirmed + c.waitlisted + c.pending > 0
        OR EXISTS (SELECT 1 FROM rsvps r WHERE r.event_id = e.id AND r.status = 'awaiting_payment')
        OR EXISTS (SELECT 1 FROM ticket_orders o JOIN rsvps r ON r.id = o.rsvp_id
                   WHERE r.event_id = e.id AND o.status = 'paid')) AS "hasHeld"
    FROM unnest(${ids}::uuid[]) AS e(id)
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE r.status = 'confirmed')::int AS confirmed,
             count(*) FILTER (WHERE r.status = 'waitlisted')::int AS waitlisted,
             count(*) FILTER (WHERE r.status = 'pending')::int AS pending
      FROM rsvps r
      WHERE r.event_id = e.id AND r.status IN ('confirmed', 'waitlisted', 'pending')
    ) AS c`;
  for (const r of rows) {
    if (!byEvent.has(r.eventId)) continue;
    byEvent.set(r.eventId, {
      counts: {confirmed: Number(r.confirmed) || 0, waitlisted: Number(r.waitlisted) || 0, pending: Number(r.pending) || 0},
      hasHeld: r.hasHeld === true,
    });
  }
  return byEvent;
}

/** The event's questions, in the host's order (bounded: the form allows far fewer). */
const questionsOf =(db: PrismaClient, eventId: string) =>
  db.rsvpQuestion.findMany({where: {eventId}, select: questionSelect, orderBy: [{sortOrder: 'asc'}, {id: 'asc'}], take: 100});

/** One round trip: the event, its questions and its counts are all keyed by the id, so they are read together. */
async function loadDetail(db: PrismaClient, id: string): Promise<AdminEventDetail | null> {
  const [event, questions, guests] = await Promise.all([
    db.event.findFirst({where: {id, deletedAt: null}, select: eventSelect}),
    questionsOf(db, id),
    guestStateFor(db, [id]),
  ]);
  return event ? toDetail(event, questions, guests.get(id)!) : null;
}

/** Event settings the create flow inherits (timezone, Maybe, guest list, poster, email rules). */
async function settingsFor(db: PrismaClient) {
  const row = await db.eventSettings.findUnique({
    where: {id: 1},
    select: {defaultTimezone: true, allowMaybeDefault: true, showGuestListDefault: true, defaultCoverPoster: true, defaultReminderRules: true},
  });
  if (!row) return {...DEFAULT_EVENT_SETTINGS, defaultReminderRules: STARTER_REMINDER_RULES.map(r => ({...r}))};
  const c = new Collector();
  const rules = parseReminderRules(c, row.defaultReminderRules, 'rules') ?? [];
  return {
    ...DEFAULT_EVENT_SETTINGS,
    defaultTimezone: row.defaultTimezone,
    allowMaybeDefault: row.allowMaybeDefault,
    showGuestListDefault: row.showGuestListDefault,
    defaultCoverPoster: (row.defaultCoverPoster as PosterDesign | null) ?? null,
    // An untouched list (the column defaults to []) starts new events with the standard emails (US-20).
    defaultReminderRules: rules.length ? rules : STARTER_REMINDER_RULES.map(r => ({...r})),
  };
}

const ruleData = (r: ReminderRuleValues) => ({
  kind: r.kind,
  offsetMinutes: r.offsetMinutes,
  enabled: r.enabled,
  subject: r.subject,
  body: r.body,
});

const questionData = (eventId: string, q: QuestionInput, id: string) => ({
  id,
  eventId,
  label: q.label,
  type: q.type,
  options: q.options,
  required: q.required,
});

/**
 * The writes that make the event's questions exactly `wanted` (kept ids update in place, the rest
 * are created or deleted), for the caller's batch transaction. `existing` is the event's questions
 * as just read, so nothing is read again.
 */
function questionWrites(db: PrismaClient, eventId: string, existing: {id: string}[], wanted: QuestionInput[]) {
  const own = new Set(existing.map(q => q.id));
  const keep = new Set(wanted.flatMap(q => (q.id && own.has(q.id) ? [q.id] : [])));
  const drop = [...own].filter(id => !keep.has(id));
  return [
    ...(drop.length ? [db.rsvpQuestion.deleteMany({where: {eventId, id: {in: drop}}})] : []),
    ...wanted.map((q, sortOrder) =>
      q.id && own.has(q.id)
        ? db.rsvpQuestion.updateMany({
            where: {id: q.id, eventId},
            data: {label: q.label, type: q.type, options: q.options, required: q.required, sortOrder},
          })
        : db.rsvpQuestion.create({data: {...questionData(eventId, q, uuidV7()), sortOrder}, select: {id: true}})
    ),
  ];
}

/** A normalised JSON body, or a 422 with the fields. */
function jsonBody(partial: boolean) {
  return validator('json', (value, c) => {
    const parsed = parseEventFields(value, partial);
    return parsed.ok ? parsed.value : c.json(invalid(parsed.fields), 422);
  });
}

const listQuery = validator('query', (value, c) => {
  const tab = typeof value.tab === 'string' ? value.tab : 'upcoming';
  if (!(EVENT_LIST_TABS as readonly string[]).includes(tab)) return c.json(invalid({tab: 'Choose upcoming, past or drafts.'}), 422);
  return {tab: tab as EventListTab, before: typeof value.before === 'string' ? value.before : ''};
});

const duplicateBody = validator('json', (value, c) => {
  const v = (value ?? {}) as Record<string, unknown>;
  const startAt = toIso(v.startAt);
  const endAt = toIso(v.endAt);
  const fields: FieldErrors = {};
  if (!startAt) fields.startAt = 'Enter a valid date and time.';
  if (!endAt) fields.endAt = 'Enter a valid date and time.';
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) fields.endAt = 'End must be after the start.';
  let title: string | undefined;
  if (v.title !== undefined) {
    title = typeof v.title === 'string' ? v.title.trim() : '';
    if (!title || title.length > 120) fields.title = 'A title needs 1 to 120 characters.';
  }
  if (Object.keys(fields).length) return c.json(invalid(fields), 422);
  return {startAt: startAt!, endAt: endAt!, title};
});

const ticketBody = (partial: boolean) =>
  validator('json', (value, c) => {
    const parsed = parseTicket(value, partial);
    return parsed.ok ? parsed.value : c.json(invalid(parsed.fields), 422);
  });

/** This route's 404 wording ("No such event."), in the shared shape (`validate.ts`). */
const notFound = (c: Context, what = 'event') => notFoundProblem(c, what, `No such ${what}.`);

/**
 * H-1: does anyone still expect this event (a guest holding a place or waiting for one) or has anyone
 * paid for it? Then it can't quietly become a draft or vanish: it has to go through Cancel, which emails
 * the guests and queues the refunds. ONE query, two EXISTS probes (rsvps(event_id, status), ticket_orders(rsvp_id)).
 * Call it inside a transaction that already holds `lockEvent`, so no RSVP lands between the check and the write.
 */
async function hasGuestsOrPaidOrders(tx: Db, eventId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{held: boolean; paid: boolean}>>`
    SELECT
      EXISTS (SELECT 1 FROM rsvps WHERE event_id = ${eventId}::uuid
              AND status IN ('pending', 'confirmed', 'waitlisted', 'awaiting_payment')) AS held,
      EXISTS (SELECT 1 FROM ticket_orders o JOIN rsvps r ON r.id = o.rsvp_id
              WHERE r.event_id = ${eventId}::uuid AND o.status = 'paid') AS paid`;
  return !!row && (row.held || row.paid);
}

const hasGuests = (doing: 'unpublished' | 'deleted') =>
  problem(
    'event_has_guests',
    `This event has guests or paid tickets, so it can’t be ${doing}. Cancel the event instead: guests are emailed and paid tickets are marked for refund.`
  );

// ------------------------------------------------------------------ routes --

export const adminEventRoutes = new Hono<Env>()
  // GETs: see-only admins too (`site:event:read`); every write needs `site:event:manage`.
  .use('*', withViewer, requireAuth, requireReadOrWrite(EVENT_READERS, [PERMISSIONS.EVENT_MANAGE]), withDb)

  .get('/', listQuery, async c => {
    const {tab, before} = c.req.valid('query');
    const db = c.var.db;
    const now = new Date();
    const cursor = parsePageCursor(before);
    // upcoming: soonest first; past: latest first; drafts: last edited first.
    const field = tab === 'drafts' ? 'updatedAt' : 'startAt';
    const dir = tab === 'upcoming' ? 'asc' : 'desc';
    const tabWhere: Prisma.EventWhereInput =
      tab === 'drafts'
        ? {status: 'draft'}
        : tab === 'upcoming'
          ? {status: 'published', endAt: {gte: now}}
          : {OR: [{status: 'cancelled'}, {status: 'published', endAt: {lt: now}}]};
    // Millisecond cursor vs microsecond column: `keysetAfter` compares at the cursor's precision.
    const cursorWhere: Prisma.EventWhereInput = cursor ? keysetAfter(field, dir, cursor) : {};
    const rows = await db.event.findMany({
      select: {...summarySelect, updatedAt: true},
      where: {AND: [{deletedAt: null}, tabWhere, cursorWhere]},
      orderBy: [{[field]: dir}, {id: dir}],
      take: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const guests = await guestStateFor(db, page.map(e => e.id));
    const last = page.at(-1);
    return c.json({
      events: page.map(e => toSummary(e, guests.get(e.id)!)),
      nextBefore: rows.length > PAGE_SIZE && last ? `${(field === 'updatedAt' ? last.updatedAt : last.startAt).toISOString()}_${last.id}` : null,
    });
  })

  .post('/', jsonBody(false), async c => {
    const db = c.var.db;
    const sent = c.req.valid('json');
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const settings = await settingsFor(db);
    // New events inherit these unless the body sets them (an explicit null poster is kept).
    const withDefaults: Partial<EventValues> = {
      ...sent,
      timezone: raw.timezone === undefined ? settings.defaultTimezone : sent.timezone,
      allowMaybe: raw.allowMaybe === undefined ? settings.allowMaybeDefault : sent.allowMaybe,
      showGuestList: raw.showGuestList === undefined ? settings.showGuestListDefault : sent.showGuestList,
      coverPoster: raw.coverPoster === undefined ? settings.defaultCoverPoster : sent.coverPoster,
    };
    const empty: EventValues = {
      title: '', description: '', coverImageUrl: null, coverPoster: null, coverStyle: null, startAt: '', endAt: '',
      timezone: settings.defaultTimezone, format: 'in_person', venueName: null, venueAddress: null, mapUrl: null,
      joinUrl: null, visibility: 'public', capacity: null, rsvpDeadline: null, waitlistEnabled: true,
      approvalRequired: false, allowMaybe: true, maxPlusOnes: 0, showGuestList: false, thankYouLink: null, questions: [],
    };
    const done = completeEvent(empty, withDefaults);
    if (!done.ok) return c.json(invalid(done.fields), 422);
    const values = done.value;

    const taken = async (slug: string) => RESERVED_SLUGS.has(slug) || (await db.event.findFirst({where: {slug, deletedAt: null}, select: {id: true}})) !== null;
    if (values.slug && (await taken(values.slug))) return c.json(slugTaken(), 422);
    const id = uuidV7();
    // A link the server chose may be taken by a concurrent create between the check and the insert: pick again.
    for (let attempt = 0; ; attempt++) {
      const slug = values.slug ?? (await uniqueSlug(values.title, taken));
      const code = await withUniqueRetry(pollJoinCode, async v => (await db.event.findUnique({where: {pollJoinCode: v}, select: {id: true}})) !== null);
      try {
        await db.event.create({
          data: {
            ...columnsOf(values),
            id,
            slug,
            status: 'draft',
            pollJoinCode: code,
            rsvpQuestions: {create: values.questions.map((q, sortOrder) => ({id: uuidV7(), sortOrder, label: q.label, type: q.type, options: q.options, required: q.required}))},
            reminderRules: {create: settings.defaultReminderRules.map(ruleData)},
          },
          select: {id: true},
        });
        break;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (values.slug || attempt >= 2) return c.json(slugTaken(), 422);
      }
    }
    return c.json({event: await loadDetail(db, id)}, 201);
  })

  .get('/:id', async c => {
    const id = c.req.param('id');
    const event = isUuid(id) ? await loadDetail(c.var.db, id) : null;
    return event ? c.json({event}) : notFound(c);
  })

  .patch('/:id', jsonBody(true), async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    if (!isUuid(id)) return notFound(c);
    const [row, questions] = await Promise.all([db.event.findFirst({where: {id, deletedAt: null}, select: eventSelect}), questionsOf(db, id)]);
    if (!row) return notFound(c);
    if (row.status === 'cancelled') return c.json(problem('conflict', 'A cancelled event can’t be edited. Duplicate it to run it again.'), 409);
    const patch = c.req.valid('json');
    const done = completeEvent(valuesOf(row, questions), patch);
    if (!done.ok) return c.json(invalid(done.fields), 422);
    const values = done.value;
    const slug = patch.slug ?? row.slug;
    // The checks that need a read run together.
    const [tickets, slugOwner] = await Promise.all([
      // More plus-ones means bigger parties: every existing ticket price must still fit (as when a ticket is saved).
      values.maxPlusOnes > row.maxPlusOnes
        ? db.ticketType.findMany({where: {eventId: id}, select: {priceCents: true, currency: true}, take: MAX_TICKET_TYPES})
        : Promise.resolve([]),
      slug !== row.slug ? db.event.findFirst({where: {slug, deletedAt: null, id: {not: id}}, select: {id: true}}) : Promise.resolve(null),
    ]);
    if (tickets.some(t => ticketPriceError(t.priceCents, t.currency, 1 + values.maxPlusOnes))) {
      return c.json(invalid({maxPlusOnes: 'A ticket price is too high for that many plus-ones. Lower the price or the plus-ones.'}), 422);
    }
    if (slugOwner) return c.json(slugTaken(), 422);
    try {
      // The event and its questions change together: one batch transaction.
      const update = db.event.update({where: {id}, data: {...columnsOf(values), slug}, select: {id: true}});
      if (patch.questions) await db.$transaction([update, ...questionWrites(db, id, questions, values.questions)]);
      else await update;
    } catch (err) {
      if (isUniqueViolation(err)) return c.json(slugTaken(), 422);
      throw err;
    }
    // The public page shows these columns (and maybe the old slug): clear it now that the save committed.
    await clearPublicEvents();
    // US-4: more seats (or no limit) go straight to the waitlist; emails are queued after the commit.
    if (row.status === 'published' && (values.capacity === null ? row.capacity !== null : row.capacity !== null && values.capacity > row.capacity)) {
      try {
        const promoted = await db.$transaction(async tx => {
          await lockEvent(tx, id);
          return promoteWaitlist(tx, id, new Date());
        });
        await emitSeated(db, id, promoted);
        await notifyPromoted(promoted.map(p => ({rsvpId: p.rsvpId, kind: p.kind, ...(p.kind === 'offer_claim' ? {claimExpiresAt: p.claimExpiresAt} : {})})));
      } catch (err) {
        console.error(`event edit: waitlist promotion failed: ${(err as Error).message}`.slice(0, 200));
      }
    }
    return c.json({event: await loadDetail(db, id)});
  })

  .post('/:id/publish', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    if (!isUuid(id)) return notFound(c);
    const [row, questions] = await Promise.all([db.event.findFirst({where: {id, deletedAt: null}, select: eventSelect}), questionsOf(db, id)]);
    if (!row) return notFound(c);
    if (row.status === 'cancelled') return c.json(problem('conflict', 'A cancelled event can’t be published again.'), 409);
    if (row.status === 'published') return c.json({event: await loadDetail(db, id)});
    if (row.endAt < new Date()) return c.json(problem('conflict', 'This event has already ended. Change its dates before publishing.'), 409);
    // Saves already require a complete event; re-check anyway, since the rules or stored data may have moved on.
    const check = completeEvent(valuesOf(row, questions), {});
    if (!check.ok) return c.json({...problem('conflict', 'Fill in the missing details before publishing.'), fields: check.fields}, 409);
    await db.event.updateMany({where: {id, status: 'draft'}, data: {status: 'published'}});
    await clearPublicEvents();
    await audit(db, {actorUserId: c.var.viewer.id, action: 'event_published', target: ['event', id]});
    return c.json({event: await loadDetail(db, id)});
  })

  .post('/:id/unpublish', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    if (!isUuid(id)) return notFound(c);
    // Lock, check and write in one transaction: no RSVP or payment can land between the check and the unpublish.
    const outcome = await db.$transaction(async tx => {
      await lockEvent(tx, id);
      const row = await tx.event.findFirst({where: {id, deletedAt: null}, select: {status: true}});
      if (!row) return 'missing' as const;
      if (row.status === 'cancelled') return 'cancelled' as const;
      if (row.status !== 'published') return 'unchanged' as const;
      if (await hasGuestsOrPaidOrders(tx, id)) return 'has_guests' as const;
      await tx.event.updateMany({where: {id, status: 'published'}, data: {status: 'draft'}});
      return 'unpublished' as const;
    });
    if (outcome === 'missing') return notFound(c);
    if (outcome === 'cancelled') return c.json(problem('conflict', 'A cancelled event can’t be unpublished.'), 409);
    if (outcome === 'has_guests') return c.json(hasGuests('unpublished'), 409);
    if (outcome === 'unpublished') {
      await clearPublicEvents();
      await audit(db, {actorUserId: c.var.viewer.id, action: 'event_unpublished', target: ['event', id]});
    }
    return c.json({event: await loadDetail(db, id)});
  })

  .get('/:id/cancel-preview', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const row = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: {id: true}}) : null;
    if (!row) return notFound(c);
    const [guests, paid, one] = await Promise.all([
      db.rsvp.count({where: {eventId: id, status: {in: ['confirmed', 'waitlisted', 'pending', 'awaiting_payment']}}}),
      db.ticketOrder.aggregate({where: {status: 'paid', rsvp: {eventId: id}}, _count: {_all: true}, _sum: {amountCents: true}}),
      db.ticketOrder.findFirst({where: {status: 'paid', rsvp: {eventId: id}}, select: {currency: true}}),
    ]);
    const preview: CancelPreview = {
      guestsToEmail: guests,
      ordersToRefund: paid._count._all,
      refundTotalCents: paid._sum.amountCents ?? 0,
      currency: one?.currency ?? null,
    };
    return c.json(preview);
  })

  .post('/:id/cancel', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const row = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: {id: true, status: true}}) : null;
    if (!row) return notFound(c);
    const already = problem('conflict', 'This event is already cancelled.');
    if (row.status === 'cancelled') return c.json(already, 409);
    // ONE transaction: the flip, paid tickets to `refund_due` (so the owner sees what to refund) and one
    // keyed outbox row per guest expecting the event. Either all of it commits or none: a failure
    // leaves the event as it was and the owner simply cancels again, nothing is half done.
    // The flip is conditional: of two cancels at once, exactly one gets count 1 and does the rest.
    const outcome = await db.$transaction(async tx => {
      const flipped = await tx.event.updateMany({where: {id, deletedAt: null, status: {not: 'cancelled'}}, data: {status: 'cancelled'}});
      if (flipped.count === 0) return null;
      const refundDue = await markEventOrdersRefundDue(tx, id);
      await enqueueEventCancelledEmails(tx, id);
      return {refundDue};
    });
    if (!outcome) return c.json(already, 409);
    await clearPublicEvents();
    await audit(db, {actorUserId: c.var.viewer.id, action: 'event_cancelled', target: ['event', id], meta: {refundDue: outcome.refundDue}});
    await kickGuestEmails();
    for (const hook of eventCancelHooks) await hook(db, id);
    return c.json({event: await loadDetail(db, id)});
  })

  .post('/:id/duplicate', duplicateBody, async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const source = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: eventSelect}) : null;
    if (!source) return notFound(c);
    const body = c.req.valid('json');
    const title = (body.title ?? `Copy of ${source.title}`).slice(0, 120);
    const startAt = new Date(body.startAt);
    const shift = startAt.getTime() - source.startAt.getTime();
    const [questions, tickets, rules, polls] = await Promise.all([
      db.rsvpQuestion.findMany({where: {eventId: id}, select: questionSelect, orderBy: [{sortOrder: 'asc'}, {id: 'asc'}]}),
      db.ticketType.findMany({where: {eventId: id}, select: ticketSelect, orderBy: [{sortOrder: 'asc'}, {id: 'asc'}]}),
      db.reminderRule.findMany({where: {eventId: id}, select: {kind: true, offsetMinutes: true, enabled: true, subject: true, body: true}}),
      db.poll.findMany({
        where: {eventId: id},
        select: {question: true, type: true, anonymous: true, showResultsToVoters: true, sortOrder: true, pollOptions: {select: {label: true, sortOrder: true}, orderBy: {sortOrder: 'asc'}}},
        orderBy: {sortOrder: 'asc'},
      }),
    ]);
    const taken = async (slug: string) => RESERVED_SLUGS.has(slug) || (await db.event.findFirst({where: {slug, deletedAt: null}, select: {id: true}})) !== null;
    const slug = await uniqueSlug(title, taken);
    const code = await withUniqueRetry(pollJoinCode, async v => (await db.event.findUnique({where: {pollJoinCode: v}, select: {id: true}})) !== null);
    const values = valuesOf(source, questions);
    const copyId = uuidV7();
    try {
      await db.event.create({
        data: {
          ...columnsOf({...values, title}),
          id: copyId,
          slug,
          status: 'draft',
          pollJoinCode: code,
          startAt,
          endAt: new Date(body.endAt),
          // Keep the deadline the same distance before the start, so it stays valid.
          rsvpDeadline: source.rsvpDeadline ? new Date(source.rsvpDeadline.getTime() + shift) : null,
          rsvpQuestions: {create: questions.map((q, sortOrder) => ({id: uuidV7(), sortOrder, label: q.label, type: q.type, options: stringsOf(q.options), required: q.required}))},
          ticketTypes: {
            create: tickets.map((t, sortOrder) => ({
              id: uuidV7(),
              sortOrder,
              name: t.name,
              priceCents: t.priceCents,
              currency: t.currency,
              quantity: t.quantity,
              salesEndAt: t.salesEndAt ? new Date(t.salesEndAt.getTime() + shift) : null,
            })),
          },
          reminderRules: {create: rules.map(r => ruleData({...r, kind: r.kind}))},
          // Polls come across as drafts with their options and no votes (US-10).
          polls: {
            create: polls.map(p => ({
              id: uuidV7(),
              question: p.question,
              type: p.type,
              status: 'draft' as const,
              anonymous: p.anonymous,
              showResultsToVoters: p.showResultsToVoters,
              sortOrder: p.sortOrder,
              pollOptions: {create: p.pollOptions.map(o => ({id: uuidV7(), label: o.label, sortOrder: o.sortOrder}))},
            })),
          },
        },
        select: {id: true},
      });
    } catch (err) {
      if (isUniqueViolation(err)) return c.json(slugTaken(), 422);
      throw err;
    }
    return c.json({event: await loadDetail(db, copyId)}, 201);
  })

  .delete('/:id', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    if (!isUuid(id)) return notFound(c);
    // Published and cancelled events have guests and history; only drafts can vanish, and only drafts nobody
    // holds a place in or paid for (a draft can still carry guests from before it was unpublished).
    // Lock, check and write in one transaction, so nothing lands between the check and the delete.
    const outcome = await db.$transaction(async tx => {
      await lockEvent(tx, id);
      const row = await tx.event.findFirst({where: {id, deletedAt: null}, select: {status: true}});
      if (!row) return 'missing' as const;
      if (row.status !== 'draft') return 'not_draft' as const;
      if (await hasGuestsOrPaidOrders(tx, id)) return 'has_guests' as const;
      await tx.event.updateMany({where: {id, status: 'draft', deletedAt: null}, data: {deletedAt: new Date()}});
      return 'deleted' as const;
    });
    if (outcome === 'missing') return notFound(c);
    if (outcome === 'not_draft') return c.json(problem('conflict', 'Only drafts can be deleted. Cancel the event instead.'), 409);
    if (outcome === 'has_guests') return c.json(hasGuests('deleted'), 409);
    await clearPublicEvents();
    await audit(db, {actorUserId: c.var.viewer.id, action: 'event_deleted', target: ['event', id]});
    return c.json({ok: true});
  })

  // ---- ticket types ---------------------------------------------------------

  .get('/:id/ticket-types', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const event = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: {id: true}}) : null;
    if (!event) return notFound(c);
    const [rows, held] = await Promise.all([
      db.ticketType.findMany({where: {eventId: id}, select: ticketSelect, orderBy: [{sortOrder: 'asc'}, {id: 'asc'}]}),
      seatsHeld(db, id),
    ]);
    const now = new Date();
    return c.json({ticketTypes: rows.map(t => toTicket(t, held.get(t.id) ?? 0, now)), currency: rows[0]?.currency ?? 'USD'});
  })

  .post('/:id/ticket-types', ticketBody(false), async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    if (!isUuid(id)) return notFound(c);
    // Every read here is keyed by the event id: one round trip.
    const [event, existing, last] = await Promise.all([
      db.event.findFirst({where: {id, deletedAt: null}, select: {id: true, maxPlusOnes: true, status: true}}),
      db.ticketType.findMany({where: {eventId: id}, select: {currency: true}, take: MAX_TICKET_TYPES + 1}),
      db.ticketType.aggregate({where: {eventId: id}, _max: {sortOrder: true}}),
    ]);
    if (!event) return notFound(c);
    if (event.status === 'cancelled') return c.json(problem('conflict', 'A cancelled event can’t get new tickets.'), 409);
    const input = c.req.valid('json') as TicketValues;
    if (existing.length >= MAX_TICKET_TYPES) return c.json(problem('conflict', `Use at most ${MAX_TICKET_TYPES} ticket types.`), 409);
    if (existing[0] && existing[0].currency !== input.currency) {
      return c.json(invalid({currency: `All tickets for an event use one currency (${existing[0].currency}).`}), 422);
    }
    const priceError = ticketPriceError(input.priceCents, input.currency, 1 + event.maxPlusOnes);
    if (priceError) return c.json(invalid({priceCents: priceError}), 422);
    const created = await db.ticketType.create({
      data: {
        id: uuidV7(),
        eventId: id,
        sortOrder: nextSortOrder(last._max.sortOrder),
        name: input.name,
        priceCents: input.priceCents,
        currency: input.currency,
        quantity: input.quantity,
        salesEndAt: input.salesEndAt ? new Date(input.salesEndAt) : null,
      },
      select: ticketSelect,
    });
    await audit(db, {actorUserId: c.var.viewer.id, action: 'ticket_type_created', target: ['event', id], meta: {ticketTypeId: created.id}});
    return c.json({ticketType: toTicket(created, 0, new Date())}, 201);
  })

  .patch('/:id/ticket-types/order', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const event = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: {id: true}}) : null;
    if (!event) return notFound(c);
    const body = (await c.req.json().catch(() => null)) as {ids?: unknown} | null;
    const existing = await db.ticketType.findMany({where: {eventId: id}, select: {id: true}, take: MAX_TICKET_TYPES + 1});
    if (!validateOrder(body?.ids, existing.map(t => t.id))) return c.json(invalid({ids: 'Send every ticket type of this event exactly once.'}), 422);
    const ids = body!.ids as string[];
    await db.$transaction(ids.map((ticketId, sortOrder) => db.ticketType.updateMany({where: {id: ticketId, eventId: id}, data: {sortOrder}})));
    return c.json({ok: true});
  })

  .patch('/:id/ticket-types/:ticketId', ticketBody(true), async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const ticketId = c.req.param('ticketId');
    if (!isUuid(id) || !isUuid(ticketId)) return notFound(c, 'ticket type');
    const [event, ticket] = await Promise.all([
      db.event.findFirst({where: {id, deletedAt: null}, select: {id: true, maxPlusOnes: true, status: true}}),
      db.ticketType.findFirst({where: {id: ticketId, eventId: id}, select: ticketSelect}),
    ]);
    if (!event || !ticket) return notFound(c, 'ticket type');
    if (event.status === 'cancelled') return c.json(problem('conflict', 'A cancelled event’s tickets can’t be changed.'), 409);
    const patch = c.req.valid('json') as Partial<TicketValues>;
    const currency = patch.currency ?? ticket.currency;
    if (currency !== ticket.currency) {
      const others = await db.ticketType.findFirst({where: {eventId: id, id: {not: ticketId}}, select: {currency: true}});
      if (others && others.currency !== currency) {
        return c.json(invalid({currency: `All tickets for an event use one currency (${others.currency}).`}), 422);
      }
    }
    const priceCents = patch.priceCents ?? ticket.priceCents;
    if (patch.priceCents !== undefined || patch.currency !== undefined) {
      const priceError = ticketPriceError(priceCents, currency, 1 + event.maxPlusOnes);
      if (priceError) return c.json(invalid({priceCents: priceError}), 422);
    }
    const updated = await db.ticketType.update({
      where: {id: ticketId},
      data: {
        ...(patch.name !== undefined ? {name: patch.name} : {}),
        ...(patch.priceCents !== undefined ? {priceCents: patch.priceCents} : {}),
        ...(patch.currency !== undefined ? {currency: patch.currency} : {}),
        ...(patch.quantity !== undefined ? {quantity: patch.quantity} : {}),
        ...(patch.salesEndAt !== undefined ? {salesEndAt: patch.salesEndAt ? new Date(patch.salesEndAt) : null} : {}),
      },
      select: ticketSelect,
    });
    await audit(db, {actorUserId: c.var.viewer.id, action: 'ticket_type_changed', target: ['event', id], meta: {ticketTypeId: ticketId, keys: Object.keys(patch)}});
    const held = await seatsHeld(db, id);
    return c.json({ticketType: toTicket(updated, held.get(ticketId) ?? 0, new Date())});
  })

  .delete('/:id/ticket-types/:ticketId', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const ticketId = c.req.param('ticketId');
    if (!isUuid(id) || !isUuid(ticketId)) return notFound(c, 'ticket type');
    // Under the event lock (every RSVP placement takes it too), so no guest picks this ticket between
    // the check and the delete. Any guest on it is enough to refuse: no need to count them all.
    const outcome = await db.$transaction(async tx => {
      await lockEvent(tx, id);
      const ticket = await tx.ticketType.findFirst({where: {id: ticketId, eventId: id, event: {deletedAt: null}}, select: {id: true}});
      if (!ticket) return 'missing' as const;
      const chosen = await tx.rsvp.findFirst({where: {ticketTypeId: ticketId, eventId: id}, select: {id: true}});
      if (chosen) return 'chosen' as const;
      await tx.ticketType.deleteMany({where: {id: ticketId, eventId: id}});
      return 'deleted' as const;
    });
    if (outcome === 'missing') return notFound(c, 'ticket type');
    // RSVPs (and through them orders) point at the type: end its sales instead.
    if (outcome === 'chosen') {
      return c.json(problem('conflict', 'Guests already chose this ticket. Set its sales end to a past date to stop selling it.'), 409);
    }
    await audit(db, {actorUserId: c.var.viewer.id, action: 'ticket_type_deleted', target: ['event', id], meta: {ticketTypeId: ticketId}});
    return c.json({ok: true});
  });

/** Seats held per ticket type: confirmed and awaiting-payment "going" RSVPs. */
async function seatsHeld(db: PrismaClient, eventId: string): Promise<Map<string, number>> {
  const rows = await db.rsvp.groupBy({
    by: ['ticketTypeId'],
    where: {eventId, ticketTypeId: {not: null}, response: 'going', status: {in: ['confirmed', 'awaiting_payment']}},
    _sum: {seats: true},
  });
  return new Map(rows.flatMap(r => (r.ticketTypeId ? [[r.ticketTypeId, r._sum.seats ?? 0] as const] : [])));
}
