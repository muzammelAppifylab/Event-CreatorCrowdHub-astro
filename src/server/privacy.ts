import {hashToken, newToken} from '../domain/secureToken';
import {signToken, verifyToken} from '../domain/tokens';
import type {PrismaClient} from '../generated/prisma/client';
import type {ConsentState, GuestPrivacySummary, PrivacyEventBrief} from '../lib/privacy-types';

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
 * Retention (docs/porting/privacy.md): export links work 180 days after the event ends;
 * unsubscribe and erase work for as long as the row exists; `expiredGuestIds` + `eraseRsvp`
 * let a background job anonymise guests `RETENTION_DAYS` after the event.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const MANAGE_READ_DAYS = 180;
export const CONSENT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Guest names, emails and answers are anonymised this long after the event ends. */
export const RETENTION_DAYS = 730;
export const GUEST_EXPORT_FORMAT = 'creator-crowd-hub.guest-export.v1' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Marketing-consent link token for the confirmation email. */
export function consentToken(rsvpId: string, secret: string, now: Date = new Date()): string {
  return signToken('consent', {rsvpId}, secret, {expiresInSeconds: CONSENT_TOKEN_TTL_SECONDS, now});
}

export function consentUrl(origin: string, rsvpId: string, secret: string, now?: Date): string {
  return `${origin}/privacy/consent/${encodeURIComponent(consentToken(rsvpId, secret, now))}`;
}

/** Unsubscribe links carry the manage token: `/privacy/unsubscribe/<manage token>`. */
export const unsubscribeUrl = (origin: string, manageToken: string) =>
  `${origin}/privacy/unsubscribe/${encodeURIComponent(manageToken)}`;
export const guestPrivacyUrl = (origin: string, manageToken: string) =>
  `${origin}/privacy/guest/${encodeURIComponent(manageToken)}`;

/** The export stops this long after the event ends. */
export const exportDeadline = (endAt: Date): Date => new Date(endAt.getTime() + MANAGE_READ_DAYS * DAY_MS);
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

/** The RSVP for a raw manage token, or null for junk, a rotated or erased token, or a draft event. */
export async function findByManageToken(db: PrismaClient, token: string) {
  // Real tokens are 43 chars; anything far off is junk, no database read.
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  const rsvp = await db.rsvp.findUnique({where: {manageToken: hashToken(token)}, select: rsvpSelect});
  return rsvp && rsvp.event.status !== 'draft' ? rsvp : null;
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
  const id = payload && typeof payload.rsvpId === 'string' && UUID.test(payload.rsvpId) ? payload.rsvpId : null;
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
  if (count > 0) return 'confirmed';
  return rsvp.marketingConsent && rsvp.consentConfirmedAt ? 'confirmed' : 'off';
}

/* -- unsubscribe ----------------------------------------------------------- */

export async function unsubscribeState(db: PrismaClient, token: string): Promise<ConsentState | null> {
  const rsvp = await findByManageToken(db, token);
  if (!rsvp) return null;
  return {state: rsvp.marketingConsent && rsvp.consentConfirmedAt ? 'confirmed' : 'off', event: brief(rsvp.event)};
}

/** Withdraws marketing consent (idempotent). No time window: unsubscribing must always work. */
export async function unsubscribe(db: PrismaClient, token: string): Promise<'ok' | 'invalid'> {
  const rsvp = await findByManageToken(db, token);
  if (!rsvp) return 'invalid';
  await db.rsvp.updateMany({where: {id: rsvp.id, marketingConsent: true}, data: {marketingConsent: false, consentConfirmedAt: null}});
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
  const [answers, orders, votes, deliveries] = await Promise.all([
    db.rsvpAnswer.findMany({where: {rsvpId: rsvp.id}, select: {questionId: true, value: true, question: {select: {label: true}}}, take: 500}),
    db.ticketOrder.findMany({where: {rsvpId: rsvp.id}, select: {amountCents: true, currency: true, seats: true, status: true, createdAt: true}, take: 100}),
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
  ]);
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

/**
 * Erases one RSVP (GDPR; same shape as the source): name, email, tracking source and answers go;
 * the seat is released (`cancelled`); poll votes lose their link to the guest; the host's invite
 * for that address is removed; the manage token is replaced. Paid orders stay (payment history)
 * but point at no name. An RSVP in checkout is refused until it ends. Waitlist promotion after
 * the release is the host flow's job (`domain/waitlist.ts`).
 */
export async function eraseRsvp(db: PrismaClient, rsvpId: string): Promise<'erased' | 'checkout_in_progress' | 'not_found'> {
  return db.$transaction(async tx => {
    const rsvp = await tx.rsvp.findUnique({where: {id: rsvpId}, select: {id: true, eventId: true, email: true, status: true}});
    if (!rsvp) return 'not_found';
    if (rsvp.status === 'awaiting_payment') return 'checkout_in_progress';
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
    return 'erased' as const;
  });
}

export async function eraseByManageToken(db: PrismaClient, token: string) {
  const rsvp = await findByManageToken(db, token);
  return rsvp ? eraseRsvp(db, rsvp.id) : ('not_found' as const);
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
