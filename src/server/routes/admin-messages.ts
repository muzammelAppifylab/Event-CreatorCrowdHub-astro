import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {renderTemplate} from '../../domain/mergeTags';
import {keysetAfter} from '../../lib/text';
import {confirmationEmail, creatorEmail, type CreatorCopy} from '../../emails';
import type {Prisma, PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {
  emailDataFor,
  eventMailSelect,
  loadBrand,
  type MailEvent,
  type MailGuest,
  publicBase,
} from '../guest-mail';
import {enqueueGuestEmails, kickGuestEmails} from '../jobs/outbox';
import type {Db} from '../jobs/shared';
import {PERMISSIONS} from '../permissions';
import {requireEventRead} from '../guards-ext';
import {isUuid, notFound, parsePageCursor} from '../validate';

/**
 * Messages for event organisers (`site:event:manage`): broadcasts to guest
 * segments, the email preview, the message log and the automatic reminder rules.
 * Mounted at `/site-api/event-admin` (docs/ARCHITECTURE.md).
 *
 *   GET    /events/:eventId/messages?before=             the log, newest first, keyset paged
 *   GET    /events/:eventId/messages/segments            guest counts per segment
 *   POST   /events/:eventId/messages/preview             {kind, subject, body} -> rendered email
 *   POST   /events/:eventId/messages/broadcast           {segment, subject, body, expectedCount, idempotencyKey?}
 *   GET    /events/:eventId/messages/rules               reminder rules
 *   POST   /events/:eventId/messages/rules               add a rule
 *   PATCH  /events/:eventId/messages/rules/:ruleId       edit (kind is fixed)
 *   POST   /events/:eventId/messages/rules/:ruleId/toggle {enabled}
 *   DELETE /events/:eventId/messages/rules/:ruleId
 *
 * Consent: a broadcast goes to every guest in the segment, whatever their
 * marketing consent (it is event-operational mail: a room change, the replay),
 * EXCEPT guests who unsubscribed (`unsubscribed_at` set, audit M-25): they are left
 * out of the segment counts, the recipients and the outbox's send. `marketingConsent`
 * records opt-in to the host's own marketing.
 *
 * Idempotency: the composer mints a UUID `idempotencyKey` when it opens. A repeat
 * with the same key returns the first send's message (200) and sends nothing.
 *
 * Sending: a broadcast only QUEUES its emails (guest email outbox, src/server/jobs/outbox.ts) and
 * answers 201 with `queued`; the outbox sends them in batches and counts `sentCount` as they go out.
 */

export const SEGMENTS = ['going', 'maybe', 'waitlisted', 'pending', 'checked_in', 'no_show', 'all'] as const;
export type Segment = (typeof SEGMENTS)[number];
export type ReminderKind = 'confirmation' | 'reminder' | 'live_now' | 'thank_you';
export const REMINDER_KINDS: readonly ReminderKind[] = ['confirmation', 'reminder', 'live_now', 'thank_you'];

export const MESSAGE_LOG_PAGE_SIZE = 50;
/** Most guests one broadcast reaches (the request enqueues them; the guest email outbox sends). */
export const MAX_BROADCAST_RECIPIENTS = 500;
/** Broadcast emails queued per rolling 24 hours, site-wide (every event): four full broadcasts. Protects the sender's reputation and the platform's mail quota. */
export const DAILY_BROADCAST_LIMIT = 2000;
/** The one advisory lock every broadcast send takes (a fixed key: the limit is site-wide). */
export const BROADCAST_LIMIT_LOCK = 'broadcast-daily-limit';

export class DailyBroadcastLimitError extends Error {
  constructor() {
    super('Daily broadcast limit reached.');
    this.name = 'DailyBroadcastLimitError';
  }
}

/**
 * Makes room for `count` more broadcast emails under the daily limit, atomically (as
 * `reserveDailyInvites`). Call it FIRST inside the transaction that enqueues them: the
 * transaction-scoped advisory lock makes two sends count one after the other; the count (index
 * guest_email_outbox_kind_created_idx) is its own statement after the lock, so under READ COMMITTED it
 * sees every send that committed before. Throws `DailyBroadcastLimitError` (roll back, answer 409).
 */
export async function reserveDailyBroadcast(tx: Db, count: number, now: Date): Promise<void> {
  if (count <= 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${BROADCAST_LIMIT_LOCK}, 0))`;
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const queued = await tx.guestEmailOutbox.count({where: {kind: 'broadcast', createdAt: {gte: since}}});
  if (queued + count > DAILY_BROADCAST_LIMIT) throw new DailyBroadcastLimitError();
}

/** Offset bounds per kind, in minutes (negative = before the start). */
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

/* ── Segments ───────────────────────────────────────────────────────── */

type SegmentGuest = {
  response: string;
  status: string;
  checkedInAt: Date | null;
  attended: boolean | null;
};
const ACTIVE = new Set(['confirmed', 'pending', 'waitlisted', 'awaiting_payment']);

/**
 * going / maybe: confirmed with that response. waitlisted / pending: by status.
 * checked_in: scanned at the door. no_show: confirmed "going", never checked in or
 * marked attended, only once the event has ended. all: everyone still expecting it.
 */
export function inSegment(segment: Segment, guest: SegmentGuest, eventEnd: Date, now: Date): boolean {
  switch (segment) {
    case 'going':
      return guest.status === 'confirmed' && guest.response === 'going';
    case 'maybe':
      return guest.status === 'confirmed' && guest.response === 'maybe';
    case 'waitlisted':
      return guest.status === 'waitlisted';
    case 'pending':
      return guest.status === 'pending';
    case 'checked_in':
      return guest.checkedInAt != null && ACTIVE.has(guest.status);
    case 'no_show':
      return (
        now >= eventEnd &&
        guest.status === 'confirmed' &&
        guest.response === 'going' &&
        guest.checkedInAt == null &&
        guest.attended !== true
      );
    case 'all':
      return ACTIVE.has(guest.status);
  }
}

export const segmentMembers = <T extends SegmentGuest>(segment: Segment, guests: T[], eventEnd: Date, now: Date) =>
  guests.filter(g => inSegment(segment, g, eventEnd, now));

export function segmentCounts(guests: SegmentGuest[], eventEnd: Date, now: Date): Record<Segment, number> {
  const counts = Object.fromEntries(SEGMENTS.map(s => [s, 0])) as Record<Segment, number>;
  for (const guest of guests) for (const s of SEGMENTS) if (inSegment(s, guest, eventEnd, now)) counts[s] += 1;
  return counts;
}

const ACTIVE_STATUSES = [...ACTIVE] as ('confirmed' | 'pending' | 'waitlisted' | 'awaiting_payment')[];

/**
 * The same rule as `inSegment`, as a database filter, so a broadcast reads only its recipients
 * (bounded) instead of every guest of the event. `null` = nobody can be in it yet (no-shows before the end).
 */
export function segmentWhere(segment: Segment, eventEnd: Date, now: Date): Prisma.RsvpWhereInput | null {
  switch (segment) {
    case 'going':
      return {status: 'confirmed', response: 'going'};
    case 'maybe':
      return {status: 'confirmed', response: 'maybe'};
    case 'waitlisted':
      return {status: 'waitlisted'};
    case 'pending':
      return {status: 'pending'};
    case 'checked_in':
      return {checkedInAt: {not: null}, status: {in: ACTIVE_STATUSES}};
    case 'no_show':
      return now >= eventEnd
        ? {status: 'confirmed', response: 'going', checkedInAt: null, OR: [{attended: null}, {attended: false}]}
        : null;
    case 'all':
      return {status: {in: ACTIVE_STATUSES}};
  }
}

type SegmentCountRow = Record<Exclude<Segment, 'no_show'> | 'no_show_after_end', number>;

/** Every segment's size in ONE aggregate over the event's RSVPs (`rsvps_event_status_idx`), never the rows. */
async function segmentCountsOf(db: PrismaClient, eventId: string): Promise<SegmentCountRow> {
  const rows = await db.$queryRaw<SegmentCountRow[]>`
    SELECT
      (count(*) FILTER (WHERE status = 'confirmed' AND response = 'going'))::int AS going,
      (count(*) FILTER (WHERE status = 'confirmed' AND response = 'maybe'))::int AS maybe,
      (count(*) FILTER (WHERE status = 'waitlisted'))::int AS waitlisted,
      (count(*) FILTER (WHERE status = 'pending'))::int AS pending,
      (count(*) FILTER (WHERE checked_in_at IS NOT NULL
        AND status IN ('confirmed', 'pending', 'waitlisted', 'awaiting_payment')))::int AS checked_in,
      (count(*) FILTER (WHERE status = 'confirmed' AND response = 'going'
        AND checked_in_at IS NULL AND attended IS NOT TRUE))::int AS no_show_after_end,
      (count(*) FILTER (WHERE status IN ('confirmed', 'pending', 'waitlisted', 'awaiting_payment')))::int AS "all"
    FROM rsvps
    WHERE event_id = ${eventId}::uuid AND unsubscribed_at IS NULL`;
  return rows[0] ?? {going: 0, maybe: 0, waitlisted: 0, pending: 0, checked_in: 0, no_show_after_end: 0, all: 0};
}

/* ── Validation ─────────────────────────────────────────────────────── */

/** `fields` entries naming unknown merge tags, e.g. `{body: 'Unknown merge tag: {{guest.nickname}}'}`. */
export function unknownTagFields(copy: {subject?: string; body?: string}): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of ['subject', 'body'] as const) {
    const value = copy[key];
    if (value === undefined) continue;
    const unknown = renderTemplate(value, {}).unknownTags;
    if (unknown.length) {
      fields[key] = `Unknown merge tag${unknown.length > 1 ? 's' : ''}: ${unknown.map(t => `{{${t}}}`).join(', ')}`;
    }
  }
  return fields;
}

type Fields = Record<string, string>;
const invalid = (fields: Fields, message = 'Some fields need attention.') => ({...problem('invalid_input', message), fields});

function textField(value: unknown, name: string, label: string, max: number, fields: Fields): string | undefined {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) fields[name] = `Add ${label}.`;
  else if (s.length > max) fields[name] = `Keep ${label} under ${max.toLocaleString('en')} characters.`;
  else return s;
  return undefined;
}

export type RuleInput = {kind: ReminderKind; offsetMinutes: number; enabled: boolean; subject: string; body: string};

/** A full rule, as posted or after merging a patch. Returns field errors or the clean rule. */
export function checkRule(input: Record<string, unknown>): {fields: Fields} | {rule: RuleInput} {
  const fields: Fields = {};
  const kind = REMINDER_KINDS.find(k => k === input.kind);
  if (!kind) fields.kind = 'Pick a kind of email.';
  const offset = input.offsetMinutes;
  if (typeof offset !== 'number' || !Number.isInteger(offset)) fields.offsetMinutes = 'Use whole minutes.';
  else if (kind && (offset < RULE_OFFSET_LIMITS[kind].min || offset > RULE_OFFSET_LIMITS[kind].max)) {
    fields.offsetMinutes = offsetLimitMessage(kind);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fields.enabled = 'Use on or off.';
  const subject = textField(input.subject, 'subject', 'a subject', 200, fields);
  const body = textField(input.body, 'body', 'a message', 10_000, fields);
  Object.assign(fields, unknownTagFields({subject: subject ?? '', body: body ?? ''}));
  if (Object.keys(fields).length || !kind || subject === undefined || body === undefined) return {fields};
  return {rule: {kind, offsetMinutes: offset as number, enabled: input.enabled !== false, subject, body}};
}

const jsonObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const ruleBody = validator('json', (value, c) => {
  const checked = checkRule(jsonObject(value));
  return 'rule' in checked ? checked.rule : c.json(invalid(checked.fields), 422);
});

const rulePatchBody = validator('json', (value, c) => {
  const v = jsonObject(value);
  const fields: Fields = {};
  const patch: {offsetMinutes?: number; enabled?: boolean; subject?: string; body?: string} = {};
  if (v.offsetMinutes !== undefined) {
    if (typeof v.offsetMinutes === 'number' && Number.isInteger(v.offsetMinutes)) patch.offsetMinutes = v.offsetMinutes;
    else fields.offsetMinutes = 'Use whole minutes.';
  }
  if (v.enabled !== undefined) {
    if (typeof v.enabled === 'boolean') patch.enabled = v.enabled;
    else fields.enabled = 'Use on or off.';
  }
  if (v.subject !== undefined) patch.subject = textField(v.subject, 'subject', 'a subject', 200, fields);
  if (v.body !== undefined) patch.body = textField(v.body, 'body', 'a message', 10_000, fields);
  return Object.keys(fields).length ? c.json(invalid(fields), 422) : patch;
});

const toggleBody = validator('json', (value, c) => {
  const enabled = jsonObject(value).enabled;
  return typeof enabled === 'boolean' ? {enabled} : c.json(invalid({enabled: 'Use on or off.'}), 422);
});

const previewBody = validator('json', (value, c) => {
  const v = jsonObject(value);
  const kind = [...REMINDER_KINDS, 'broadcast'].find(k => k === v.kind);
  const subject = typeof v.subject === 'string' ? v.subject.slice(0, 200) : '';
  const body = typeof v.body === 'string' ? v.body.slice(0, 10_000) : '';
  if (!kind) return c.json(invalid({kind: 'Pick a kind of email.'}), 422);
  return {kind: kind as ReminderKind | 'broadcast', subject, body};
});

/**
 * Stricter than the shared `isUuid` ON PURPOSE (audit L-37): the idempotency key is minted by the
 * composer (`crypto.randomUUID()`), so anything but an RFC 4122 v1-8 key is not ours and is ignored.
 * Row ids keep the shared any-version check: seeded or imported rows need not carry RFC nibbles.
 */
const UUID_STRICT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const broadcastBody = validator('json', (value, c) => {
  const v = jsonObject(value);
  const fields: Fields = {};
  const segment = SEGMENTS.find(s => s === v.segment);
  if (!segment) fields.segment = 'Pick who to send to.';
  const subject = textField(v.subject, 'subject', 'a subject', 200, fields);
  const body = textField(v.body, 'body', 'a message', 10_000, fields);
  const expected = v.expectedCount;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) fields.expectedCount = 'Confirm the number of guests.';
  let idempotencyKey: string | null = null;
  if (v.idempotencyKey !== undefined) {
    if (typeof v.idempotencyKey === 'string' && UUID_STRICT.test(v.idempotencyKey)) idempotencyKey = v.idempotencyKey.toLowerCase();
    else fields.idempotencyKey = 'Invalid send key.';
  }
  if (Object.keys(fields).length || !segment || subject === undefined || body === undefined) {
    return c.json(invalid(fields), 422);
  }
  return {segment, subject, body, expectedCount: expected as number, idempotencyKey};
});

/* ── Responses ──────────────────────────────────────────────────────── */

const ruleSelect = {id: true, eventId: true, kind: true, offsetMinutes: true, enabled: true, subject: true, body: true} as const;
const messageSelect = {id: true, segment: true, subject: true, sentCount: true, sentBy: true, createdAt: true} as const;
/** The message plus its failed deliveries, counted in the SAME query (no second round trip by ids). */
const messageLogSelect = {
  ...messageSelect,
  _count: {select: {messageDeliveries: {where: {status: 'failed' as const}}}},
} as const;
const guestSelect = {
  id: true,
  name: true,
  email: true,
  response: true,
  status: true,
  ticketCode: true,
  waitlistPosition: true,
  checkedInAt: true,
  attended: true,
} as const;

type MessageRow = {id: string; segment: Segment; subject: string; sentCount: number; sentBy: number | null; createdAt: Date};

const logEntry = (m: MessageRow, failedCount: number) => ({
  id: m.id,
  segment: m.segment,
  subject: m.subject,
  sentCount: m.sentCount,
  failedCount,
  sentBy: m.sentBy,
  createdAt: m.createdAt.toISOString(),
});

type MessageLogRow = MessageRow & {_count: {messageDeliveries: number}};
const logEntryOf = (m: MessageLogRow) => logEntry(m, m._count.messageDeliveries);

async function loadEvent(db: PrismaClient, id: string) {
  if (!isUuid(id)) return null;
  return db.event.findFirst({where: {id, deletedAt: null}, select: eventMailSelect}) as Promise<MailEvent | null>;
}

const MANAGE = PERMISSIONS.EVENT_MANAGE;

const isUniqueViolation = (err: unknown) => (err as {code?: string} | null)?.code === 'P2002';
const isNotFound = (err: unknown) => (err as {code?: string} | null)?.code === 'P2025';

const logQuery = validator('query', v => ({before: typeof v.before === 'string' ? v.before : ''}));

export const adminMessageRoutes = new Hono()
  .get('/events/:eventId/messages/rules', withViewer, requireAuth, requireEventRead(), withDb, async c => {
    const eventId = c.req.param('eventId');
    if (!isUuid(eventId)) return notFound(c, 'Event');
    // Independent reads: one trip.
    const [event, rules] = await Promise.all([
      loadEvent(c.var.db, eventId),
      c.var.db.reminderRule.findMany({
        where: {eventId},
        select: ruleSelect,
        orderBy: [{offsetMinutes: 'asc'}, {id: 'asc'}],
        take: 100,
      }),
    ]);
    if (!event) return notFound(c, 'Event');
    return c.json({rules});
  })

  .post('/events/:eventId/messages/rules', ruleBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const eventId = c.req.param('eventId');
    if (!isUuid(eventId)) return notFound(c, 'Event');
    // The event and its rules' kinds in one trip: the kinds answer both limits below (at most 50 rules exist).
    const [event, kinds] = await Promise.all([
      loadEvent(db, eventId),
      db.reminderRule.findMany({where: {eventId}, select: {kind: true}, take: 51}),
    ]);
    if (!event) return notFound(c, 'Event');
    const input = c.req.valid('json');
    if (input.kind === 'live_now' && event.format === 'in_person') {
      return c.json(invalid({kind: 'In-person events don’t send a “we’re live” email.'}), 422);
    }
    if (input.kind === 'confirmation' && kinds.some(r => r.kind === 'confirmation')) {
      return c.json(problem('conflict', 'This event already has a confirmation email. Edit that one instead.'), 409);
    }
    if (kinds.length >= 50) {
      return c.json(problem('too_many_rules', 'An event can have up to 50 automatic emails.'), 409);
    }
    const rule = await db.reminderRule.create({data: {...input, eventId: event.id}, select: ruleSelect});
    await audit(db, {actorUserId: c.var.viewer.id, action: 'reminder_rule_created', target: ['event', event.id], meta: {ruleId: rule.id, kind: rule.kind}});
    return c.json(rule, 201);
  })

  .patch('/events/:eventId/messages/rules/:ruleId', rulePatchBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const eventId = c.req.param('eventId');
    const ruleId = c.req.param('ruleId');
    if (!isUuid(eventId) || !isUuid(ruleId)) return notFound(c, 'Rule');
    // The rule of a live (not deleted) event, in one query.
    const existing = await db.reminderRule.findFirst({where: {id: ruleId, eventId, event: {deletedAt: null}}, select: ruleSelect});
    if (!existing) return notFound(c, 'Rule');
    const patch = c.req.valid('json');
    // Offset limits depend on the kind, so check the merged rule.
    const checked = checkRule({...existing, ...patch});
    if ('fields' in checked) return c.json(invalid(checked.fields), 422);
    const {offsetMinutes, enabled, subject, body} = checked.rule;
    const rule = await db.reminderRule.update({where: {id: ruleId}, data: {offsetMinutes, enabled, subject, body}, select: ruleSelect});
    await audit(db, {actorUserId: c.var.viewer.id, action: 'reminder_rule_changed', target: ['event', eventId], meta: {ruleId, kind: rule.kind, keys: Object.keys(patch)}});
    return c.json(rule);
  })

  .post('/events/:eventId/messages/rules/:ruleId/toggle', toggleBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const ruleId = c.req.param('ruleId');
    const eventId = c.req.param('eventId');
    if (!isUuid(ruleId) || !isUuid(eventId)) return notFound(c, 'Rule');
    // One write that returns the row; the event id in the WHERE scopes it (P2025: no such rule there).
    try {
      const rule = await c.var.db.reminderRule.update({
        where: {id: ruleId, eventId},
        data: {enabled: c.req.valid('json').enabled},
        select: ruleSelect,
      });
      await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'reminder_rule_toggled', target: ['event', eventId], meta: {ruleId, kind: rule.kind, enabled: rule.enabled}});
      return c.json(rule);
    } catch (err) {
      if (isNotFound(err)) return notFound(c, 'Rule');
      throw err;
    }
  })

  .delete('/events/:eventId/messages/rules/:ruleId', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const ruleId = c.req.param('ruleId');
    const eventId = c.req.param('eventId');
    if (!isUuid(ruleId) || !isUuid(eventId)) return notFound(c, 'Rule');
    const {count} = await c.var.db.reminderRule.deleteMany({where: {id: ruleId, eventId}});
    if (!count) return notFound(c, 'Rule');
    await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'reminder_rule_deleted', target: ['event', eventId], meta: {ruleId}});
    return c.json({ok: true});
  })

  .post('/events/:eventId/messages/preview', previewBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const eventId = c.req.param('eventId');
    if (!isUuid(eventId)) return notFound(c, 'Event');
    const input = c.req.valid('json');
    // Independent reads: the event, the first confirmed guest and the brand travel together.
    const [event, found, brand] = await Promise.all([
      loadEvent(db, eventId),
      db.rsvp.findFirst({
        where: {eventId, status: 'confirmed'},
        select: {id: true, name: true, email: true, response: true, status: true, ticketCode: true, waitlistPosition: true},
        orderBy: [{createdAt: 'asc'}, {id: 'asc'}],
      }),
      loadBrand(db, c.req.url),
    ]);
    if (!event) return notFound(c, 'Event');
    const guest: MailGuest = found ?? {
      id: '00000000-0000-4000-8000-000000000000',
      name: 'Sam Rivera',
      email: 'sam@example.com',
      response: 'going',
      status: 'confirmed',
      ticketCode: 'AB23CD45',
      waitlistPosition: null,
    };
    const data = emailDataFor(publicBase(c.req.url), event, guest, brand);
    const copy: CreatorCopy = {subject: input.subject, body: input.body};
    // Unknown tags do not fail a preview: the editor shows them as a warning while typing.
    const unknownTags = [...new Set([...renderTemplate(copy.subject, {}).unknownTags, ...renderTemplate(copy.body, {}).unknownTags])];
    const email = input.kind === 'confirmation' ? confirmationEmail(data, copy) : creatorEmail(input.kind, data, copy);
    return c.json({subject: email.subject, html: email.html, text: email.text, recipient: {name: guest.name, sample: !found}, unknownTags});
  })

  .get('/events/:eventId/messages/segments', withViewer, requireAuth, requireEventRead(), withDb, async c => {
    const {db} = c.var;
    const eventId = c.req.param('eventId');
    if (!isUuid(eventId)) return notFound(c, 'Event');
    const [event, row] = await Promise.all([loadEvent(db, eventId), segmentCountsOf(db, eventId)]);
    if (!event) return notFound(c, 'Event');
    const now = new Date();
    const ended = now >= event.endAt;
    const {no_show_after_end, ...rest} = row;
    const counts: Record<Segment, number> = {...rest, no_show: ended ? no_show_after_end : 0};
    return c.json({counts, eventEnded: ended});
  })

  .get('/events/:eventId/messages', logQuery, withViewer, requireAuth, requireEventRead(), withDb, async c => {
    const {db} = c.var;
    const eventId = c.req.param('eventId');
    if (!isUuid(eventId)) return notFound(c, 'Event');
    const cursor = parsePageCursor(c.req.valid('query').before);
    // The event and one page of the log (failed counts in the same query) in one trip.
    const [event, rows] = await Promise.all([
      loadEvent(db, eventId),
      db.message.findMany({
        where: {
          eventId,
          // Millisecond cursor vs microsecond column: `keysetAfter` compares at the cursor's precision.
          ...(cursor ? keysetAfter('createdAt', 'desc', cursor) : {}),
        },
        select: messageLogSelect,
        orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
        take: MESSAGE_LOG_PAGE_SIZE + 1,
      }),
    ]);
    if (!event) return notFound(c, 'Event');
    const page = rows.slice(0, MESSAGE_LOG_PAGE_SIZE) as MessageLogRow[];
    const items = page.map(logEntryOf);
    const last = page.at(-1);
    return c.json({items, nextBefore: rows.length > MESSAGE_LOG_PAGE_SIZE && last ? `${last.createdAt.toISOString()}_${last.id}` : null});
  })

  .post('/events/:eventId/messages/broadcast', broadcastBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const eventId = c.req.param('eventId');
    if (!isUuid(eventId)) return notFound(c, 'Event');
    const input = c.req.valid('json');

    const alreadySent = async () => {
      if (!input.idempotencyKey) return null;
      const previous = (await db.message.findFirst({
        where: {eventId, idempotencyKey: input.idempotencyKey},
        select: messageLogSelect,
      })) as MessageLogRow | null;
      if (!previous) return null;
      return {message: logEntryOf(previous), failed: previous._count.messageDeliveries};
    };
    // The event, an earlier send with this key, and the brand: independent reads, one trip.
    const [event, again] = await Promise.all([loadEvent(db, eventId), alreadySent()]);
    if (!event) return notFound(c, 'Event');
    // Before any other check: a retry of a send that went through must not 409 on a changed count.
    if (again) return c.json(again, 200);

    const unknown = unknownTagFields(input);
    if (Object.keys(unknown).length) return c.json(invalid(unknown, 'Some merge tags aren’t recognised.'), 422);
    if (event.status === 'draft') return c.json(problem('conflict', 'Publish the event before messaging guests.'), 409);

    const now = new Date();
    // Only the segment's guests, one past the cap (the cap check below must see it), never the whole guest list.
    const where = segmentWhere(input.segment, event.endAt, now);
    // M-25: guests who unsubscribed are never recipients (the same filter as the segment counts, in the same query).
    const guests = where
      ? await db.rsvp.findMany({
          where: {eventId, ...where, unsubscribedAt: null},
          select: guestSelect,
          orderBy: {id: 'asc'},
          take: MAX_BROADCAST_RECIPIENTS + 1,
        })
      : [];
    const recipients = segmentMembers(input.segment, guests, event.endAt, now);
    if (recipients.length === 0) return c.json(invalid({segment: 'No guests in this segment yet.'}), 422);
    if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
      return c.json(invalid({segment: `A message can reach up to ${MAX_BROADCAST_RECIPIENTS} guests. Pick a smaller segment.`}), 422);
    }
    if (recipients.length !== input.expectedCount) {
      const n = recipients.length;
      return c.json(
        problem('conflict', `This segment now has ${n} guest${n === 1 ? '' : 's'}, not ${input.expectedCount}. Check the count and send again.`),
        409
      );
    }

    // The message, its delivery rows and one outbox row per guest: ONE transaction, so a send is
    // either fully queued or not at all. The request only enqueues (audit M-21); the guest email
    // outbox sends in bounded batches, with retries, and counts `sentCount` as emails go out.
    let message: MessageRow;
    try {
      message = await db.$transaction(async tx => {
        await reserveDailyBroadcast(tx, recipients.length, now);
        const created = (await tx.message.create({
          data: {
            eventId: event.id,
            segment: input.segment,
            subject: input.subject,
            body: input.body,
            sentBy: c.var.viewer.id ?? null,
            idempotencyKey: input.idempotencyKey,
          },
          select: messageSelect,
        })) as MessageRow;
        // The guest ids were read by this request (<= 500), never sent by the client.
        await tx.messageDelivery.createMany({
          data: recipients.map(g => ({rsvpId: g.id, messageId: created.id, status: 'queued' as const})),
        });
        await enqueueGuestEmails(
          tx,
          recipients.map(g => ({key: `broadcast-${created.id}-${g.id}`, kind: 'broadcast' as const, rsvpId: g.id, messageId: created.id})),
          now
        );
        return created;
      });
    } catch (err) {
      if (err instanceof DailyBroadcastLimitError) {
        return c.json(problem('daily_broadcast_limit', `Guests can be sent up to ${DAILY_BROADCAST_LIMIT} messages a day across all events. Try again tomorrow, or pick a smaller segment.`), 409);
      }
      // Two identical requests raced past the lookup: the unique index let one through.
      const winner = isUniqueViolation(err) ? await alreadySent() : null;
      if (winner) return c.json(winner, 200);
      throw err;
    }
    const queued = recipients.length;
    await audit(db, {actorUserId: c.var.viewer.id, action: 'message_broadcast', target: ['event', event.id], meta: {queued}});
    await kickGuestEmails();
    // Locally the kick has already sent them; live, `sentCount` grows as the outbox sends.
    const fresh = await db.message.findUnique({where: {id: message.id}, select: messageLogSelect});
    const entry = fresh ? logEntryOf(fresh as MessageLogRow) : logEntry(message, 0);
    return c.json({message: entry, failed: entry.failedCount, queued}, 201);
  });
