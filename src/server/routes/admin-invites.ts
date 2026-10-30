import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {formatInZone} from '../../domain/time';
import {signToken} from '../../domain/tokens';
import {button, details, esc, paragraph, renderLayout, renderText} from '../../emails/layout';
import type {EmailBrand, EmailContent} from '../../emails/types';
import {audit} from '../../platform/auth';
import {config} from '../../platform/config';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import type {PrismaClient} from '../../generated/prisma/client';
import {eventMailSelect, inviteLink, loadBrand, type MailEvent, publicBase, sendMail} from '../guest-mail';
import {PERMISSIONS} from '../permissions';

/**
 * Guest invites, for event organisers (`site:event:manage`). Mounted by the
 * app at `/site-api/event-admin` (docs/porting/guests.md), so paths here start
 * with `/events/:eventId/invites`.
 *
 *   GET    /events/:eventId/invites?before=         invites, by email, keyset paged
 *   POST   /events/:eventId/invites                 {emails}: paste box, "Name <email>" allowed
 *   GET    /events/:eventId/invites/resend-preview  how many non-responders a resend reaches
 *   POST   /events/:eventId/invites/resend          nudge every non-responder (48 h cooldown)
 *   POST   /events/:eventId/invites/:inviteId/resend  nudge one invite (ignores the cooldown)
 *   DELETE /events/:eventId/invites/:inviteId       delete (revokes its link)
 *   GET    /events/:eventId/share-kit               the public event link for the share kit
 *
 * Invite tokens are HMAC-signed with `config.jwtSecret` (`signToken('invite', ...)`);
 * the public `/i/<token>` route must also require the row, so deleting an invite revokes it.
 * Emails go through `sendMail` (src/server/guest-mail.ts).
 */

export const INVITES_PAGE_SIZE = 100;
/** Most invites created, or resent, by one request (a Worker request can only make so many calls). */
export const MAX_INVITES_PER_REQUEST = 200;
/** Invite emails per rolling 24 hours, across every event. */
export const DAILY_INVITE_LIMIT = 2000;
/** A nudge goes out at most once per this window. */
export const RESEND_COOLDOWN_HOURS = 48;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

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

const notFound = (what: string) => problem('not_found', `${what} not found.`);

async function eventFor(db: PrismaClient, id: string) {
  if (!isUuid(id)) return null;
  return db.event.findFirst({where: {id, deletedAt: null}, select: eventMailSelect}) as Promise<MailEvent | null>;
}

/** Sends invites one at a time; returns the ids the mailer accepted. */
async function sendInvites(
  db: PrismaClient,
  base: string,
  event: MailEvent,
  invites: {id: string; name: string | null; email: string; token: string}[]
): Promise<string[]> {
  if (!invites.length) return [];
  const brand = await loadBrand(db);
  const accepted: string[] = [];
  for (const invite of invites) {
    const content = inviteEmail(event, brand, invite, inviteLink(base, invite.token, event.slug));
    const result = await sendMail({
      to: invite.email,
      subject: content.subject,
      html: content.html,
      text: content.text,
      replyTo: brand.replyToEmail ?? undefined,
    });
    if (result.ok) accepted.push(invite.id);
    else console.warn(`[invites] send failed for invite ${invite.id}`);
  }
  return accepted;
}

