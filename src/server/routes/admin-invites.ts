import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {formatInZone} from '../../domain/time';
import {signToken} from '../../domain/tokens';
import {button, details, esc, paragraph, renderLayout, renderText} from '../../emails/layout';
import type {EmailBrand, EmailContent} from '../../emails/types';
import {audit} from '../../platform/auth';
import {config} from '../../platform/config';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {eventMailSelect, inviteLink, type MailEvent, publicBase} from '../guest-mail';
import {enqueueGuestEmails, kickGuestEmails} from '../jobs/outbox';
import type {Db} from '../jobs/shared';
import {PERMISSIONS} from '../permissions';
import {requireEventRead} from '../guards-ext';
import {isUuid, notFound} from '../validate';

/**
 * Guest invites, for event organisers (`site:event:manage`). Mounted by the
 * app at `/site-api/event-admin` (docs/ARCHITECTURE.md), so paths here start
 * with `/events/:eventId/invites`.
 *
 *   GET    /events/:eventId/invites?before=         invites, by email, keyset paged
 *   POST   /events/:eventId/invites                 {emails}: paste box, "Name <email>" allowed
 *   GET    /events/:eventId/invites/resend-preview  how many non-responders a resend reaches
 *   POST   /events/:eventId/invites/resend          nudge every non-responder (48 h cooldown)
 *   POST   /events/:eventId/invites/:inviteId/resend  nudge one invite (same 48 h cooldown)
 *   DELETE /events/:eventId/invites/:inviteId       delete (revokes its link)
 *   GET    /events/:eventId/share-kit               the public event link for the share kit
 *
 * Invite tokens are HMAC-signed with `config.jwtSecret` (`signToken('invite', ...)`);
 * the public `/i/<token>` route must also require the row, so deleting an invite revokes it.
 * Emails are QUEUED in the guest email outbox (src/server/jobs/outbox.ts), never sent by the request.
 */

export const INVITES_PAGE_SIZE = 100;
/** Most invites created, or resent, by one request (a Worker request can only make so many calls). */
export const MAX_INVITES_PER_REQUEST = 200;
/** Invite emails per rolling 24 hours, across every event. */
export const DAILY_INVITE_LIMIT = 2000;
/** A nudge goes out at most once per this window. */
export const RESEND_COOLDOWN_HOURS = 48;

/** The shared id check (audit L-37), re-exported: `admin-guests.ts` and the tests import it from here. */
export {isUuid};

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;.]+(?:\.[^\s@<>",;.]+)+$/;
/** A plain address, trimmed and lowercased, or null. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/* ── Paste parsing ──────────────────────────────────────────────────── */

export interface ParsedRecipient {
  email: string;
  name: string | null;
}

// `Name <email>` or `"Name" <email>`; names cannot contain "@" so a bare address before a named one is not swallowed.
const NAMED = /(?<=^|[,;\n])\s*(?:"([^"]*)"|([^,;<>\n"@]*?))\s*<([^<>\s]*)>/g;

/**
 * Splits a pasted list into recipients: commas, semicolons, newlines and spaces
 * separate entries; `Name <email>` is understood. Emails are lowercased; a repeat keeps the first.
 */
export function parseEmailList(input: string): {valid: ParsedRecipient[]; invalid: string[]; repeated: string[]} {
  const tokens: {raw: string; email: string; name: string | null}[] = [];
  const rest = input.replace(NAMED, (_m, quoted: string | undefined, bare: string | undefined, address: string) => {
    const name = (quoted ?? bare ?? '').trim().replace(/\s+/g, ' ');
    tokens.push({raw: address.trim(), email: address, name: name || null});
    return '\n';
  });
  for (const raw of rest.split(/[\s,;]+/)) {
    if (raw) tokens.push({raw, email: raw.replace(/^<|>$/g, ''), name: null});
  }
  const valid: ParsedRecipient[] = [];
  const invalid: string[] = [];
  const repeated = new Set<string>();
  const seen = new Set<string>();
  for (const token of tokens) {
    const email = normalizeEmail(token.email);
    if (!email) {
      invalid.push(token.raw.slice(0, 120) || `${token.name ?? ''} <>`.trim());
      continue;
    }
    if (seen.has(email)) {
      repeated.add(email);
      continue;
    }
    seen.add(email);
    valid.push({email, name: token.name ? token.name.slice(0, 120) : null});
  }
  return {valid, invalid, repeated: [...repeated]};
}

