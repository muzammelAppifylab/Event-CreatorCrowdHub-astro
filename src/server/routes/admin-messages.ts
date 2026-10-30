import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {renderTemplate} from '../../domain/mergeTags';
import {confirmationEmail, creatorEmail, type CreatorCopy} from '../../emails';
import type {PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {
  emailDataFor,
  eventMailSelect,
  loadBrand,
  type MailEvent,
  type MailGuest,
  publicBase,
  sendMail,
} from '../guest-mail';
import {PERMISSIONS} from '../permissions';
import {isUuid} from './admin-invites';

/**
 * Messages for event organisers (`site:event:manage`): broadcasts to guest
 * segments, the email preview, the message log and the automatic reminder rules.
 * Mounted at `/site-api/event-admin` (docs/porting/guests.md).
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
 * marketing consent. It is event-operational mail (a room change, the replay),
 * like reminders; `marketingConsent` records opt-in to the host's own marketing.
 *
 * Idempotency: the composer mints a UUID `idempotencyKey` when it opens. A repeat
 * with the same key returns the first send's message (200) and sends nothing.
 */

export const SEGMENTS = ['going', 'maybe', 'waitlisted', 'pending', 'checked_in', 'no_show', 'all'] as const;
export type Segment = (typeof SEGMENTS)[number];
export type ReminderKind = 'confirmation' | 'reminder' | 'live_now' | 'thank_you';
export const REMINDER_KINDS: readonly ReminderKind[] = ['confirmation', 'reminder', 'live_now', 'thank_you'];

export const MESSAGE_LOG_PAGE_SIZE = 50;
/** Most guests one broadcast reaches (a Worker request makes a bounded number of calls). */
export const MAX_BROADCAST_RECIPIENTS = 500;
const SEND_CONCURRENCY = 5;

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

async function failedCounts(db: PrismaClient, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const groups = await db.messageDelivery.groupBy({
    by: ['messageId'],
    where: {messageId: {in: ids}, status: 'failed'},
    _count: {_all: true},
  });
  return new Map(groups.map(g => [g.messageId ?? '', g._count._all]));
}

async function loadEvent(db: PrismaClient, id: string) {
  if (!isUuid(id)) return null;
  return db.event.findFirst({where: {id, deletedAt: null}, select: eventMailSelect}) as Promise<MailEvent | null>;
}

const MANAGE = PERMISSIONS.EVENT_MANAGE;
const notFound = (what: string) => problem('not_found', `${what} not found.`);

/** `<createdAt ISO>_<id>`; anything malformed means the first page. */
function parseCursor(raw: string): {at: Date; id: string} | null {
  const [iso, id] = raw.split('_');
  const at = new Date(iso ?? '');
  return id && isUuid(id) && !Number.isNaN(at.getTime()) ? {at, id} : null;
}

const isUniqueViolation = (err: unknown) => (err as {code?: string} | null)?.code === 'P2002';

const logQuery = validator('query', v => ({before: typeof v.before === 'string' ? v.before : ''}));

export const adminMessageRoutes = new Hono()
  .get('/events/:eventId/messages/rules', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const event = await loadEvent(c.var.db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const rules = await c.var.db.reminderRule.findMany({
      where: {eventId: event.id},
      select: ruleSelect,
      orderBy: [{offsetMinutes: 'asc'}, {id: 'asc'}],
      take: 100,
    });
    return c.json({rules});
  })

  .post('/events/:eventId/messages/rules', ruleBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const input = c.req.valid('json');
    if (input.kind === 'live_now' && event.format === 'in_person') {
      return c.json(invalid({kind: 'In-person events don’t send a “we’re live” email.'}), 422);
    }
    if (input.kind === 'confirmation' && (await db.reminderRule.count({where: {eventId: event.id, kind: 'confirmation'}})) > 0) {
      return c.json(problem('conflict', 'This event already has a confirmation email. Edit that one instead.'), 409);
    }
    if ((await db.reminderRule.count({where: {eventId: event.id}})) >= 50) {
      return c.json(problem('too_many_rules', 'An event can have up to 50 automatic emails.'), 409);
    }
    const rule = await db.reminderRule.create({data: {...input, eventId: event.id}, select: ruleSelect});
    return c.json(rule, 201);
  })

  .patch('/events/:eventId/messages/rules/:ruleId', rulePatchBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    const ruleId = c.req.param('ruleId');
    if (!event || !isUuid(ruleId)) return c.json(notFound('Rule'), 404);
    const existing = await db.reminderRule.findFirst({where: {id: ruleId, eventId: event.id}, select: ruleSelect});
    if (!existing) return c.json(notFound('Rule'), 404);
    const patch = c.req.valid('json');
    // Offset limits depend on the kind, so check the merged rule.
    const checked = checkRule({...existing, ...patch});
    if ('fields' in checked) return c.json(invalid(checked.fields), 422);
    const {offsetMinutes, enabled, subject, body} = checked.rule;
    const rule = await db.reminderRule.update({where: {id: ruleId}, data: {offsetMinutes, enabled, subject, body}, select: ruleSelect});
    return c.json(rule);
  })

  .post('/events/:eventId/messages/rules/:ruleId/toggle', toggleBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const ruleId = c.req.param('ruleId');
    const eventId = c.req.param('eventId');
    if (!isUuid(ruleId) || !isUuid(eventId)) return c.json(notFound('Rule'), 404);
    const {count} = await c.var.db.reminderRule.updateMany({
      where: {id: ruleId, eventId},
      data: {enabled: c.req.valid('json').enabled},
    });
    if (!count) return c.json(notFound('Rule'), 404);
    const rule = await c.var.db.reminderRule.findFirst({where: {id: ruleId, eventId}, select: ruleSelect});
    return rule ? c.json(rule) : c.json(notFound('Rule'), 404);
  })

  .delete('/events/:eventId/messages/rules/:ruleId', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const ruleId = c.req.param('ruleId');
    const eventId = c.req.param('eventId');
    if (!isUuid(ruleId) || !isUuid(eventId)) return c.json(notFound('Rule'), 404);
    const {count} = await c.var.db.reminderRule.deleteMany({where: {id: ruleId, eventId}});
    return count ? c.json({ok: true}) : c.json(notFound('Rule'), 404);
  })

  .post('/events/:eventId/messages/preview', previewBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const input = c.req.valid('json');
    const found = await db.rsvp.findFirst({
      where: {eventId: event.id, status: 'confirmed'},
      select: {id: true, name: true, email: true, response: true, status: true, ticketCode: true, waitlistPosition: true},
      orderBy: {createdAt: 'asc'},
    });
    const guest: MailGuest = found ?? {
      id: '00000000-0000-4000-8000-000000000000',
      name: 'Sam Rivera',
      email: 'sam@example.com',
      response: 'going',
      status: 'confirmed',
      ticketCode: 'AB23CD45',
      waitlistPosition: null,
    };
    const data = emailDataFor(publicBase(c.req.url), event, guest, await loadBrand(db));
    const copy: CreatorCopy = {subject: input.subject, body: input.body};
    // Unknown tags do not fail a preview: the editor shows them as a warning while typing.
    const unknownTags = [...new Set([...renderTemplate(copy.subject, {}).unknownTags, ...renderTemplate(copy.body, {}).unknownTags])];
    const email = input.kind === 'confirmation' ? confirmationEmail(data, copy) : creatorEmail(input.kind, data, copy);
    return c.json({subject: email.subject, html: email.html, text: email.text, recipient: {name: guest.name, sample: !found}, unknownTags});
  })

  .get('/events/:eventId/messages/segments', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const guests = await db.rsvp.findMany({
      where: {eventId: event.id},
      select: {response: true, status: true, checkedInAt: true, attended: true},
      take: 20_000,
    });
    const now = new Date();
    return c.json({counts: segmentCounts(guests, event.endAt, now), eventEnded: now >= event.endAt});
  })

  .get('/events/:eventId/messages', logQuery, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const cursor = parseCursor(c.req.valid('query').before);
    const rows = await db.message.findMany({
      where: {
        eventId: event.id,
        ...(cursor ? {OR: [{createdAt: {lt: cursor.at}}, {createdAt: cursor.at, id: {lt: cursor.id}}]} : {}),
      },
      select: messageSelect,
      orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
      take: MESSAGE_LOG_PAGE_SIZE + 1,
    });
    const page = rows.slice(0, MESSAGE_LOG_PAGE_SIZE) as MessageRow[];
    const failed = await failedCounts(db, page.map(m => m.id));
    const items = page.map(m => logEntry(m, failed.get(m.id) ?? 0));
    const last = page.at(-1);
    return c.json({items, nextBefore: rows.length > MESSAGE_LOG_PAGE_SIZE && last ? `${last.createdAt.toISOString()}_${last.id}` : null});
  })

  .post('/events/:eventId/messages/broadcast', broadcastBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await loadEvent(db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const input = c.req.valid('json');

    const alreadySent = async () => {
      if (!input.idempotencyKey) return null;
      const previous = await db.message.findFirst({
        where: {eventId: event.id, idempotencyKey: input.idempotencyKey},
        select: messageSelect,
      });
      if (!previous) return null;
      const failed = (await failedCounts(db, [previous.id])).get(previous.id) ?? 0;
      return {message: logEntry(previous as MessageRow, failed), failed};
    };
    // Before any other check: a retry of a send that went through must not 409 on a changed count.
    const again = await alreadySent();
    if (again) return c.json(again, 200);

    const unknown = unknownTagFields(input);
    if (Object.keys(unknown).length) return c.json(invalid(unknown, 'Some merge tags aren’t recognised.'), 422);
    if (event.status === 'draft') return c.json(problem('conflict', 'Publish the event before messaging guests.'), 409);

    const now = new Date();
    const guests = await db.rsvp.findMany({where: {eventId: event.id}, select: guestSelect, take: 20_000});
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

    let message: MessageRow;
    try {
      message = (await db.message.create({
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
    } catch (err) {
      // Two identical requests raced past the lookup: the unique index let one through.
      const winner = isUniqueViolation(err) ? await alreadySent() : null;
      if (winner) return c.json(winner, 200);
      throw err;
    }

    await db.messageDelivery.createMany({
      data: recipients.map(g => ({rsvpId: g.id, messageId: message.id, status: 'queued' as const})),
    });
    const brand = await loadBrand(db);
    const base = publicBase(c.req.url);
    const copy: CreatorCopy = {subject: input.subject, body: input.body};
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < recipients.length; i += SEND_CONCURRENCY) {
      const batch = recipients.slice(i, i + SEND_CONCURRENCY);
      await Promise.all(
        batch.map(async guest => {
          const email = creatorEmail('broadcast', emailDataFor(base, event, guest as MailGuest, brand, now), copy);
          const result = await sendMail({
            to: guest.email,
            subject: email.subject,
            html: email.html,
            text: email.text,
            replyTo: brand.replyToEmail ?? undefined,
          });
          if (result.ok) sent += 1;
          else failed += 1;
          await db.messageDelivery.updateMany({
            where: {messageId: message.id, rsvpId: guest.id},
            data: result.ok ? {status: 'sent', sentAt: new Date()} : {status: 'failed', error: 'send_failed'},
          });
        })
      );
    }
    await db.message.update({where: {id: message.id}, data: {sentCount: sent}, select: {id: true}});
    await audit(db, {actorUserId: c.var.viewer.id, action: 'message_broadcast', target: ['event', event.id], meta: {sent, failed}});
    return c.json({message: logEntry({...message, sentCount: sent}, failed), failed}, 201);
  });
