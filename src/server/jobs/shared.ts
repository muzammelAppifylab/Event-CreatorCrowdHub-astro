import type {Prisma, PrismaClient} from '../../generated/prisma/client';
import {config} from '../../platform/config';
import {formatInZone} from '../../domain/time';
import type {EmailData} from '../../emails';

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
  eventStatus: string;
}

/**
 * Everything an email template needs for one RSVP, loaded by id. `null` when the RSVP or its
 * event is gone. The manage token is stored hashed, so links point at the event page where a
 * guest can ask for their link again.
 */
export async function loadGuestMail(db: Db, rsvpId: string, now = new Date()): Promise<GuestMail | null> {
  const rsvp = await db.rsvp.findUnique({
    where: {id: rsvpId},
    select: {
      id: true, name: true, email: true, response: true, status: true, ticketCode: true, waitlistPosition: true,
      event: {
        select: {
          title: true, slug: true, startAt: true, endAt: true, timezone: true, format: true, venueName: true,
          venueAddress: true, mapUrl: true, joinUrl: true, pollJoinCode: true, thankYouLink: true, status: true, deletedAt: true,
        },
      },
    },
  });
  if (!rsvp || rsvp.event.deletedAt) return null;
  const settings = await db.eventSettings.findUnique({
    where: {id: 1},
    select: {senderName: true, replyToEmail: true, brandColor: true},
  });
  const base = siteBase();
  const pageUrl = `${base}/e/${encodeURIComponent(rsvp.event.slug)}/`;
  const {event} = rsvp;
  return {
    to: rsvp.email,
    replyTo: settings?.replyToEmail || undefined,
    eventStatus: event.status,
    data: {
      now,
      brand: {senderName: settings?.senderName || 'The host', replyToEmail: settings?.replyToEmail || null, brandColor: settings?.brandColor ?? null},
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
        pollUrl: `${base}/p/${encodeURIComponent(event.pollJoinCode)}/`,
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
      },
    },
  };
}
