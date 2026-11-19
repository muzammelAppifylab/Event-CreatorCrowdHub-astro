import {creatorEmail, type EmailBrand} from '../../emails';
import {Prisma} from '../../generated/prisma/client';
import {eventMailSelect, emailDataFor, inviteLink, loadBrand, type MailEvent, type MailGuest, noticeContent} from '../guest-mail';
import {canSendEventEmail, deliverEventEmail, type EventEmail, type SendOutcome} from '../mailer';
import {inviteEmail} from '../routes/admin-invites';
import type {SendFn} from './deliveries';
import {type ConfirmationRule, confirmationRulesFor, sendGuestEmail} from './guest-emails';
import type {GuestEmailKind, NoticeKind, OutboxKind} from './outbox';
import {errorText, type GuestMail, loadGuestMails, siteBase, STALE_CLAIM_MINUTES, type Db} from './shared';

/**
 * Drains the guest email outbox (./outbox): claims due rows in small rounds, sends each one,
 * and records the result on the row. Bounded per run (OUTBOX_RUN_LIMIT rows, a deadline), so one
 * run fits the job's 60 s. Safe to run twice at once: a claim moves the row's `next_attempt_at`
 * past a lease (FOR UPDATE SKIP LOCKED picks rows nobody else is claiming), and the row id is the
 * provider's Idempotency-Key.
 *
 *   sent          done
 *   skipped       nothing to send any more (the guest, invite, message or event is gone, the guest
 *                 moved on, the host switched the email off)
 *   failed        given up: OUTBOX_MAX_ATTEMPTS tries, the provider refused the address, or no
 *                 provider is configured (logged once, never retried: audit L-20)
 *   pending       tried again after a backoff (2, 4, 8 … minutes). A provider 429 does not count as
 *                 a try: the row waits a few seconds, and the run stops after a few in a row.
 */

export const OUTBOX_MAX_ATTEMPTS = 8;
/** Rows claimed per round (sent one after the other: the provider allows only a few a second). */
export const OUTBOX_ROUND = 10;
/** Most rows one run handles. */
export const OUTBOX_RUN_LIMIT = 150;
/** A claimed row nobody finished (a crashed run) is due again after this: past a delivery claim's staleness, so the retry can re-claim it. */
export const OUTBOX_LEASE_MINUTES = STALE_CLAIM_MINUTES + 1;
/** Finished rows are deleted after this many days (bounded per run). */
export const OUTBOX_KEEP_DAYS = 30;
const DEFAULT_DEADLINE_MS = 40_000;
const RATE_LIMIT_STOP = 3;

/** Wait after try number `attempts` (1-based) before the next: 2, 4, 8 … minutes, at most 4 hours. */
export const outboxBackoffMinutes = (attempts: number): number => Math.min(2 ** Math.max(1, attempts), 240);

export type Deliver = (email: EventEmail) => Promise<{outcome: SendOutcome; retryAfterSeconds?: number}>;

export interface OutboxRun {
  sent: number;
  skipped: number;
  failed: number;
  retrying: number;
  /** Rows are still due (a limit, the deadline or the provider's rate limit stopped the run). */
  more: boolean;
}

type Claimed = {id: string; kind: OutboxKind; rsvpId: string | null; inviteId: string | null; messageId: string | null; attempts: number};
type Result =
  | {id: string; status: 'sent' | 'skipped'}
  | {id: string; status: 'failed'; error: string}
  | {id: string; status: 'retry'; error: string; attempts: number}
  | {id: string; status: 'rate_limited'; retryAfterSeconds?: number};

const GUEST_KINDS: ReadonlySet<string> = new Set<GuestEmailKind>(['confirmation', 'waitlist_offer', 'hold_expired', 'event_cancelled']);
const guestSelect = {id: true, name: true, email: true, response: true, status: true, ticketCode: true, waitlistPosition: true} as const;

