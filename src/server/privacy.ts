import type {Context} from 'hono';

import {hashToken, newToken} from '../domain/secureToken';
import {signToken, verifyToken, type TokenPurpose} from '../domain/tokens';
import type {PrismaClient} from '../generated/prisma/client';
import {queueGuestEmails} from './jobs/guest-emails';
import {lockEvent} from './jobs/shared';
import {promoteWaitlist} from './waitlist-promote';
import {emitSeated, emitWebhook, rsvpPayload} from './webhook-emit';
import type {ConsentState, GuestPrivacySummary, PrivacyEventBrief} from '../lib/privacy-types';
import {isUuid} from '../lib/text';

/**
 * Guest privacy, ported from CreatorCrowdHub (`server/privacy/*`, `rsvp/manage-token.ts`,
 * `routes/consent.ts`; security audit M13, M17, M19). Direct Prisma calls; the routes
 * (`routes/privacy.ts`) only validate and rate-limit.
 *
 * Authentication is the RSVP's MANAGE TOKEN, not a session: 32 random bytes, only their sha256
 * stored (`rsvps.manage_token`), looked up by hash (we never compare secrets ourselves). The
 * marketing-consent link carries a SIGNED "consent" token ({rsvpId}, 30 days) that only the
 * confirmation email holds, so consent counts only once the inbox owner proves it.
 *
 * Retention (docs/porting/privacy.md): export, unsubscribe and erase work for as long as the row
 * holds personal data (audit L-42: the export no longer closes before retention); `expiredGuestIds`
 * + `eraseRsvp` let a background job anonymise guests `RETENTION_DAYS` after the event.
 * The guest's links work whatever the event became (unpublished, cancelled, deleted: audit M-23).
 *
 * Unsubscribe (audit M-4/M-25/M-26) is per PERSON (email), not per RSVP: it withdraws marketing
 * consent on every RSVP with that address and stamps `rsvps.unsubscribed_at`, which host
 * broadcasts honour. Every guest email carries an unsubscribe link: the manage token where the
 * sender has it, else a signed, non-expiring `unsubscribe` token (`guestEmailLinks`).
 *
 * Erasure (audit M-9/M-24/M-27) frees the seat AND passes it to the waitlist under the event lock,
 * strips the guest from the payment record (`orders.email`, `metadata.rsvpId`), and leaves a
 * hashed-address log (`guest_erasures`) so an erasure can be re-applied after a backup restore.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long the guest's manage PAGE stays readable (src/server/routes/rsvp.ts); privacy links outlive it. */
export const MANAGE_READ_DAYS = 180;
export const CONSENT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Guest names, emails and answers are anonymised this long after the event ends. */
export const RETENTION_DAYS = 730;
export const GUEST_EXPORT_FORMAT = 'creator-crowd-hub.guest-export.v1' as const;

/** Marketing-consent link token for the confirmation email. */
export function consentToken(rsvpId: string, secret: string, now: Date = new Date()): string {
  return signToken('consent', {rsvpId}, secret, {expiresInSeconds: CONSENT_TOKEN_TTL_SECONDS, now});
}

export function consentUrl(origin: string, rsvpId: string, secret: string, now?: Date): string {
  return `${origin}/privacy/consent/${encodeURIComponent(consentToken(rsvpId, secret, now))}`;
}

/**
 * Headers for an IN-PROCESS `app.request()` from an SSR page: the real client IP (so the rate
 * limiter keys per visitor, not one shared 'local' bucket) plus any other named headers.
 * `cf-connecting-ip` is set by Cloudflare, never by the visitor.
 */