async function sentInLastDay(db: PrismaClient, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  return db.invite.count({where: {OR: [{sentAt: {gte: since}}, {lastResentAt: {gte: since}}]}});
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
  .get('/events/:eventId/invites', listQuery, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const event = await eventFor(c.var.db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
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

  .post('/events/:eventId/invites', createBody, withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await eventFor(db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    if (event.status === 'cancelled') {
      return c.json(problem('event_cancelled', "This event is cancelled, so it can't take new invites."), 409);
    }
    const secret = config.jwtSecret;
    if (!secret) return c.json(problem('auth_not_configured', 'This site cannot sign invite links yet.'), 503);

    const parsed = parseEmailList(c.req.valid('json').emails);
    if (parsed.valid.length > MAX_INVITES_PER_REQUEST) {
      const message = `Invite up to ${MAX_INVITES_PER_REQUEST} people at a time.`;
      return c.json({...problem('invalid_input', message), fields: {emails: message}}, 422);
    }
    // An address already invited to this event is never re-sent.
    const existing = new Set(
      (
        await db.invite.findMany({
          where: {eventId: event.id, email: {in: parsed.valid.map(r => r.email)}},
          select: {email: true},
        })
      ).map(r => r.email)
    );
    const fresh = parsed.valid.filter(r => !existing.has(r.email));
    const skippedDuplicate = [...parsed.repeated, ...parsed.valid.filter(r => existing.has(r.email)).map(r => r.email)];

    const now = new Date();
    if (fresh.length && (await sentInLastDay(db, now)) + fresh.length > DAILY_INVITE_LIMIT) {
      return c.json(problem('daily_invite_limit', 'Daily invite limit reached. Try again tomorrow.'), 409);
    }

    const created: {id: string; email: string; name: string | null; token: string}[] = [];
    for (const recipient of fresh) {
      const id = crypto.randomUUID();
      const token = signToken('invite', {eventId: event.id, inviteId: id}, secret);
      try {
        await db.invite.create({
          data: {id, eventId: event.id, email: recipient.email, name: recipient.name, token},
          select: {id: true},
        });
        created.push({id, email: recipient.email, name: recipient.name, token});
      } catch {
        // A concurrent paste inserted it first (unique per event and email).
        skippedDuplicate.push(recipient.email);
      }
    }

    const accepted = await sendInvites(db, publicBase(c.req.url), event, created);
    if (accepted.length) {
      await db.invite.updateMany({where: {id: {in: accepted}}, data: {status: 'sent', sentAt: now}});
    }
    await audit(db, {actorUserId: c.var.viewer.id, action: 'invites_sent', target: ['event', event.id], meta: {queued: created.length, sent: accepted.length}});
    return c.json({queued: created.length, sent: accepted.length, skippedInvalid: parsed.invalid, skippedDuplicate}, 201);
  })

  .get('/events/:eventId/invites/resend-preview', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const event = await eventFor(c.var.db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const targets = await resendable(c.var.db, event.id, new Date());
    return c.json({count: targets.length});
  })

  .post('/events/:eventId/invites/resend', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await eventFor(db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    if (event.status === 'cancelled') {
      return c.json(problem('event_cancelled', "This event is cancelled, so invites can't be resent."), 409);
    }
    const now = new Date();
    const all = await resendable(db, event.id, now);
    const targets = all.slice(0, MAX_INVITES_PER_REQUEST);
    if (targets.length && (await sentInLastDay(db, now)) + targets.length > DAILY_INVITE_LIMIT) {
      return c.json(problem('daily_invite_limit', 'Daily invite limit reached. Try again tomorrow.'), 409);
    }
    const accepted = await sendInvites(db, publicBase(c.req.url), event, targets);
    if (accepted.length) {
      await db.invite.updateMany({where: {id: {in: accepted}}, data: {status: 'sent', lastResentAt: now}});
    }
    await audit(db, {actorUserId: c.var.viewer.id, action: 'invites_resent', target: ['event', event.id], meta: {resent: accepted.length}});
    return c.json({resent: accepted.length, remaining: all.length - targets.length});
  })

  .post('/events/:eventId/invites/:inviteId/resend', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const {db} = c.var;
    const event = await eventFor(db, c.req.param('eventId'));
    const inviteId = c.req.param('inviteId');
    if (!event || !isUuid(inviteId)) return c.json(notFound('Invite'), 404);
    if (event.status === 'cancelled') {
      return c.json(problem('event_cancelled', "This event is cancelled, so invites can't be resent."), 409);
    }
    const invite = await db.invite.findFirst({
      where: {id: inviteId, eventId: event.id},
      select: {id: true, email: true, name: true, token: true, status: true, sentAt: true, rsvps: {select: {id: true}, take: 1}},
    });
    if (!invite) return c.json(notFound('Invite'), 404);
    if (invite.rsvps.length || invite.status === 'responded') {
      return c.json(problem('already_responded', 'This guest has already responded.'), 409);
    }
    const [accepted] = await sendInvites(db, publicBase(c.req.url), event, [invite]);
    if (!accepted) return c.json(problem('send_failed', 'The email could not be sent. Try again.'), 502);
    const now = new Date();
    await db.invite.update({
      where: {id: invite.id},
      data: {status: 'sent', sentAt: invite.sentAt ?? now, lastResentAt: now},
      select: {id: true},
    });
    await audit(db, {actorUserId: c.var.viewer.id, action: 'invite_resent', target: ['invite', invite.id]});
    return c.json({ok: true});
  })

  .delete('/events/:eventId/invites/:inviteId', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const inviteId = c.req.param('inviteId');
    const eventId = c.req.param('eventId');
    if (!isUuid(inviteId) || !isUuid(eventId)) return c.json(notFound('Invite'), 404);
    const {count} = await c.var.db.invite.deleteMany({where: {id: inviteId, eventId}});
    return count ? c.json({ok: true}) : c.json(notFound('Invite'), 404);
  })

  .get('/events/:eventId/share-kit', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const event = await eventFor(c.var.db, c.req.param('eventId'));
    if (!event) return c.json(notFound('Event'), 404);
    const base = publicBase(c.req.url);
    return c.json({
      title: event.title,
      slug: event.slug,
      base,
      eventUrl: `${base}/e/${encodeURIComponent(event.slug)}`,
      published: event.status === 'published',
    });
  });

/** Invites to nudge: no RSVP, not bounced, past the cooldown. */
async function resendable(db: PrismaClient, eventId: string, now: Date) {
  const rows = await db.invite.findMany({
    where: {eventId, status: {in: ['queued', 'sent']}, rsvps: {none: {}}},
    select: {id: true, email: true, name: true, token: true, status: true, sentAt: true, lastResentAt: true},
    orderBy: {email: 'asc'},
    take: 5000,
  });
  return rows.filter(row => isResendable({...row, hasRsvp: false}, now));
}