export async function drainGuestEmailOutbox(
  db: Db,
  now: Date = new Date(),
  options: {deliver?: Deliver; deadline?: number; limit?: number; providerConfigured?: boolean} = {},
): Promise<OutboxRun> {
  const run: OutboxRun = {sent: 0, skipped: 0, failed: 0, retrying: 0, more: false};
  if (!(db as {guestEmailOutbox?: unknown}).guestEmailOutbox) return run;
  const started = Date.now();
  const deadline = options.deadline ?? started + DEFAULT_DEADLINE_MS;
  const limit = options.limit ?? OUTBOX_RUN_LIMIT;
  const deliver = options.deliver ?? deliverEventEmail;
  const provider = options.providerConfigured ?? canSendEventEmail();
  const clock = () => new Date(now.getTime() + (Date.now() - started));

  await sweepFinished(db, now);

  let brand: Promise<EmailBrand> | null = null;
  const brandOnce = () =>
    (brand ??= loadBrand(db, siteBase()).catch(error => {
      brand = null;
      throw error;
    }));

  // After RATE_LIMIT_STOP provider 429s in a row, nothing more is sent this run: the rest of the
  // round answers `rate_limited` without calling the provider, and the try is given back.
  const limiter = {inARow: 0, stop: false};
  const guarded: Deliver = async email => {
    // Past the deadline no new send starts (each may take up to its 10 s timeout, and a round is
    // up to OUTBOX_ROUND sends): the row is given back like a 429, so the run ends inside the job's 60 s.
    if (!limiter.stop && Date.now() >= deadline) limiter.stop = true;
    if (limiter.stop) return {outcome: 'rate_limited'};
    const said = await deliver(email);
    if (said.outcome !== 'rate_limited') limiter.inARow = 0;
    else if (++limiter.inARow >= RATE_LIMIT_STOP) limiter.stop = true;
    return said;
  };

  let handled = 0;
  while (handled < limit) {
    if (Date.now() >= deadline) {
      run.more = true;
      break;
    }
    const at = clock();
    const rows = await claim(db, at, Math.min(OUTBOX_ROUND, limit - handled));
    if (rows.length === 0) return run;
    handled += rows.length;

    const results: Result[] = [];
    for (const group of groupByKind(rows)) {
      if (limiter.stop) {
        for (const row of group.rows) results.push({id: row.id, status: 'rate_limited'});
        continue;
      }
      results.push(...(await sendGroup(db, group.kind, group.rows, {at, deliver: guarded, provider, brandOnce, stopped: () => limiter.stop})));
    }
    await record(db, results, rows, at, run);
    if (limiter.stop) {
      run.more = true;
      return run;
    }
  }
  if (handled >= limit) run.more = true;
  return run;
}

/** Claims up to `n` due rows: one statement, a lease on each, a try counted. */
async function claim(db: Db, at: Date, n: number): Promise<Claimed[]> {
  const lease = new Date(at.getTime() + OUTBOX_LEASE_MINUTES * 60_000);
  return db.$queryRaw<Claimed[]>`
    UPDATE guest_email_outbox AS o
    SET attempts = o.attempts + 1, next_attempt_at = ${lease}
    FROM (
      SELECT id FROM guest_email_outbox
      WHERE status = 'pending' AND next_attempt_at <= ${at}
      ORDER BY next_attempt_at, id
      LIMIT ${n}
      FOR UPDATE SKIP LOCKED
    ) AS due
    WHERE o.id = due.id
    RETURNING o.id, o.kind, o.rsvp_id AS "rsvpId", o.invite_id AS "inviteId", o.message_id AS "messageId", o.attempts`;
}

/** Deletes finished rows older than OUTBOX_KEEP_DAYS, at most 1,000 per run (index on created_at). */
async function sweepFinished(db: Db, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - OUTBOX_KEEP_DAYS * 24 * 3_600_000);
  await db.$executeRaw`
    DELETE FROM guest_email_outbox
    WHERE id IN (
      SELECT id FROM guest_email_outbox
      WHERE created_at < ${cutoff} AND status <> 'pending'
      LIMIT 1000
    )`;
}

function groupByKind(rows: Claimed[]): Array<{kind: OutboxKind; rows: Claimed[]}> {
  const groups = new Map<OutboxKind, Claimed[]>();
  for (const row of rows) groups.set(row.kind, [...(groups.get(row.kind) ?? []), row]);
  return [...groups].map(([kind, list]) => ({kind, rows: list}));
}

type SendContext = {at: Date; deliver: Deliver; provider: boolean; brandOnce: () => Promise<EmailBrand>; stopped: () => boolean};