export function inProcessHeaders(request: Request, extra: string[] = []): Headers {
  const headers = new Headers();
  for (const name of ['cf-connecting-ip', 'user-agent', ...extra]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

/**
 * Unsubscribe links carry the manage token: `/privacy/unsubscribe/<manage token>`.
 * Marketing and broadcast emails MUST carry one, built here. The raw manage token is only known
 * when minted or rotated (the DB keeps its hash), so the sender holding it adds the link; the
 * templates (`src/emails/layout.ts`) render it through `manageUrl`.
 */
export const unsubscribeUrl = (origin: string, manageToken: string) =>
  `${origin}/privacy/unsubscribe/${encodeURIComponent(manageToken)}`;
export const guestPrivacyUrl = (origin: string, manageToken: string) =>
  `${origin}/privacy/guest/${encodeURIComponent(manageToken)}`;

/**
 * Unsubscribe links for senders that do not hold the raw manage token (reminders, broadcasts):
 * a SIGNED token ({r: rsvpId}, purpose `unsubscribe`) that never expires, because unsubscribing
 * must always work. It only ever switches updates OFF, so a forwarded email risks nothing more.
 */
const UNSUBSCRIBE_PURPOSE: TokenPurpose = 'unsubscribe';
export const unsubscribeToken = (rsvpId: string, secret: string): string => signToken(UNSUBSCRIBE_PURPOSE, {r: rsvpId}, secret);
export const signedUnsubscribeUrl = (origin: string, rsvpId: string, secret: string) => unsubscribeUrl(origin, unsubscribeToken(rsvpId, secret));

/**
 * The privacy links one guest email carries (audit M-4), for `EmailGuestInfo`: always an
 * unsubscribe link; the data page (download, erase) only with the raw manage token, since a
 * long-lived erase link must never sit in every reminder. No secret: no signed link.
 */
export function guestEmailLinks(
  origin: string,
  rsvpId: string,
  secret: string | null | undefined,
  manageToken?: string | null,
): {unsubscribeUrl: string | null; privacyUrl: string | null} {
  if (manageToken) return {unsubscribeUrl: unsubscribeUrl(origin, manageToken), privacyUrl: guestPrivacyUrl(origin, manageToken)};
  return {unsubscribeUrl: secret ? signedUnsubscribeUrl(origin, rsvpId, secret) : null, privacyUrl: null};
}

/** The export works for as long as we keep the data (audit L-42: it used to stop after 180 days). */
export const exportDeadline = (endAt: Date): Date => new Date(endAt.getTime() + RETENTION_DAYS * DAY_MS);
export const exportAllowed = (endAt: Date, now: Date) => now.getTime() < exportDeadline(endAt).getTime();
export const retentionCutoff = (now: Date) => new Date(now.getTime() - RETENTION_DAYS * DAY_MS);

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const eventSelect = {id: true, title: true, slug: true, startAt: true, endAt: true, timezone: true, status: true} as const;
const rsvpSelect = {
  id: true,
  eventId: true,
  name: true,
  email: true,
  response: true,
  status: true,
  plusOnes: true,
  seats: true,
  ticketCode: true,
  marketingConsent: true,
  consentConfirmedAt: true,
  checkedInAt: true,
  attended: true,
  waitlistPosition: true,
  source: true,
  utmSource: true,
  confirmedAt: true,
  createdAt: true,
  updatedAt: true,
  event: {select: eventSelect},
} as const;

/**
 * The RSVP for a raw manage token, or null for junk, a rotated or erased token. Whatever became of
 * the event (unpublished back to draft, cancelled, soft-deleted), the guest keeps export, erase and
 * unsubscribe (audit M-23): the row still holds their data.
 */
export async function findByManageToken(db: PrismaClient, token: string) {
  // Real tokens are 43 chars; anything far off is junk, no database read.
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  const rsvp = await db.rsvp.findUnique({where: {manageToken: hashToken(token)}, select: rsvpSelect});
  return rsvp && !isErasedEmail(rsvp.email) ? rsvp : null;
}

const isErasedEmail = (email: string) => email.endsWith('@invalid');

/** An unsubscribe link's RSVP: the manage token, or the signed `unsubscribe` token (it has a dot; manage tokens never do). */
async function rsvpOfUnsubscribeToken(db: PrismaClient, token: string, secret: string) {
  if (typeof token !== 'string' || token.length > 512) return null;
  if (!token.includes('.')) return findByManageToken(db, token);
  const payload = verifyToken<{r?: unknown}>(token, UNSUBSCRIBE_PURPOSE, secret);
  const id = payload && isUuid(payload.r) ? payload.r : null;
  if (!id) return null;
  const rsvp = await db.rsvp.findUnique({where: {id}, select: rsvpSelect});
  return rsvp && !isErasedEmail(rsvp.email) ? rsvp : null;
}

type FoundRsvp = NonNullable<Awaited<ReturnType<typeof findByManageToken>>>;

const brief = (e: FoundRsvp['event']): PrivacyEventBrief => ({
  title: e.title,
  slug: e.slug,
  startAt: e.startAt.toISOString(),
  endAt: e.endAt.toISOString(),
  timezone: e.timezone,
});

/* -- consent (double opt-in) ---------------------------------------------- */

async function rsvpOfConsentToken(db: PrismaClient, token: string, secret: string, now: Date) {
  const payload = verifyToken<{rsvpId?: unknown}>(token, 'consent', secret, now);
  const id = payload && isUuid(payload.rsvpId) ? payload.rsvpId : null;
  if (!id) return null;
  return db.rsvp.findUnique({where: {id}, select: rsvpSelect});
}

/** Read-only: what the consent page shows. Null = bad or expired link. Never changes anything. */
export async function consentState(db: PrismaClient, token: string, secret: string, now: Date): Promise<ConsentState | null> {
  const rsvp = await rsvpOfConsentToken(db, token, secret, now);
  if (!rsvp) return null;
  const state = rsvp.marketingConsent ? (rsvp.consentConfirmedAt ? 'confirmed' : 'pending') : 'off';
  return {state, event: brief(rsvp.event)};
}

/**
 * The click. Only an RSVP that opted in (box ticked) and is not yet confirmed changes, once.
 * `confirmed` is the answer whether this call or an earlier click did it. A guest who
 * unsubscribed since gets `off`: an old link never switches marketing back on.
 */
export async function confirmConsent(
  db: PrismaClient,
  token: string,
  secret: string,
  now: Date
): Promise<'confirmed' | 'off' | 'invalid'> {
  const rsvp = await rsvpOfConsentToken(db, token, secret, now);
  if (!rsvp) return 'invalid';
  const {count} = await db.rsvp.updateMany({
    where: {id: rsvp.id, marketingConsent: true, consentConfirmedAt: null},
    data: {consentConfirmedAt: now},
  });
  if (count > 0) {
    // A fresh, proven opt-in (a new RSVP with the box ticked, then this click) lifts an earlier
    // unsubscribe for this person. An old link cannot: unsubscribing switched its RSVP off above.
    await db.$executeRaw`UPDATE rsvps SET unsubscribed_at = NULL WHERE email = ${rsvp.email} AND unsubscribed_at IS NOT NULL`;
    return 'confirmed';
  }
  return rsvp.marketingConsent && rsvp.consentConfirmedAt ? 'confirmed' : 'off';
}

/* -- unsubscribe ----------------------------------------------------------- */

/**
 * What the unsubscribe page shows: `off` once this person unsubscribed (from any of their RSVPs),
 * else `confirmed` (the button). `token` is the manage token or a signed unsubscribe token.
 */
export async function unsubscribeState(db: PrismaClient, token: string, secret: string): Promise<ConsentState | null> {
  const rsvp = await rsvpOfUnsubscribeToken(db, token, secret);
  if (!rsvp) return null;
  const [row] = await db.$queryRaw<Array<{unsubscribed: boolean}>>`
    SELECT bool_or(unsubscribed_at IS NOT NULL) AS unsubscribed FROM rsvps WHERE email = ${rsvp.email}`;
  return {state: row?.unsubscribed ? 'off' : 'confirmed', event: brief(rsvp.event)};
}

/**
 * Unsubscribes this PERSON from the host's updates (idempotent; no time window: it must always
 * work). One statement over every RSVP with the address (`rsvps_email_idx`): marketing consent
 * off, and `unsubscribed_at` stamped, which host broadcasts and the contacts list honour
 * (audit M-25, M-26). Emails about the RSVP itself (confirmation, reminders) still go out.
 */
export async function unsubscribe(db: PrismaClient, token: string, secret: string, now: Date = new Date()): Promise<'ok' | 'invalid'> {
  const rsvp = await rsvpOfUnsubscribeToken(db, token, secret);
  if (!rsvp) return 'invalid';
  await db.$executeRaw`
    UPDATE rsvps SET marketing_consent = false, consent_confirmed_at = NULL,
      unsubscribed_at = COALESCE(unsubscribed_at, ${now}), updated_at = ${now}
    WHERE email = ${rsvp.email} AND (marketing_consent OR unsubscribed_at IS NULL)`;
  return 'ok';
}

/* -- guest summary, export, erase ------------------------------------------ */

export async function guestSummary(db: PrismaClient, token: string): Promise<GuestPrivacySummary | null> {
  const rsvp = await findByManageToken(db, token);
  if (!rsvp) return null;
  return {
    name: rsvp.name,
    email: rsvp.email,
    status: rsvp.status,
    marketingConsent: rsvp.marketingConsent,
    consentConfirmed: Boolean(rsvp.consentConfirmedAt),
    event: brief(rsvp.event),
    exportUntil: exportDeadline(rsvp.event.endAt).toISOString(),
    canErase: rsvp.status !== 'awaiting_payment',
  };
}

/**
 * Everything we hold about this guest for this event, built FIELD BY FIELD (never spread from a
 * row) so a new column is not exported by accident. Left out on purpose: the manage token (the
 * credential), checkout ids, message bodies. Null = bad link or the window is over.
 */
export async function guestExport(db: PrismaClient, token: string, now: Date) {
  const rsvp = await findByManageToken(db, token);
  if (!rsvp || !exportAllowed(rsvp.event.endAt, now)) return null;
  return buildGuestExport(db, rsvp, now);
}

/** The same document for an organiser (EVENT_MANAGE), by RSVP id: no token, no 180-day window. Null = no such guest in that event. */
export async function guestExportById(db: PrismaClient, eventId: string, rsvpId: string, now: Date) {
  const rsvp = await db.rsvp.findFirst({where: {id: rsvpId, eventId}, select: rsvpSelect});
  return rsvp ? buildGuestExport(db, rsvp, now) : null;
}

async function buildGuestExport(db: PrismaClient, rsvp: FoundRsvp, now: Date) {
  const [answers, orders, votes, deliveries, invites] = await Promise.all([
    db.rsvpAnswer.findMany({where: {rsvpId: rsvp.id}, select: {questionId: true, value: true, question: {select: {label: true}}}, take: 500}),
    db.ticketOrder.findMany({
      where: {rsvpId: rsvp.id},
      select: {checkoutId: true, amountCents: true, currency: true, seats: true, status: true, createdAt: true},
      take: 100,
    }),
    db.pollVote.findMany({
      where: {rsvpId: rsvp.id},
      select: {pollId: true, optionIds: true, ratingValue: true, textValue: true, createdAt: true, updatedAt: true, poll: {select: {question: true, type: true}}},
      take: 500,
    }),
    db.messageDelivery.findMany({
      where: {rsvpId: rsvp.id},
      select: {id: true, channel: true, status: true, sentAt: true, message: {select: {subject: true}}},
      take: 500,
    }),
    // The host's invitation to this address for this event (audit L-42). (event_id, email) is unique.
    db.invite.findMany({
      where: {eventId: rsvp.eventId, email: {equals: rsvp.email, mode: 'insensitive'}},
      select: {name: true, email: true, status: true, sentAt: true, lastResentAt: true},
      take: 5,
    }),
  ]);
  // The payment platform's record of the same checkouts (the address it was paid with): one more read, only when there are orders.
  const payments = orders.length
    ? await db.order.findMany({
        where: {checkoutId: {in: orders.map(o => o.checkoutId)}},
        select: {email: true, status: true, amountCents: true, currency: true, quantity: true, paidAt: true, createdAt: true},
        take: 100,
      })
    : [];
  return {
    format: GUEST_EXPORT_FORMAT,
    exportedAt: now.toISOString(),
    event: {id: rsvp.event.id, title: rsvp.event.title, slug: rsvp.event.slug, startAt: iso(rsvp.event.startAt), endAt: iso(rsvp.event.endAt), timezone: rsvp.event.timezone},
    rsvp: {
      id: rsvp.id,
      name: rsvp.name,
      email: rsvp.email,
      response: rsvp.response,
      status: rsvp.status,
      plusOnes: rsvp.plusOnes,
      seats: rsvp.seats,
      ticketCode: rsvp.ticketCode,
      marketingConsent: rsvp.marketingConsent,
      consentConfirmedAt: iso(rsvp.consentConfirmedAt),
      source: rsvp.source,
      utmSource: rsvp.utmSource,
      waitlistPosition: rsvp.waitlistPosition,
      confirmedAt: iso(rsvp.confirmedAt),
      checkedInAt: iso(rsvp.checkedInAt),
      attended: rsvp.attended,
      createdAt: iso(rsvp.createdAt),
      updatedAt: iso(rsvp.updatedAt),
    },
    answers: answers.map(a => ({questionId: a.questionId, question: a.question.label, answer: a.value})),
    orders: orders.map(o => ({amountCents: o.amountCents, currency: o.currency, seats: o.seats, status: o.status, createdAt: iso(o.createdAt)})),
    pollVotes: votes.map(v => ({
      pollId: v.pollId,
      question: v.poll.question,
      type: v.poll.type,
      optionIds: v.optionIds,
      ratingValue: v.ratingValue,
      textValue: v.textValue,
      createdAt: iso(v.createdAt),
      updatedAt: iso(v.updatedAt),
    })),
    messages: deliveries.map(d => ({id: d.id, subject: d.message?.subject ?? null, channel: d.channel, status: d.status, sentAt: iso(d.sentAt)})),
    invites: invites.map(i => ({name: i.name, email: i.email, status: i.status, sentAt: iso(i.sentAt), lastResentAt: iso(i.lastResentAt)})),
    payments: payments.map(o => ({
      email: o.email,
      status: o.status,
      amountCents: o.amountCents,
      currency: o.currency,
      quantity: o.quantity,
      paidAt: iso(o.paidAt),
      createdAt: iso(o.createdAt),
    })),
  };
}

/** `guest-data-<slug>-<yyyy-mm-dd>.json`. */
export const exportFilename = (slug: string, now: Date) =>
  `guest-data-${slug.replace(/[^a-z0-9-]/gi, '')}-${now.toISOString().slice(0, 10)}.json`;

/** The identity an erased RSVP keeps: nobody ever sees the token behind its new hash, so old links die. */
export const erasedIdentity = (rsvpId: string) => ({
  name: 'Removed guest',
  email: `removed+${rsvpId}@invalid`,
  manageToken: hashToken(newToken()),
});

/** Seats a guest holds or waits for: erasing one of these frees something for the waitlist. */
const FREES_SEAT = new Set(['confirmed', 'waitlisted']);

export type EraseResult = 'erased' | 'checkout_in_progress' | 'not_found';

export interface EraseOptions {
  now?: Date;
  /**
   * Pass the freed seat to the waitlist, under the event lock (audit M-9). Default true. The
   * retention sweep passes false for expired guests (their events ended long ago, nobody is
   * waiting) and true when it re-applies a restored erasure (the event may still be upcoming).
   */
  promote?: boolean;
  /**
   * Keep a hashed-address record in `guest_erasures` (audit M-27), so the erasure can be applied
   * again after a backup restore (`reapplyErasures`). Default true; retention and a re-application
   * pass false (retention re-runs by itself after a restore).
   */
  log?: boolean;
}

/**
 * Erases one RSVP (GDPR; same shape as the source): name, email, tracking source and answers go;
 * the seat is released (`cancelled`) and handed to the waitlist under the event lock; poll votes
 * lose their link to the guest; the host's invite for that address is removed; the manage token is
 * replaced. Paid orders stay (payment history) but keep neither the guest's address nor their RSVP
 * id (`orders.email`, `orders.metadata.rsvpId`: audit M-24). An RSVP in checkout is refused until
 * it ends. Promoted guests are emailed after the commit.
 */
export async function eraseRsvp(db: PrismaClient, rsvpId: string, options: EraseOptions = {}): Promise<EraseResult> {
  const now = options.now ?? new Date();
  const promote = options.promote !== false;
  const log = options.log !== false;
  const outcome = await db.$transaction(async tx => {
    const found = await tx.rsvp.findUnique({where: {id: rsvpId}, select: {eventId: true}});
    if (!found) return {result: 'not_found' as const};
    // The event lock first, then the row again: a cancel, a promotion or a checkout can't interleave.
    if (promote) await lockEvent(tx, found.eventId);
    const rsvp = await tx.rsvp.findUnique({
      where: {id: rsvpId},
      select: {id: true, eventId: true, email: true, status: true, response: true, event: {select: {status: true, capacity: true, endAt: true, deletedAt: true}}},
    });
    if (!rsvp) return {result: 'not_found' as const};
    if (rsvp.status === 'awaiting_payment') return {result: 'checkout_in_progress' as const};
    const wasErased = rsvp.email.endsWith('@invalid');
    await tx.rsvpAnswer.deleteMany({where: {rsvpId}});
    await tx.pollVote.updateMany({where: {rsvpId}, data: {rsvpId: null, textValue: null}});
    await tx.messageDelivery.updateMany({where: {rsvpId}, data: {error: null}});
    await tx.rsvp.update({
      where: {id: rsvpId},
      data: {
        ...erasedIdentity(rsvpId),
        status: 'cancelled',
        marketingConsent: false,
        consentConfirmedAt: null,
        utmSource: null,
        waitlistPosition: null,
        claimExpiresAt: null,
        inviteId: null,
      },
    });
    await tx.invite.deleteMany({where: {eventId: rsvp.eventId, email: {equals: rsvp.email, mode: 'insensitive'}}});
    // The platform's payment record of this guest's checkouts: no address, no link back to the RSVP.
    await tx.$executeRaw`
      UPDATE orders SET email = NULL, metadata = CASE WHEN metadata ? 'rsvpId' THEN metadata - 'rsvpId' ELSE metadata END, updated_at = ${now}
      WHERE checkout_id IN (SELECT checkout_id FROM ticket_orders WHERE rsvp_id = ${rsvpId}::uuid)
        AND (email IS NOT NULL OR metadata ? 'rsvpId')`;
    if (log && !wasErased) {
      await tx.$executeRaw`
        INSERT INTO guest_erasures (email_hash, event_id, erased_at) VALUES (${erasureHash(rsvp.email)}, ${rsvp.eventId}::uuid, ${now})
        ON CONFLICT (email_hash, event_id) DO UPDATE SET erased_at = EXCLUDED.erased_at`;
    }
    const e = rsvp.event;
    const mayPromote =
      promote && FREES_SEAT.has(rsvp.status) && e.status === 'published' && !e.deletedAt && now.getTime() < e.endAt.getTime();
    const promotions = mayPromote ? (await promoteWaitlist(tx, {id: rsvp.eventId, capacity: e.capacity}, now)).promotions : [];
    return {result: 'erased' as const, eventId: rsvp.eventId, promotions};
  });
  if (outcome.result === 'erased' && outcome.promotions.length > 0) {
    // After the commit: the promoted guests' emails (outbox, one insert) and their webhooks. Never throw.
    await queueGuestEmails(
      outcome.promotions.map(p =>
        p.kind === 'confirm'
          ? {kind: 'confirmation' as const, rsvpId: p.rsvpId}
          : {kind: 'waitlist_offer' as const, rsvpId: p.rsvpId, stamp: String(p.claimExpiresAt.getTime())},
      ),
    ).catch(() => undefined);
    await emitSeated(db, outcome.eventId, outcome.promotions);
  }
  return outcome.result;
}

/**
 * The erasure log's key: sha256 hex of the (always lower-case, CHECK `rsvps_email_lower`) address.
 * Postgres computes the same with `encode(sha256(convert_to(email, 'UTF8')), 'hex')`.
 */
export const erasureHash = (email: string): string => hashToken(email.trim().toLowerCase());

/** `c`, when given, runs the `rsvp.removed` webhook after the answer (`waitUntil`) instead of racing the response. */
export async function eraseByManageToken(db: PrismaClient, token: string, c: Context | null = null) {
  const rsvp = await findByManageToken(db, token);
  if (!rsvp) return 'not_found' as const;
  const result = await eraseRsvp(db, rsvp.id);
  if (result === 'erased') {
    emitWebhook(c, db, 'rsvp.removed', rsvpPayload({id: rsvp.id, eventId: rsvp.eventId, status: rsvp.status, response: rsvp.response}));
  }
  return result;
}

/** One bounded batch of RSVPs whose event ended over `RETENTION_DAYS` ago and are not yet anonymised (for a background job). */
export async function expiredGuestIds(db: PrismaClient, now: Date, limit = 100): Promise<string[]> {
  const rows = await db.rsvp.findMany({
    where: {event: {endAt: {lt: retentionCutoff(now)}}, NOT: {email: {endsWith: '@invalid'}}, status: {not: 'awaiting_payment'}},
    select: {id: true},
    orderBy: {id: 'asc'},
    take: Math.min(Math.max(limit, 1), 500),
  });
  return rows.map(r => r.id);
}

/**
 * One bounded batch of host invites (name + address) for events that ended over `RETENTION_DAYS`
 * ago (audit M-26): people who never RSVP'd were otherwise kept forever. Deleted by id.
 */
export async function deleteExpiredInvites(db: PrismaClient, now: Date, limit = 500): Promise<number> {
  const rows = await db.invite.findMany({
    where: {event: {endAt: {lt: retentionCutoff(now)}}},
    select: {id: true},
    take: Math.min(Math.max(limit, 1), 500),
  });
  if (rows.length === 0) return 0;
  const {count} = await db.invite.deleteMany({where: {id: {in: rows.map(r => r.id)}}});
  return count;
}

/**
 * After a backup restore (audit M-27): RSVPs that were erased but came back with the restore, found
 * through the erasure log (driven by the small log, joined to that event's RSVPs). Bounded.
 */
export async function restoredErasedIds(db: PrismaClient, limit = 100): Promise<string[]> {
  const take = Math.min(Math.max(limit, 1), 500);
  const rows = await db.$queryRaw<Array<{id: string}>>`
    SELECT r.id::text AS id
    FROM guest_erasures g
    JOIN rsvps r ON r.event_id = g.event_id AND encode(sha256(convert_to(r.email, 'UTF8')), 'hex') = g.email_hash
    WHERE r.email NOT LIKE '%@invalid' AND r.status <> 'awaiting_payment'
      -- Only rows from before the erasure (what a restore brings back): the same person may RSVP again later.
      AND r.created_at < g.erased_at
    ORDER BY r.id
    LIMIT ${take}`;
  return rows.map(r => r.id);
}

/** Rows the privacy-link rate limit no longer needs (its longest window is an hour): one bounded delete. */
export async function prunePrivacyAttempts(db: PrismaClient, now: Date, limit = 5000): Promise<number> {
  const before = new Date(now.getTime() - DAY_MS);
  return db.$executeRaw`
    DELETE FROM privacy_attempts WHERE id IN (
      SELECT id FROM privacy_attempts WHERE created_at < ${before} ORDER BY created_at LIMIT ${Math.min(Math.max(limit, 1), 10000)})`;
}