/** Invites that can be nudged: no RSVP, not bounced, last contacted 48 h ago or never. */
export function isResendable(
  invite: {status: string; hasRsvp: boolean; sentAt: Date | null; lastResentAt: Date | null},
  now: Date
): boolean {
  if (invite.hasRsvp || invite.status === 'responded' || invite.status === 'bounced') return false;
  const last = invite.lastResentAt ?? invite.sentAt;
  return !last || now.getTime() - last.getTime() >= RESEND_COOLDOWN_HOURS * 3_600_000;
}

/* ── Email ──────────────────────────────────────────────────────────── */

export function inviteEmail(
  event: Pick<MailEvent, 'title' | 'startAt' | 'timezone' | 'format' | 'venueName' | 'venueAddress'>,
  brand: EmailBrand,
  invite: {name: string | null},
  link: string
): EmailContent {
  const when = formatInZone(event.startAt, event.timezone);
  const where = event.format === 'online' ? 'Online' : [event.venueName, event.venueAddress].filter(Boolean).join(', ');
  const greeting = invite.name ? `Hi ${invite.name},` : 'Hi,';
  const subject = `You're invited: ${event.title}`;
  const intro = `${brand.senderName} has invited you to ${event.title}. RSVP takes under a minute and needs no account.`;
  const html = renderLayout({
    brand,
    subject,
    preheader: intro,
    heading: event.title,
    blocks: [
      paragraph(esc(greeting)),
      paragraph(esc(intro)),
      details([
        ['When', esc(when)],
        ['Where', esc(where || 'Details on the event page')],
      ]),
      button('RSVP now', link, brand),
    ],
  });
  const text = renderText({
    heading: event.title,
    paragraphs: [greeting, intro],
    details: [
      ['When', when],
      ['Where', where || 'Details on the event page'],
    ],
    links: [['RSVP', link]],
    senderName: brand.senderName,
  });
  return {subject, html, text};
}

/* ── Routes ─────────────────────────────────────────────────────────── */

const MANAGE = PERMISSIONS.EVENT_MANAGE;

const inviteSelect = {
  id: true,
  email: true,
  name: true,
  token: true,
  status: true,
  sentAt: true,
  lastResentAt: true,
  rsvps: {select: {response: true}, take: 1},
} as const;

type InviteRow = {
  id: string;
  email: string;
  name: string | null;
  token: string;
  status: 'queued' | 'sent' | 'bounced' | 'responded';
  sentAt: Date | null;
  lastResentAt: Date | null;
  rsvps: {response: 'going' | 'maybe' | 'not_going'}[];
};

function toInvite(row: InviteRow, base: string, slug: string) {
  const rsvpResponse = row.rsvps[0]?.response ?? null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: rsvpResponse !== null || row.status === 'responded' ? ('responded' as const) : row.status,
    rsvpResponse,
    sentAt: row.sentAt?.toISOString() ?? null,
    lastResentAt: row.lastResentAt?.toISOString() ?? null,
    link: inviteLink(base, row.token, slug),
  };
}


async function eventFor(db: PrismaClient, id: string) {
  if (!isUuid(id)) return null;
  return db.event.findFirst({where: {id, deletedAt: null}, select: eventMailSelect}) as Promise<MailEvent | null>;
}

/**
 * Queues invite emails as guest email outbox rows, in one insert (audit M-21: a request never
 * sends hundreds of emails itself). The outbox renders and sends each one, marks the invite `sent`
 * (keeping the first send time) and retries failures. `round` makes each send its own email: the
 * first send, or one resend. Pass the transaction client to queue atomically. Returns the queued ids.
 */