/** What one provider answer means for the row. */
function outcomeResult(row: Claimed, outcome: SendOutcome, retryAfterSeconds?: number): Result {
  switch (outcome) {
    case 'sent':
      return {id: row.id, status: 'sent'};
    case 'rate_limited':
      return {id: row.id, status: 'rate_limited', retryAfterSeconds};
    case 'no_provider':
      return {id: row.id, status: 'failed', error: 'No mail provider is configured.'};
    case 'rejected':
      return {id: row.id, status: 'failed', error: 'The mail provider refused this email.'};
    default:
      return row.attempts >= OUTBOX_MAX_ATTEMPTS
        ? {id: row.id, status: 'failed', error: `Not sent after ${row.attempts} tries.`}
        : {id: row.id, status: 'retry', error: 'The email could not be sent.', attempts: row.attempts};
  }
}

/** The provider's Idempotency-Key for a row. A waitlist offer rotates the guest's link on every
 * try, so its key changes per try: a duplicate with a working link beats one with a dead link. */
const keyOf = (row: Claimed) => (row.kind === 'waitlist_offer' ? `outbox-${row.id}-${row.attempts}` : `outbox-${row.id}`);

async function sendGroup(db: Db, kind: OutboxKind, rows: Claimed[], ctx: SendContext): Promise<Result[]> {
  if (GUEST_KINDS.has(kind)) return sendGuestRows(db, kind as GuestEmailKind, rows, ctx);
  if (kind === 'broadcast') return sendBroadcastRows(db, rows, ctx);
  if (kind === 'invite') return sendInviteRows(db, rows, ctx);
  if (kind === 'notice_confirmation' || kind === 'notice_declined') return sendNoticeRows(db, kind, rows, ctx);
  return rows.map(row => ({id: row.id, status: 'failed' as const, error: `Unknown email kind.`}));
}

/**
 * The round's guest mail data and confirmation rules in at most two queries (never per row). Null
 * when the read failed: each row then loads its own (and fails on its own, as before).
 */
async function preloadGuestRound(
  db: Db,
  kind: GuestEmailKind,
  rows: Claimed[],
  ctx: SendContext,
  brand: EmailBrand,
): Promise<{mails: Map<string, GuestMail>; rules: Map<string, ConfirmationRule>} | null> {
  const rsvpIds = rows.flatMap(r => (r.rsvpId ? [r.rsvpId] : []));
  if (!rsvpIds.length || ctx.stopped()) return null;
  try {
    const mails = await loadGuestMails(db, rsvpIds, ctx.at, {brand});
    // Only a confirmation that passes sendGuestEmail's status check reads its rule.
    const ruleEvents = kind === 'confirmation'
      ? [...mails.values()].filter(m => m.eventStatus === 'published' && m.data.guest.status === 'confirmed').map(m => m.eventId)
      : [];
    const rules = ruleEvents.length ? await confirmationRulesFor(db, ruleEvents) : new Map<string, ConfirmationRule>();
    return {mails, rules};
  } catch (error) {
    console.warn(`[outbox] ${kind} round could not be preloaded: ${errorText(error).slice(0, 160)}`);
    return null;
  }
}

