import type {Prisma, PrismaClient} from '../../generated/prisma/client';
import {config} from '../../platform/config';
import {formatInZone} from '../../domain/time';
import {pollLinkFor} from '../../domain/tokens';
import type {EmailBrand, EmailData} from '../../emails';
import {eventPageLinks, loadBrand} from '../guest-mail';
import {guestEmailLinks} from '../privacy';

/** The client or a transaction's client: helpers work with either. */
export type Db = PrismaClient | Prisma.TransactionClient;

/** The site's own public address (jobs and hooks have no request to read it from). */
export function siteBase(): string {
  return (config.siteUrl ?? 'http://localhost:4321').replace(/\/+$/, '');
}

/** A queued claim older than this is a crashed run's: it is claimed again while still due. */
export const STALE_CLAIM_MINUTES = 15;
/** Failed deliveries whose error starts with this are never retried. */
export const PERMANENT_ERROR_PREFIX = 'permanent: ';
export const MAX_ERROR_LENGTH = 500;

export const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);

export const isUniqueViolation = (error: unknown): boolean => (error as {code?: unknown} | null)?.code === 'P2002';

/** Locks the event row for the rest of the transaction, so two seat decisions never interleave. */
export async function lockEvent(tx: Db, eventId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`;
}

/** Seats held by going guests who are confirmed or paying (the capacity rule's `seatsTaken`). */
export async function seatsTakenOf(tx: Db, eventId: string): Promise<number> {
  const sum = await tx.rsvp.aggregate({
    _sum: {seats: true},
    where: {eventId, response: 'going', status: {in: ['confirmed', 'awaiting_payment']}},
  });
  return sum._sum.seats ?? 0;
}

export interface GuestMail {
  to: string;
  replyTo?: string;
  data: EmailData;
  eventId: string;
  eventStatus: string;
  /** A paid-waitlist seat offer's deadline, when one is outstanding or lapsed. */
  claimExpiresAt: Date | null;
}

/** The columns one guest email reads (the event is a joined select). */
const guestMailSelect = {
  id: true, eventId: true, name: true, email: true, response: true, status: true, ticketCode: true, waitlistPosition: true,
  claimExpiresAt: true,
  event: {
    select: {
      title: true, slug: true, startAt: true, endAt: true, timezone: true, format: true, venueName: true,
      venueAddress: true, mapUrl: true, joinUrl: true, pollJoinCode: true, thankYouLink: true, status: true, visibility: true, deletedAt: true,
    },
  },
} satisfies Prisma.RsvpSelect;

type GuestMailRow = Prisma.RsvpGetPayload<{select: typeof guestMailSelect}>;

/** One loaded row as a GuestMail (shared by `loadGuestMail` and `loadGuestMails`); null when its event is deleted. */
function toGuestMail(rsvp: GuestMailRow, base: string, brand: EmailBrand, now: Date): GuestMail | null {
  if (rsvp.event.deletedAt) return null;
  const {pageUrl, publicPageUrl} = eventPageLinks(base, rsvp.event);
  const {event} = rsvp;
  return {
    to: rsvp.email,
    replyTo: brand.replyToEmail ?? undefined,
    eventId: rsvp.eventId,
    eventStatus: event.status,
    claimExpiresAt: rsvp.claimExpiresAt ?? null,
    data: {
      now,
      brand,
      event: {
        title: event.title,
        startAt: event.startAt,
        endAt: event.endAt,
        timezone: event.timezone,
        startLocal: formatInZone(event.startAt, event.timezone),
        format: event.format,
        venueName: event.venueName,
        venueAddress: event.venueAddress,
        mapUrl: event.mapUrl,
        joinUrl: event.joinUrl,
        pageUrl,
        publicPageUrl,
        pollUrl: pollLinkFor(base, event.pollJoinCode, rsvp.id, rsvp.eventId, config.jwtSecret, now),
        thankYouLink: event.thankYouLink,
      },
      guest: {
        rsvpId: rsvp.id,
        name: rsvp.name,
        response: rsvp.response,
        status: rsvp.status,
        ticketCode: rsvp.ticketCode,
        manageUrl: pageUrl,
        waitlistPosition: rsvp.waitlistPosition,
        // A signed one-click unsubscribe link (M-25) for reminders and the other guest emails.
        unsubscribeUrl: guestEmailLinks(base, rsvp.id, config.jwtSecret).unsubscribeUrl,
      },
    },
  };
}

/**
 * Everything an email template needs for one RSVP, loaded by id in ONE query (the event is a
 * joined select). `null` when the RSVP or its event is gone. The manage token is stored hashed,
 * so links point at the event page where a guest can ask for their link again (a private event
 * has no public page: `eventPageLinks`). A caller that
 * sends many emails in one run loads the brand once and passes it as `brand`.
 */
export async function loadGuestMail(db: Db, rsvpId: string, now = new Date(), options: {brand?: EmailBrand} = {}): Promise<GuestMail | null> {
  const rsvp = await db.rsvp.findUnique({where: {id: rsvpId}, select: guestMailSelect});
  if (!rsvp || rsvp.event.deletedAt) return null;
  const base = siteBase();
  const brand = options.brand ?? (await loadBrand(db, base));
  return toGuestMail(rsvp, base, brand, now);
}

/**
 * `loadGuestMail` for many RSVPs in ONE query (a drain round). The map holds only the RSVPs whose
 * row and event still exist; each value is a fresh object (a caller may change its links).
 */
export async function loadGuestMails(
  db: Db,
  rsvpIds: readonly string[],
  now = new Date(),
  options: {brand?: EmailBrand} = {},
): Promise<Map<string, GuestMail>> {
  const ids = [...new Set(rsvpIds)];
  const mails = new Map<string, GuestMail>();
  if (!ids.length) return mails;
  const rows = await db.rsvp.findMany({where: {id: {in: ids}}, select: guestMailSelect});
  if (!rows.some(r => !r.event.deletedAt)) return mails;
  const base = siteBase();
  const brand = options.brand ?? (await loadBrand(db, base));
  for (const row of rows) {
    const mail = toGuestMail(row, base, brand, now);
    if (mail) mails.set(row.id, mail);
  }
  return mails;
}