async function queueInvites(db: Db, invites: {id: string}[], now: Date, round: string): Promise<string[]> {
  if (!invites.length) return [];
  await enqueueGuestEmails(
    db,
    invites.map(invite => ({key: `invite-${invite.id}-${round}`, kind: 'invite' as const, inviteId: invite.id})),
    now
  );
  return invites.map(invite => invite.id);
}

/**
 * Invite emails queued in the last 24 hours, across every event (index on kind + created_at).
 * M-15: every first send, bulk resend and single resend is its own outbox row, and a deleted then
 * re-created invite gets a new id (a new row): none of them gets around the daily limit.
 */
async function sentInLastDay(db: Db, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  return db.guestEmailOutbox.count({where: {kind: 'invite', createdAt: {gte: since}}});
}

/** The one advisory lock every invite send takes (a fixed key: the limit is site-wide). */
export const INVITE_LIMIT_LOCK = 'invite-daily-limit';

export class DailyInviteLimitError extends Error {
  constructor() {
    super('Daily invite limit reached.');
    this.name = 'DailyInviteLimitError';
  }
}

const dailyLimitProblem = () => problem('daily_invite_limit', 'Daily invite limit reached. Try again tomorrow.');

/**
 * Makes room for `count` more invite emails under the daily limit, atomically (audit M-15). Call it
 * FIRST inside the transaction that queues them: it takes a transaction-scoped advisory lock, so two
 * sends at the same moment count one after the other and can't both pass. The count is its own
 * statement, after the lock: under READ COMMITTED it then sees every send that committed before the
 * lock was granted. The lock ends with the transaction (keep it short: database work only).
 * Throws `DailyInviteLimitError` (roll back, answer 409) when it doesn't fit.
 */