/** Transactional guest emails: `sendGuestEmail` re-checks the RSVP and keeps message_deliveries. */
async function sendGuestRows(db: Db, kind: GuestEmailKind, rows: Claimed[], ctx: SendContext): Promise<Result[]> {
  const results: Result[] = [];
  const brand = await ctx.brandOnce();
  const preloaded = await preloadGuestRound(db, kind, rows, ctx, brand);
  // A second row for the same guest in this round reads afresh: the first one's send may have changed it.
  const used = new Set<string>();
  for (const row of rows) {
    if (!row.rsvpId) {
      results.push({id: row.id, status: 'skipped'});
      continue;
    }
    // The run stopped sending (429s, the deadline): give the row back without reading or claiming anything.
    if (ctx.stopped()) {
      results.push({id: row.id, status: 'rate_limited'});
      continue;
    }
    let last: {outcome: SendOutcome; retryAfterSeconds?: number} | null = null;
    const send: SendFn = async email => {
      last = await ctx.deliver({...email, idempotencyKey: keyOf(row)});
      return last.outcome === 'sent';
    };
    let pre: {mail: GuestMail | null; rule?: ConfirmationRule} | Record<string, never> = {};
    if (preloaded && !used.has(row.rsvpId)) {
      used.add(row.rsvpId);
      const mail = preloaded.mails.get(row.rsvpId) ?? null;
      pre = {mail, rule: mail ? preloaded.rules.get(mail.eventId) : undefined};
    }
    try {
      const outcome = await sendGuestEmail(db, kind, row.rsvpId, {
        now: ctx.at,
        send,
        brand,
        ...pre,
        idempotencyKey: keyOf(row),
        // A 429 (or the deadline) is not this email's fault: its delivery try is given back too.
        rateLimited: () => (last as {outcome: SendOutcome} | null)?.outcome === 'rate_limited',
        final: () => {
          const said = (last as {outcome: SendOutcome} | null)?.outcome;
          return !ctx.provider || said === 'rejected' || said === 'no_provider' || (said !== 'rate_limited' && row.attempts >= OUTBOX_MAX_ATTEMPTS);
        },
      });
      if (outcome === 'sent') results.push({id: row.id, status: 'sent'});
      else if (outcome === 'skipped') results.push({id: row.id, status: 'skipped'});
      else {
        const said = last as {outcome: SendOutcome; retryAfterSeconds?: number} | null;
        results.push(outcomeResult(row, said?.outcome ?? 'failed', said?.retryAfterSeconds));
      }
    } catch (error) {
      results.push(outcomeResult(row, 'failed'));
      console.warn(`[outbox] ${kind} email for one guest could not be prepared: ${errorText(error).slice(0, 160)}`);
    }
  }
  return results;
}

/** Host broadcasts: the message, its event and the guests are read once per round, never per row. */
async function sendBroadcastRows(db: Db, rows: Claimed[], ctx: SendContext): Promise<Result[]> {
  const messageIds = [...new Set(rows.flatMap(r => (r.messageId ? [r.messageId] : [])))];
  const rsvpIds = [...new Set(rows.flatMap(r => (r.rsvpId ? [r.rsvpId] : [])))];
  const [messages, guests, brand, unsubscribed] = await Promise.all([
    db.message.findMany({
      where: {id: {in: messageIds}},
      select: {id: true, subject: true, body: true, event: {select: {...eventMailSelect, deletedAt: true}}},
    }),
    db.rsvp.findMany({where: {id: {in: rsvpIds}}, select: {...guestSelect, eventId: true}}),
    ctx.brandOnce(),
    // M-25: a guest who unsubscribed after the broadcast was queued is skipped (raw SQL: newer column).
    rsvpIds.length
      ? db.$queryRaw<{id: string}[]>`
          SELECT id::text AS id FROM rsvps
          WHERE id IN (${Prisma.join(rsvpIds.map(id => Prisma.sql`${id}::uuid`))}) AND unsubscribed_at IS NOT NULL`
      : Promise.resolve([] as {id: string}[]),
  ]);
  const optedOut = new Set(unsubscribed.map(r => r.id));
  const messageById = new Map(messages.map(m => [m.id, m]));
  const guestById = new Map(guests.map(g => [g.id, g]));
  const base = siteBase();
  const results: Result[] = [];
  for (const row of rows) {
    const message = row.messageId ? messageById.get(row.messageId) : undefined;
    const guest = row.rsvpId ? guestById.get(row.rsvpId) : undefined;
    if (!message || !guest || optedOut.has(guest.id) || message.event.deletedAt || guest.eventId !== message.event.id) {
      results.push({id: row.id, status: 'skipped'});
      continue;
    }
    const email = creatorEmail('broadcast', emailDataFor(base, message.event as MailEvent, guest as MailGuest, brand, ctx.at), {
      subject: message.subject,
      body: message.body,
    });
    const said = await ctx.deliver({
      to: guest.email,
      content: {subject: email.subject, html: email.html, text: email.text},
      fromName: brand.senderName,
      replyTo: brand.replyToEmail,
      idempotencyKey: keyOf(row),
    });
    results.push(outcomeResult(row, said.outcome, said.retryAfterSeconds));
  }
  return results;
}

