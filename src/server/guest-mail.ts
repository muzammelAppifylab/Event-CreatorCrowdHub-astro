import {
  confirmationEmail,
  declinedEmail,
  type EmailBrand,
  type EmailContent,
  type EmailData,
  waitlistOfferEmail,
} from '../emails';
import {formatInZone} from '../domain/time';
import {pollLinkFor} from '../domain/tokens';
import {logoPath} from '../lib/event-brand';
import type {PrismaClient} from '../generated/prisma/client';
import {publicGet} from '../platform/api';
import {config} from '../platform/config';
import {sendEventEmail} from './mailer';

/**
 * Glue between the organiser routes (guests, invites, messages) and the mailer:
 * the data the `src/emails` templates need, built from database rows, and ONE
 * `sendMail()` that hands the result to `src/server/mailer.ts` (a boolean: false means the
 * email was not sent, e.g. no provider configured; invites stay queued, deliveries `failed`).
 */

export type MailMessage = {to: string; subject: string; html: string; text: string; replyTo?: string; fromName?: string | null};
export type MailResult = {ok: boolean};

/** Sends one event email through `mailer.ts` (Resend when configured). Never throws: a failure is `{ok: false}`. */
export async function sendMail(message: MailMessage): Promise<MailResult> {
  try {
    const ok = await sendEventEmail({
      to: message.to,
      content: {subject: message.subject, html: message.html, text: message.text},
      fromName: message.fromName,
      replyTo: message.replyTo,
    });
    return {ok};
  } catch {
    return {ok: false};
  }
}

/** What the templates need from an event row. */
export const eventMailSelect = {
  id: true,
  slug: true,
  title: true,
  startAt: true,
  endAt: true,
  timezone: true,
  format: true,
  venueName: true,
  venueAddress: true,
  mapUrl: true,
  joinUrl: true,
  pollJoinCode: true,
  thankYouLink: true,
  status: true,
  capacity: true,
  waitlistEnabled: true,
  maxPlusOnes: true,
} as const;

export type MailEvent = {
  id: string;
  slug: string;
  title: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
  format: 'in_person' | 'online' | 'hybrid';
  venueName: string | null;
  venueAddress: string | null;
  mapUrl: string | null;
  joinUrl: string | null;
  pollJoinCode: string;
  thankYouLink: string | null;
  status: 'draft' | 'published' | 'cancelled';
  capacity: number | null;
  waitlistEnabled: boolean;
  maxPlusOnes: number;
};

export type MailGuest = {
  id: string;
  name: string;
  email: string;
  response: 'going' | 'maybe' | 'not_going';
  status: 'pending' | 'confirmed' | 'waitlisted' | 'declined' | 'cancelled' | 'awaiting_payment';
  ticketCode: string | null;
  waitlistPosition: number | null;
};

/** The site's address for links in emails (no trailing slash). */
export function publicBase(requestUrl: string): string {
  return (config.siteUrl ?? new URL(requestUrl).origin).replace(/\/+$/, '');
}

/** `/i/<token>?e=<slug>`: the invite's personal link. */
export function inviteLink(base: string, token: string, slug?: string): string {
  const link = `${base.replace(/\/+$/, '')}/i/${token}`;
  return slug ? `${link}?e=${encodeURIComponent(slug)}` : link;
}

/** An absolute https address for an email image, or null (relative paths resolve against `base`). */
function absoluteHttps(url: string | null | undefined, base: string | null): string | null {
  if (!url) return null;
  try {
    const abs = new URL(url, base ?? undefined);
    return abs.protocol === 'https:' ? abs.toString() : null;
  } catch {
    return null;
  }
}

/** The platform's site logo (same source as the guest header), or null when unavailable. */
async function siteLogo(requestUrl: string | undefined): Promise<string | null> {
  const origin = config.siteUrl ?? requestUrl;
  if (!origin) return null;
  try {
    const raw = await publicGet<Record<string, unknown>>(origin, '/site/v1/initial-data', {ttlSeconds: 60});
    return typeof raw?.logo === 'string' ? raw.logo : null;
  } catch {
    return null;
  }
}

/**
 * The creator's sender identity from the one `event_settings` row. The logo is the event's own, else
 * the site logo (as in the guest header); emails need an absolute https address, so with none the
 * masthead shows the sender name. Pass `requestUrl` when there is no configured site URL.
 */
export async function loadBrand(db: Pick<PrismaClient, 'eventSettings'>, requestUrl?: string): Promise<EmailBrand> {
  const settings = await db.eventSettings.findUnique({
    where: {id: 1},
    select: {senderName: true, replyToEmail: true, brandColor: true, logoFileId: true, logoName: true},
  });
  const base = (config.siteUrl ?? (requestUrl ? new URL(requestUrl).origin : null))?.replace(/\/+$/, '') ?? null;
  const own = settings?.logoFileId ? logoPath({id: settings.logoFileId, name: settings.logoName ?? 'logo'}) : null;
  let logoUrl = base ? absoluteHttps(own, base) : null;
  if (!logoUrl) logoUrl = absoluteHttps(await siteLogo(requestUrl), base);
  return {
    senderName: settings?.senderName || 'Your host',
    replyToEmail: settings?.replyToEmail || null,
    brandColor: settings?.brandColor ?? null,
    logoUrl,
  };
}

/**
 * The template input for one guest. The stored manage token is a hash, so a
 * guest's "Manage RSVP" link points at the event page, where they can ask for it again.
 */
export function emailDataFor(base: string, event: MailEvent, guest: MailGuest, brand: EmailBrand, now = new Date()): EmailData {
  const pageUrl = `${base}/e/${encodeURIComponent(event.slug)}/`;
  return {
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
      pollUrl: pollLinkFor(base, event.pollJoinCode, guest.id, event.id, config.jwtSecret, now),
      thankYouLink: event.thankYouLink,
    },
    guest: {
      rsvpId: guest.id,
      name: guest.name,
      response: guest.response,
      status: guest.status,
      ticketCode: guest.ticketCode,
      manageUrl: pageUrl,
      waitlistPosition: guest.waitlistPosition,
    },
  };
}

/** A status email a host's action sends to a guest. */
export type GuestNotice =
  | {kind: 'confirmation'; guest: MailGuest}
  | {kind: 'declined'; guest: MailGuest}
  | {kind: 'waitlist_offer'; guest: MailGuest; claimExpiresAt: Date};

export function noticeContent(base: string, event: MailEvent, brand: EmailBrand, notice: GuestNotice): EmailContent {
  const data = emailDataFor(base, event, notice.guest, brand);
  switch (notice.kind) {
    case 'confirmation':
      return confirmationEmail(data);
    case 'declined':
      return declinedEmail(data);
    case 'waitlist_offer':
      return waitlistOfferEmail(data, formatInZone(notice.claimExpiresAt, event.timezone));
  }
}

/** Sends the notices one after another; a failure is logged (ids only) and never thrown. */
export async function notifyGuests(
  db: PrismaClient,
  base: string,
  event: MailEvent,
  notices: Array<GuestNotice & {guest: MailGuest}>
): Promise<void> {
  if (!notices.length || event.status === 'cancelled') return;
  const brand = await loadBrand(db, base);
  for (const notice of notices) {
    const content = noticeContent(base, event, brand, notice);
    const result = await sendMail({
      to: notice.guest.email,
      subject: content.subject,
      html: content.html,
      text: content.text,
      replyTo: brand.replyToEmail ?? undefined,
      fromName: brand.senderName,
    });
    if (!result.ok) console.warn(`[guests] ${notice.kind} email not sent for rsvp ${notice.guest.id}`);
  }
}