export async function reserveDailyInvites(tx: Db, count: number, now: Date): Promise<void> {
  if (count <= 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${INVITE_LIMIT_LOCK}, 0))`;
  if ((await sentInLastDay(tx, now)) + count > DAILY_INVITE_LIMIT) throw new DailyInviteLimitError();
}

/** Runs `work`, answering null instead of throwing when the daily limit refused it (the transaction rolled back). */
async function withinDailyLimit<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof DailyInviteLimitError) return null;
    throw err;
  }
}

const listQuery = validator('query', value => ({
  before: typeof value.before === 'string' ? value.before.slice(0, 254) : '',
}));

const createBody = validator('json', (value, c) => {
  const emails = (value as {emails?: unknown} | null)?.emails;
  if (typeof emails !== 'string' || !emails.trim() || emails.length > 200_000) {
    const message = 'Paste at least one email address.';
    return c.json({...problem('invalid_input', message), fields: {emails: message}}, 422);
  }
  return {emails};
});

export const adminInviteRoutes = new Hono()
  .get('/events/:eventId/invites', listQuery, withViewer, requireAuth, requireEventRead(), withDb, async c => {
    const event = await eventFor(c.var.db, c.req.param('eventId'));
    if (!event) return notFound(c, 'Event');
    const before = c.req.valid('query').before.toLowerCase();
    const rows = await c.var.db.invite.findMany({
      where: {eventId: event.id, ...(before ? {email: {gt: before}} : {})},
      select: inviteSelect,
      orderBy: {email: 'asc'},
      take: INVITES_PAGE_SIZE + 1,
    });
    const base = publicBase(c.req.url);
    const items = rows.slice(0, INVITES_PAGE_SIZE).map(row => toInvite(row as InviteRow, base, event.slug));
    return c.json({items, nextBefore: rows.length > INVITES_PAGE_SIZE ? items.at(-1)!.email : null});
  })

  .post('/events/:eventId/invites', withViewer, requireAuth, requirePermission(MANAGE), createBody, withDb, async c => {
    const {db} = c.var;
    const event = await eventFor(db, c.req.param('eventId'));
    if (!event) return notFound(c, 'Event');
    if (event.status === 'cancelled') {
      return c.json(problem('event_cancelled', "This event is cancelled, so it can't take new invites."), 409);
    }
    // M-14: a draft has no public page yet, so an invite link would be dead. Publish first.
    if (event.status !== 'published') {
      return c.json(problem('event_not_published', 'Publish this event before sending invites: until then the invite link has no page to open.'), 409);
    }
    const secret = config.jwtSecret;
    if (!secret) return c.json(problem('auth_not_configured', 'This site cannot sign invite links yet.'), 503);

    const parsed = parseEmailList(c.req.valid('json').emails);
    if (parsed.valid.length > MAX_INVITES_PER_REQUEST) {
      const message = `Invite up to ${MAX_INVITES_PER_REQUEST} people at a time.`;
      return c.json({...problem('invalid_input', message), fields: {emails: message}}, 422);
    }
    // An address already invited to this event is never re-sent (the pasted list is capped above).
    const now = new Date();
    const already = parsed.valid.length
      ? await db.invite.findMany({where: {eventId: event.id, email: {in: parsed.valid.map(r => r.email)}}, select: {email: true}})
      : [];
    const existing = new Set(already.map(r => r.email));
    const fresh = parsed.valid.filter(r => !existing.has(r.email));
    const skippedDuplicate = [...parsed.repeated, ...parsed.valid.filter(r => existing.has(r.email)).map(r => r.email)];

    // One insert for the whole paste; a row a concurrent paste inserted first (unique per event and email) is skipped.
    const rows = fresh.map(recipient => {
      const id = crypto.randomUUID();
      return {id, eventId: event.id, email: recipient.email, name: recipient.name, token: signToken('invite', {eventId: event.id, inviteId: id}, secret)};
    });
    // The limit check, the invites and their outbox rows in ONE short transaction (M-15: the check and
    // the insert are atomic; every created invite has its email queued).
    const inserted = rows.length
      ? await withinDailyLimit(() =>
          db.$transaction(async tx => {
            await reserveDailyInvites(tx, rows.length, now);
            const ids = new Set((await tx.invite.createManyAndReturn({data: rows, skipDuplicates: true, select: {id: true}})).map(r => r.id));
            await queueInvites(tx, [...ids].map(id => ({id})), now, 'first');
            return ids;
          })
        )
      : new Set<string>();
    if (!inserted) return c.json(dailyLimitProblem(), 409);
    const created = rows.filter(r => inserted.has(r.id)).map(({id, email, name, token}) => ({id, email, name, token}));
    for (const r of rows) if (!inserted.has(r.id)) skippedDuplicate.push(r.email);

    // `sent` = handed to the outbox, which sends within seconds (and retries); the list shows each invite's status.
    await audit(db, {actorUserId: c.var.viewer.id, action: 'invites_sent', target: ['event', event.id], meta: {queued: created.length}});
    if (created.length) await kickGuestEmails();
    return c.json({queued: created.length, sent: created.length, skippedInvalid: parsed.invalid, skippedDuplicate}, 201);
  })

  .get('/events/:eventId/invites/resend-preview', withViewer, requireAuth, requireEventRead(), withDb, async c => {
    const event = await eventFor(c.var.db, c.req.param('eventId'));
    if (!event) return notFound(c, 'Event');
    // Counted in the database by `resendableSql`, the same rule the resend picks its targets and total by
    // (leaving out invites whose email is still waiting in the outbox). One query.
    const [row] = await c.var.db.$queryRaw<{count: number}[]>`
      SELECT count(*)::int AS count ${resendableSql(event.id, new Date())}`;
    return c.json({count: row?.count ?? 0});
  })

  .post('/events/:eventId/invites/resend', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await eventFor(db, c.req.param('eventId'));
    if (!event) return notFound(c, 'Event');
    if (event.status === 'cancelled') {
      return c.json(problem('event_cancelled', "This event is cancelled, so invites can't be resent."), 409);
    }
    // M-14: a draft has no public page yet, so an invite link would be dead. Publish first.
    if (event.status !== 'published') {
      return c.json(problem('event_not_published', 'Publish this event before sending invites: until then the invite link has no page to open.'), 409);
    }
    const now = new Date();
    // Targets and total by the preview's rule (`resendableSql`), so invites still waiting in the outbox
    // never fill the page: otherwise 200 of them sorting first would be picked, and skipped, on every click.
    const from = resendableSql(event.id, now);
    const [targets, [counted]] = await Promise.all([
      db.$queryRaw<{id: string; email: string; name: string | null; token: string}[]>`
        SELECT i.id::text AS id, i.email, i.name, i.token ${from}
        ORDER BY i.email ASC
        LIMIT ${MAX_INVITES_PER_REQUEST}`,
      db.$queryRaw<{count: number}[]>`SELECT count(*)::int AS count ${from}`,
    ]);
    const total = counted?.count ?? 0;
    // Limit check, cooldown and queue in one short transaction (M-15): two sends at once can't both pass
    // the limit. The cooldown is started only where it is still due (the same rule as the read, so a
    // second click that read the same targets updates nothing), and only the invites whose update took
    // are queued: never two emails for one nudge.
    const queued = targets.length
      ? await withinDailyLimit(() =>
          db.$transaction(async tx => {
            await reserveDailyInvites(tx, targets.length, now);
            // An invite whose email is still waiting in the outbox (a first send not delivered yet has
            // no `sentAt`, so it reads as "never contacted") is not nudged: that would be a second email.
            const waiting = await tx.guestEmailOutbox.findMany({
              where: {kind: 'invite', status: 'pending', inviteId: {in: targets.map(t => t.id)}},
              select: {inviteId: true},
            });
            const skip = new Set(waiting.map(w => w.inviteId));
            const due = targets.filter(t => !skip.has(t.id));
            if (!due.length) return [];
            const started = await tx.invite.updateManyAndReturn({
              where: {...resendableWhere(event.id, now), id: {in: due.map(t => t.id)}},
              data: {lastResentAt: now},
              select: {id: true},
            });
            return queueInvites(tx, started, now, String(now.getTime()));
          })
        )
      : [];
    if (!queued) return c.json(dailyLimitProblem(), 409);
    await audit(db, {actorUserId: c.var.viewer.id, action: 'invites_resent', target: ['event', event.id], meta: {resent: queued.length}});
    if (queued.length) await kickGuestEmails();
    return c.json({resent: queued.length, remaining: Math.max(0, total - targets.length)});
  })

  .post('/events/:eventId/invites/:inviteId/resend', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await eventFor(db, c.req.param('eventId'));
    const inviteId = c.req.param('inviteId');
    if (!event || !isUuid(inviteId)) return notFound(c, 'Invite');
    if (event.status === 'cancelled') {
      return c.json(problem('event_cancelled', "This event is cancelled, so invites can't be resent."), 409);
    }
    // M-14: a draft has no public page yet, so an invite link would be dead. Publish first.
    if (event.status !== 'published') {
      return c.json(problem('event_not_published', 'Publish this event before sending invites: until then the invite link has no page to open.'), 409);
    }
    const now = new Date();
    const invite = await db.invite.findFirst({
      where: {id: inviteId, eventId: event.id},
      select: {id: true, email: true, name: true, token: true, status: true, sentAt: true, rsvps: {select: {id: true}, take: 1}},
    });
    if (!invite) return notFound(c, 'Invite');
    if (invite.rsvps.length || invite.status === 'responded') {
      return c.json(problem('already_responded', 'This guest has already responded.'), 409);
    }
    if (invite.status === 'bounced') {
      return c.json(problem('invite_bounced', "This address bounced, so the invite can't be resent. Check the address and invite it again."), 409);
    }
    // Queued (the outbox sends it and marks it sent, keeping the first send time) with the cooldown started.
    // M-15: a single resend is an invite email too, so it counts against the daily limit, checked atomically.
    // The same rules as the bulk resend: never while its email is still waiting in the outbox, and only
    // when the cooldown is due (decided by the update itself, so a double click queues one email).
    const done = await withinDailyLimit(() =>
      db.$transaction(async tx => {
        await reserveDailyInvites(tx, 1, now);
        const waiting = await tx.guestEmailOutbox.findFirst({
          where: {kind: 'invite', status: 'pending', inviteId: invite.id},
          select: {id: true},
        });
        if (waiting) return 'pending' as const;
        const started = await tx.invite.updateManyAndReturn({
          where: {...resendableWhere(event.id, now), id: invite.id},
          data: {lastResentAt: now},
          select: {id: true},
        });
        if (!started.length) return 'cooldown' as const;
        await queueInvites(tx, started, now, String(now.getTime()));
        return 'queued' as const;
      })
    );
    if (!done) return c.json(dailyLimitProblem(), 409);
    if (done === 'pending') {
      return c.json(problem('invite_pending', 'This invite is still being sent. Wait for it to go out before resending.'), 409);
    }
    if (done === 'cooldown') {
      return c.json(
        problem('resend_cooldown', `This invite was sent or resent in the last ${RESEND_COOLDOWN_HOURS} hours. Try again later.`),
        409
      );
    }
    await audit(db, {actorUserId: c.var.viewer.id, action: 'invite_resent', target: ['invite', invite.id]});
    await kickGuestEmails();
    return c.json({ok: true});
  })

  .delete('/events/:eventId/invites/:inviteId', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const inviteId = c.req.param('inviteId');
    const eventId = c.req.param('eventId');
    if (!isUuid(inviteId) || !isUuid(eventId)) return notFound(c, 'Invite');
    const {count} = await c.var.db.invite.deleteMany({where: {id: inviteId, eventId}});
    if (!count) return notFound(c, 'Invite');
    await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'invite_deleted', target: ['invite', inviteId], meta: {eventId}});
    return c.json({ok: true});
  })

  .get('/events/:eventId/share-kit', withViewer, requireAuth, requireEventRead(), withDb, async c => {
    const event = await eventFor(c.var.db, c.req.param('eventId'));
    if (!event) return notFound(c, 'Event');
    const base = publicBase(c.req.url);
    return c.json({
      title: event.title,
      slug: event.slug,
      base,
      eventUrl: `${base}/e/${encodeURIComponent(event.slug)}`,
      published: event.status === 'published',
    });
  });

/**
 * Invites to nudge, as a `where` (the same rule as `isResendable`, decided by the database, never by
 * loading the invites and filtering them in JS): no RSVP, not responded or bounced, and last
 * contacted (`lastResentAt`, else `sentAt`) at least the cooldown ago, or never.
 */
function resendableWhere(eventId: string, now: Date): Prisma.InviteWhereInput {
  const cutoff = new Date(now.getTime() - RESEND_COOLDOWN_HOURS * 3_600_000);
  return {
    eventId,
    status: {in: ['queued', 'sent']},
    rsvps: {none: {}},
    OR: [{lastResentAt: {lte: cutoff}}, {lastResentAt: null, OR: [{sentAt: null}, {sentAt: {lte: cutoff}}]}],
  };
}

/**
 * `resendableWhere` as SQL (`FROM invites i WHERE …`), plus no pending 'invite' outbox row: the one rule
 * the resend preview counts and the bulk resend picks its targets and total by, so they can't drift.
 */
function resendableSql(eventId: string, now: Date): Prisma.Sql {
  const cutoff = new Date(now.getTime() - RESEND_COOLDOWN_HOURS * 3_600_000);
  return Prisma.sql`FROM invites i
    WHERE i.event_id = ${eventId}::uuid
      AND i.status::text IN ('queued', 'sent')
      AND NOT EXISTS (SELECT 1 FROM rsvps r WHERE r.invite_id = i.id)
      AND (i.last_resent_at <= ${cutoff} OR (i.last_resent_at IS NULL AND (i.sent_at IS NULL OR i.sent_at <= ${cutoff})))
      AND NOT EXISTS (
        SELECT 1 FROM guest_email_outbox o WHERE o.invite_id = i.id AND o.kind = 'invite' AND o.status = 'pending'
      )`;
}