/**
 * Why a host notice is no longer sent (pure), or null to send it. The guest must still be in the
 * state the host put them in (a later decline beats an earlier approval), the event live and not
 * cancelled. Unsubscribing from the host's updates does NOT stop a notice: it is about the guest's
 * own RSVP, and that opt-out covers broadcasts only (M-25; the privacy and unsubscribe pages say so).
 */
export function noticeSkip(
  kind: NoticeKind,
  guest: {status: MailGuest['status']} | undefined,
  event: {status: MailEvent['status']; deletedAt: Date | null} | undefined,
): string | null {
  if (!guest || !event || event.deletedAt) return 'gone';
  if (event.status === 'cancelled') return 'event_cancelled';
  if (kind === 'notice_declined') return guest.status === 'declined' ? null : 'status_changed';
  return ['confirmed', 'waitlisted', 'awaiting_payment'].includes(guest.status) ? null : 'status_changed';
}

/** Host notices (approved, declined, promoted): the guests with their events in one read per round. Same content as `noticeContent`. */
async function sendNoticeRows(db: Db, kind: NoticeKind, rows: Claimed[], ctx: SendContext): Promise<Result[]> {
  const rsvpIds = [...new Set(rows.flatMap(r => (r.rsvpId ? [r.rsvpId] : [])))];
  const [guests, brand] = await Promise.all([
    db.rsvp.findMany({where: {id: {in: rsvpIds}}, select: {...guestSelect, event: {select: {...eventMailSelect, deletedAt: true}}}}),
    ctx.brandOnce(),
  ]);
  const guestById = new Map(guests.map(g => [g.id, g]));
  const base = siteBase();
  const results: Result[] = [];
  for (const row of rows) {
    const guest = row.rsvpId ? guestById.get(row.rsvpId) : undefined;
    if (!guest || noticeSkip(kind, {status: guest.status}, guest.event)) {
      results.push({id: row.id, status: 'skipped'});
      continue;
    }
    const {event, ...mailGuest} = guest;
    const content = noticeContent(base, event as MailEvent, brand, {
      kind: kind === 'notice_declined' ? 'declined' : 'confirmation',
      guest: mailGuest as MailGuest,
    });
    const said = await ctx.deliver({
      to: guest.email,
      content,
      fromName: brand.senderName,
      replyTo: brand.replyToEmail,
      idempotencyKey: keyOf(row),
    });
    results.push(outcomeResult(row, said.outcome, said.retryAfterSeconds));
  }
  return results;
}

/** Invites: the invite and its event in one read per round. A responded or cancelled one is skipped. */
async function sendInviteRows(db: Db, rows: Claimed[], ctx: SendContext): Promise<Result[]> {
  const inviteIds = [...new Set(rows.flatMap(r => (r.inviteId ? [r.inviteId] : [])))];
  const [invites, brand] = await Promise.all([
    db.invite.findMany({
      where: {id: {in: inviteIds}},
      select: {
        id: true, email: true, name: true, token: true, status: true,
        event: {select: {...eventMailSelect, deletedAt: true}},
        rsvps: {select: {id: true}, take: 1},
      },
    }),
    ctx.brandOnce(),
  ]);
  const inviteById = new Map(invites.map(i => [i.id, i]));
  const base = siteBase();
  const results: Result[] = [];
  for (const row of rows) {
    const invite = row.inviteId ? inviteById.get(row.inviteId) : undefined;
    if (
      !invite ||
      invite.event.deletedAt ||
      invite.event.status === 'cancelled' ||
      invite.rsvps.length > 0 ||
      invite.status === 'responded' ||
      invite.status === 'bounced'
    ) {
      results.push({id: row.id, status: 'skipped'});
      continue;
    }
    const content = inviteEmail(invite.event as MailEvent, brand, invite, inviteLink(base, invite.token, invite.event.slug));
    const said = await ctx.deliver({
      to: invite.email,
      content,
      fromName: brand.senderName,
      replyTo: brand.replyToEmail,
      idempotencyKey: keyOf(row),
    });
    results.push(outcomeResult(row, said.outcome, said.retryAfterSeconds));
  }
  return results;
}

/**
 * Writes a round's results: one statement per outcome (not per row), plus what the email kind
 * keeps elsewhere (broadcast deliveries and counts, invite status). Retries back off by their tries.
 */
