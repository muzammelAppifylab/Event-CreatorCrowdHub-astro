import {waitlistOfferEmail, type EmailContent} from '../emails';
import {formatInZone} from '../domain/time';
import {hashToken, newToken} from '../domain/secureToken';
import {canSendEventEmail, sendEventEmail} from './mailer';
import {loadGuestMail, siteBase, type Db} from './jobs/shared';

/**
 * The ONE paid-waitlist claim email (a seat was offered with `claimExpiresAt`). The stored manage
 * token is a hash, so the claim link is a NEW manage link (`/r/<token>/`, where the guest claims
 * and pays); the older link dies. Without a mail provider nothing is rotated (the guest keeps a
 * working link). Used by the RSVP route (cancel / update promotions) and the jobs (`guest-emails.ts`).
 */
export interface ClaimMail {
  to: string;
  content: EmailContent;
  fromName: string;
  replyTo?: string;
}

/** Builds the claim email (rotating the guest's manage token), or null when no offer is outstanding. */
export async function claimMailFor(db: Db, rsvpId: string, options: {origin?: string; now?: Date; /** false: keep the guest's link (no mail provider to deliver a new one). */ rotate?: boolean} = {}): Promise<ClaimMail | null> {
  const now = options.now ?? new Date();
  const row = await db.rsvp.findUnique({where: {id: rsvpId}, select: {status: true, claimExpiresAt: true}});
  if (!row || row.status !== 'waitlisted' || !row.claimExpiresAt || row.claimExpiresAt <= now) return null;
  const mail = await loadGuestMail(db, rsvpId, now);
  if (!mail || mail.eventStatus !== 'published') return null;
  if (options.rotate !== false) {
    const token = newToken();
    await db.rsvp.update({where: {id: rsvpId}, data: {manageToken: hashToken(token)}, select: {id: true}});
    mail.data.guest.manageUrl = `${options.origin ?? siteBase()}/r/${token}/`;
  }
  return {
    to: mail.to,
    content: waitlistOfferEmail(mail.data, formatInZone(row.claimExpiresAt, mail.data.event.timezone)),
    fromName: mail.data.brand.senderName,
    replyTo: mail.replyTo,
  };
}

/** Sends the claim email now. Never throws; true when handed to a provider. */
export async function sendClaimEmail(db: Db, rsvpId: string, options: {origin?: string; now?: Date} = {}): Promise<boolean> {
  try {
    if (!canSendEventEmail()) return false;
    const mail = await claimMailFor(db, rsvpId, options);
    if (!mail) return false;
    return await sendEventEmail(mail);
  } catch (error) {
    console.warn(`[claim] email not sent for rsvp ${rsvpId}: ${(error as Error).name}`);
    return false;
  }
}
