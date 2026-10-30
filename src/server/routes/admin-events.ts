import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {Prisma} from '../../generated/prisma/client';
import type {PrismaClient} from '../../generated/prisma/client';
import {pollJoinCode, withUniqueRetry} from '../../domain/codes';
import {uniqueSlug} from '../../domain/slug';
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
  ticketPriceError,
  type TicketValues,
  toIso,
  DEFAULT_EVENT_SETTINGS,
} from '../../lib/event-schemas';
import {audit} from '../../platform/auth';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import type {Viewer} from '../../platform/types';
import {PERMISSIONS} from '../permissions';
import {markEventOrdersRefundDue} from '../ticket-checkout';

/**
 * Events, admin side. Everything here needs `site:event:manage` (`EVENT_MANAGE`);
 * the public side is `routes/events.ts`. Mounted at `/site-api/admin-events`.
 *
 *   GET    /?tab=upcoming|past|drafts&before=     events, keyset-paged (no count)
 *   POST   /                                      create a draft (defaults from event settings)
 *   GET    /:id                                   one event, with its questions
 *   PATCH  /:id                                   edit; only the keys sent change
 *   POST   /:id/publish | /unpublish | /cancel    status changes
 *   GET    /:id/cancel-preview                    who a cancellation affects
 *   POST   /:id/duplicate {startAt,endAt,title?}  a draft copy (questions, tickets, email rules)
 *   DELETE /:id                                   soft delete (drafts only)
 *   GET    /:id/ticket-types                      ticket types of an event
 *   POST   /:id/ticket-types                      add one
 *   PATCH  /:id/ticket-types/:ticketId            edit
 *   DELETE /:id/ticket-types/:ticketId            remove (refused once RSVPs use it)
 *
 * Lists use the partial indexes on `events` and (start_at, id) / (updated_at, id) keysets.
 * TicketType and RsvpQuestion have no sort column: both are listed by `id`, and new rows get
 * time-ordered UUIDs (`uuidV7`) so "by id" is "in the order they were added".
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

function toSummary(e: SummaryRow, counts: AdminEventSummary['counts']): AdminEventSummary {
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
    counts,
  };
}

function toDetail(e: EventRow, questions: QuestionRow[], counts: AdminEventSummary['counts']): AdminEventDetail {
  return {
    ...toSummary(e, counts),
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
    publicPath: `/e/${e.slug}`,
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

async function emptyCountsFor(db: PrismaClient, ids: string[]) {
  const byEvent = new Map<string, AdminEventSummary['counts']>();
  for (const id of ids) byEvent.set(id, {confirmed: 0, waitlisted: 0, pending: 0});
  if (!ids.length) return byEvent;
  const rows = await db.rsvp.groupBy({
    by: ['eventId', 'status'],
    where: {eventId: {in: ids}, status: {in: ['confirmed', 'waitlisted', 'pending']}},
    _count: {_all: true},
  });
  for (const r of rows) {
    const counts = byEvent.get(r.eventId);
    if (counts && (r.status === 'confirmed' || r.status === 'waitlisted' || r.status === 'pending')) counts[r.status] = r._count._all;
  }
  return byEvent;
}

async function loadDetail(db: PrismaClient, id: string): Promise<AdminEventDetail | null> {
  const event = await db.event.findFirst({where: {id, deletedAt: null}, select: eventSelect});
  if (!event) return null;
  const [questions, counts] = await Promise.all([
    db.rsvpQuestion.findMany({where: {eventId: id}, select: questionSelect, orderBy: {id: 'asc'}}),
    emptyCountsFor(db, [id]),
  ]);
  return toDetail(event, questions, counts.get(id)!);
}

/** Event settings the create flow inherits (timezone, Maybe, guest list, poster, email rules). */
async function settingsFor(db: PrismaClient) {
  const row = await db.eventSettings.findUnique({
    where: {id: 1},
    select: {defaultTimezone: true, allowMaybeDefault: true, showGuestListDefault: true, defaultCoverPoster: true, defaultReminderRules: true},
  });
  if (!row) return {...DEFAULT_EVENT_SETTINGS};
  const c = new Collector();
  const rules = parseReminderRules(c, row.defaultReminderRules, 'rules') ?? [];
  return {
    ...DEFAULT_EVENT_SETTINGS,
    defaultTimezone: row.defaultTimezone,
    allowMaybeDefault: row.allowMaybeDefault,
    showGuestListDefault: row.showGuestListDefault,
    defaultCoverPoster: (row.defaultCoverPoster as PosterDesign | null) ?? null,
    defaultReminderRules: rules,
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

/** Makes the event's questions exactly `wanted`: kept ids update in place, the rest are created or deleted. */
async function saveQuestions(db: PrismaClient, eventId: string, wanted: QuestionInput[]) {
  const existing = await db.rsvpQuestion.findMany({where: {eventId}, select: {id: true}});
  const own = new Set(existing.map(q => q.id));
  const keep = new Set(wanted.flatMap(q => (q.id && own.has(q.id) ? [q.id] : [])));
  const drop = [...own].filter(id => !keep.has(id));
  await db.$transaction([
    ...(drop.length ? [db.rsvpQuestion.deleteMany({where: {eventId, id: {in: drop}}})] : []),
    ...wanted.map(q =>
      q.id && own.has(q.id)
        ? db.rsvpQuestion.updateMany({
            where: {id: q.id, eventId},
            data: {label: q.label, type: q.type, options: q.options, required: q.required},
          })
        : db.rsvpQuestion.create({data: questionData(eventId, q, uuidV7()), select: {id: true}})
    ),
  ]);
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

/** Cursor `<sort ISO>_<id>`; anything malformed means "first page". */
function parseCursor(raw: string): {at: Date; id: string} | null {
  const [iso, id] = raw.split('_');
  const at = new Date(iso ?? '');
  return isUuid(id) && !Number.isNaN(at.getTime()) ? {at, id} : null;
}

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

const notFound = <T extends {json: (body: unknown, status: 404) => Response}>(c: T, what = 'event') =>
  c.json(problem('not_found', `No such ${what}.`), 404);

// ------------------------------------------------------------------ routes --

export const adminEventRoutes = new Hono<Env>()
  .use('*', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb)

  .get('/', listQuery, async c => {
    const {tab, before} = c.req.valid('query');
    const db = c.var.db;
    const now = new Date();
    const cursor = parseCursor(before);
    // upcoming: soonest first; past: latest first; drafts: last edited first.
    const field = tab === 'drafts' ? 'updatedAt' : 'startAt';
    const dir = tab === 'upcoming' ? 'asc' : 'desc';
    const tabWhere: Prisma.EventWhereInput =
      tab === 'drafts'
        ? {status: 'draft'}
        : tab === 'upcoming'
          ? {status: 'published', endAt: {gte: now}}
          : {OR: [{status: 'cancelled'}, {status: 'published', endAt: {lt: now}}]};
    const op = dir === 'asc' ? 'gt' : 'lt';
    const cursorWhere: Prisma.EventWhereInput = cursor
      ? {OR: [{[field]: {[op]: cursor.at}}, {[field]: cursor.at, id: {[op]: cursor.id}}]}
      : {};
    const rows = await db.event.findMany({
      select: {...summarySelect, updatedAt: true},
      where: {AND: [{deletedAt: null}, tabWhere, cursorWhere]},
      orderBy: [{[field]: dir}, {id: dir}],
      take: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const counts = await emptyCountsFor(db, page.map(e => e.id));
    const last = page.at(-1);
    return c.json({
      events: page.map(e => toSummary(e, counts.get(e.id)!)),
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

    const taken = async (slug: string) => (await db.event.findFirst({where: {slug, deletedAt: null}, select: {id: true}})) !== null;
    if (values.slug && (await taken(values.slug))) return c.json(slugTaken(), 422);
    const slug = values.slug ?? (await uniqueSlug(values.title, taken));
    const code = await withUniqueRetry(pollJoinCode, async v => (await db.event.findUnique({where: {pollJoinCode: v}, select: {id: true}})) !== null);
    const id = uuidV7();
    try {
      await db.event.create({
        data: {
          ...columnsOf(values),
          id,
          slug,
          status: 'draft',
          pollJoinCode: code,
          rsvpQuestions: {create: values.questions.map(q => ({id: uuidV7(), label: q.label, type: q.type, options: q.options, required: q.required}))},
          reminderRules: {create: settings.defaultReminderRules.map(ruleData)},
        },
        select: {id: true},
      });
    } catch (err) {
      if (isUniqueViolation(err)) return c.json(slugTaken(), 422);
      throw err;
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
    const row = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: eventSelect}) : null;
    if (!row) return notFound(c);
    const patch = c.req.valid('json');
    const questions = await db.rsvpQuestion.findMany({where: {eventId: id}, select: questionSelect, orderBy: {id: 'asc'}});
    const done = completeEvent(valuesOf(row, questions), patch);
    if (!done.ok) return c.json(invalid(done.fields), 422);
    const values = done.value;
    const slug = patch.slug ?? row.slug;
    if (slug !== row.slug && (await db.event.findFirst({where: {slug, deletedAt: null, id: {not: id}}, select: {id: true}}))) {
      return c.json(slugTaken(), 422);
    }
    try {
      await db.event.update({where: {id}, data: {...columnsOf(values), slug}, select: {id: true}});
    } catch (err) {
      if (isUniqueViolation(err)) return c.json(slugTaken(), 422);
      throw err;
    }
    if (patch.questions) await saveQuestions(db, id, values.questions);
    return c.json({event: await loadDetail(db, id)});
  })

  .post('/:id/publish', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const row = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: eventSelect}) : null;
    if (!row) return notFound(c);
    if (row.status === 'cancelled') return c.json(problem('conflict', 'A cancelled event can’t be published again.'), 409);
    if (row.status === 'published') return c.json({event: await loadDetail(db, id)});
    if (row.endAt < new Date()) return c.json(problem('conflict', 'This event has already ended. Change its dates before publishing.'), 409);
    // Drafts may be saved half done: publish only a complete event.
    const questions = await db.rsvpQuestion.findMany({where: {eventId: id}, select: questionSelect});
    const check = completeEvent(valuesOf(row, questions), {});
    if (!check.ok) return c.json({...problem('conflict', 'Fill in the missing details before publishing.'), fields: check.fields}, 409);
    await db.event.updateMany({where: {id, status: 'draft'}, data: {status: 'published'}});
    await audit(db, {actorUserId: c.var.viewer.id, action: 'event_published', target: ['event', id]});
    return c.json({event: await loadDetail(db, id)});
  })

  .post('/:id/unpublish', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const row = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: {id: true, status: true}}) : null;
    if (!row) return notFound(c);
    if (row.status === 'cancelled') return c.json(problem('conflict', 'A cancelled event can’t be unpublished.'), 409);
    if (row.status === 'published') {
      await db.event.updateMany({where: {id, status: 'published'}, data: {status: 'draft'}});
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
    if (row.status === 'cancelled') return c.json(problem('conflict', 'This event is already cancelled.'), 409);
    await db.event.updateMany({where: {id, status: {not: 'cancelled'}}, data: {status: 'cancelled'}});
    // Paid tickets become `refund_due` so the owner sees what to refund; the cancel itself already committed.
    let refundDue = 0;
    try {
      refundDue = await markEventOrdersRefundDue(db, id);
    } catch (err) {
      console.error(`event cancel: refund_due marking failed: ${(err as Error).message}`.slice(0, 200));
    }
    await audit(db, {actorUserId: c.var.viewer.id, action: 'event_cancelled', target: ['event', id], meta: {refundDue}});
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
    const [questions, tickets, rules] = await Promise.all([
      db.rsvpQuestion.findMany({where: {eventId: id}, select: questionSelect, orderBy: {id: 'asc'}}),
      db.ticketType.findMany({where: {eventId: id}, select: ticketSelect, orderBy: {id: 'asc'}}),
      db.reminderRule.findMany({where: {eventId: id}, select: {kind: true, offsetMinutes: true, enabled: true, subject: true, body: true}}),
    ]);
    const taken = async (slug: string) => (await db.event.findFirst({where: {slug, deletedAt: null}, select: {id: true}})) !== null;
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
          rsvpQuestions: {create: questions.map(q => ({id: uuidV7(), label: q.label, type: q.type, options: stringsOf(q.options), required: q.required}))},
          ticketTypes: {
            create: tickets.map(t => ({
              id: uuidV7(),
              name: t.name,
              priceCents: t.priceCents,
              currency: t.currency,
              quantity: t.quantity,
              salesEndAt: t.salesEndAt ? new Date(t.salesEndAt.getTime() + shift) : null,
            })),
          },
          reminderRules: {create: rules.map(r => ruleData({...r, kind: r.kind}))},
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
    const row = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: {id: true, status: true}}) : null;
    if (!row) return notFound(c);
    // Published and cancelled events have guests and history; only drafts can vanish.
    if (row.status !== 'draft') return c.json(problem('conflict', 'Only drafts can be deleted. Cancel the event instead.'), 409);
    await db.event.updateMany({where: {id, status: 'draft', deletedAt: null}, data: {deletedAt: new Date()}});
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
      db.ticketType.findMany({where: {eventId: id}, select: ticketSelect, orderBy: {id: 'asc'}}),
      seatsHeld(db, id),
    ]);
    const now = new Date();
    return c.json({ticketTypes: rows.map(t => toTicket(t, held.get(t.id) ?? 0, now)), currency: rows[0]?.currency ?? 'USD'});
  })

  .post('/:id/ticket-types', ticketBody(false), async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const event = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: {id: true, maxPlusOnes: true}}) : null;
    if (!event) return notFound(c);
    const input = c.req.valid('json') as TicketValues;
    const existing = await db.ticketType.findMany({where: {eventId: id}, select: {currency: true}, take: MAX_TICKET_TYPES + 1});
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
        name: input.name,
        priceCents: input.priceCents,
        currency: input.currency,
        quantity: input.quantity,
        salesEndAt: input.salesEndAt ? new Date(input.salesEndAt) : null,
      },
      select: ticketSelect,
    });
    return c.json({ticketType: toTicket(created, 0, new Date())}, 201);
  })

  .patch('/:id/ticket-types/:ticketId', ticketBody(true), async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const ticketId = c.req.param('ticketId');
    const event = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: {id: true, maxPlusOnes: true}}) : null;
    const ticket = event && isUuid(ticketId) ? await db.ticketType.findFirst({where: {id: ticketId, eventId: id}, select: ticketSelect}) : null;
    if (!event || !ticket) return notFound(c, 'ticket type');
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
    const held = await seatsHeld(db, id);
    return c.json({ticketType: toTicket(updated, held.get(ticketId) ?? 0, new Date())});
  })

  .delete('/:id/ticket-types/:ticketId', async c => {
    const db = c.var.db;
    const id = c.req.param('id');
    const ticketId = c.req.param('ticketId');
    const ticket = isUuid(id) && isUuid(ticketId) ? await db.ticketType.findFirst({where: {id: ticketId, eventId: id, event: {deletedAt: null}}, select: {id: true}}) : null;
    if (!ticket) return notFound(c, 'ticket type');
    // RSVPs (and through them orders) point at the type: end its sales instead.
    if ((await db.rsvp.count({where: {ticketTypeId: ticketId}})) > 0) {
      return c.json(problem('conflict', 'Guests already chose this ticket. Set its sales end to a past date to stop selling it.'), 409);
    }
    await db.ticketType.deleteMany({where: {id: ticketId, eventId: id}});
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