async function record(db: Db, results: Result[], rows: Claimed[], at: Date, run: OutboxRun): Promise<void> {
  const rowById = new Map(rows.map(r => [r.id, r]));
  const ids = (status: Result['status']) => results.filter(r => r.status === status).map(r => r.id);
  const sent = ids('sent');
  const skipped = ids('skipped');
  const failed = results.filter((r): r is Extract<Result, {status: 'failed'}> => r.status === 'failed');
  const retry = results.filter((r): r is Extract<Result, {status: 'retry'}> => r.status === 'retry');
  const limited = results.filter((r): r is Extract<Result, {status: 'rate_limited'}> => r.status === 'rate_limited');
  run.sent += sent.length;
  run.skipped += skipped.length;
  run.failed += failed.length;
  run.retrying += retry.length + limited.length;

  const writes: Promise<unknown>[] = [];
  if (sent.length) {
    writes.push(db.guestEmailOutbox.updateMany({where: {id: {in: sent}}, data: {status: 'sent', sentAt: at, lastError: null}}));
  }
  if (skipped.length) writes.push(db.guestEmailOutbox.updateMany({where: {id: {in: skipped}}, data: {status: 'skipped'}}));
  // Failures and retries carry a reason each; they are few (a round is at most OUTBOX_ROUND rows).
  for (const f of failed) {
    writes.push(db.guestEmailOutbox.updateMany({where: {id: f.id}, data: {status: 'failed', lastError: f.error.slice(0, 500)}}));
  }
  for (const r of retry) {
    const next = new Date(at.getTime() + outboxBackoffMinutes(r.attempts) * 60_000);
    writes.push(db.guestEmailOutbox.updateMany({where: {id: r.id}, data: {nextAttemptAt: next, lastError: r.error.slice(0, 500)}}));
  }
  if (limited.length) {
    // The provider's limit is not this email's fault: the try is given back and it waits seconds, not minutes.
    const wait = Math.max(1, ...limited.map(l => l.retryAfterSeconds ?? 2));
    writes.push(
      db.guestEmailOutbox.updateMany({
        where: {id: {in: limited.map(l => l.id)}, attempts: {gt: 0}},
        data: {attempts: {decrement: 1}, nextAttemptAt: new Date(at.getTime() + wait * 1000)},
      }),
    );
  }

  // Broadcast bookkeeping: delivery rows and the message's sent count (one write per message and outcome).
  const byMessage = new Map<string, {sent: string[]; failed: string[]}>();
  const note = (id: string, bucket: 'sent' | 'failed') => {
    const row = rowById.get(id);
    if (row?.kind !== 'broadcast' || !row.messageId || !row.rsvpId) return;
    const entry = byMessage.get(row.messageId) ?? {sent: [], failed: []};
    entry[bucket].push(row.rsvpId);
    byMessage.set(row.messageId, entry);
  };
  for (const id of sent) note(id, 'sent');
  for (const f of failed) note(f.id, 'failed');
  for (const id of skipped) note(id, 'failed'); // the guest or the event is gone: not delivered
  for (const [messageId, entry] of byMessage) {
    if (entry.sent.length) {
      writes.push(
        db.messageDelivery.updateMany({where: {messageId, rsvpId: {in: entry.sent}}, data: {status: 'sent', sentAt: at}}),
        db.message.updateMany({where: {id: messageId}, data: {sentCount: {increment: entry.sent.length}}}),
      );
    }
    if (entry.failed.length) {
      writes.push(db.messageDelivery.updateMany({where: {messageId, rsvpId: {in: entry.failed}}, data: {status: 'failed', error: 'send_failed'}}));
    }
  }

  // Invites: sent once the provider accepted it (the first send time is kept).
  const invitesSent = sent.flatMap(id => {
    const row = rowById.get(id);
    return row?.kind === 'invite' && row.inviteId ? [row.inviteId] : [];
  });
  if (invitesSent.length) {
    writes.push(
      db.invite.updateMany({where: {id: {in: invitesSent}, sentAt: null}, data: {sentAt: at}}),
      db.invite.updateMany({where: {id: {in: invitesSent}, status: 'queued'}, data: {status: 'sent'}}),
    );
  }
  await Promise.all(writes);
}
