import {waitlistOfferEmail, type EmailContent} from '../emails';
import {formatInZone} from '../domain/time';
import {hashToken, newToken} from '../domain/secureToken';
import {canSendEventEmail, sendEventEmail} from './mailer';
import {type GuestMail, loadGuestMail, siteBase, type Db} from './jobs/shared';

/**
 * The ONE paid-waitlist claim email (a seat was offered with `claimExpiresAt`). The stored manage
 * token is a hash, so the claim link is a NEW manage link (`/r/<token>/`, where the guest claims
 * and pays); the older link dies, but only once the email carrying the new one was accepted by the
 * provider: the caller sends, then calls `commit()` (a failed send keeps the guest's working link).
 * Without a mail provider nothing is rotated (the guest keeps a working link). Used by the RSVP route (cancel / update promotions) and the jobs (`guest-emails.ts`).
 */
export interface ClaimMail {
  to: string;
  content: EmailContent;
  fromName: string;
  replyTo?: string;
  /** The provider's Idempotency-Key: one per offer AND link (a new expiry or a new link is a new email); the same email retried goes out once. */
  idempotencyKey: string;
  /** Stores the new link's hash. Call it ONLY after the provider accepted the email. A no-op when nothing was rotated. */
  commit: () => Promise<void>;
}

/** Builds the claim email with a new manage link (stored by `commit()` after the send), or null when no offer is outstanding. */
export async function claimMailFor(
  db: Db,
  rsvpId: string,
  options: {
    origin?: string;
    now?: Date;
    /** false: keep the guest's link (no mail provider to deliver a new one). */
    rotate?: boolean;
    /** The guest's mail data when the caller already loaded it (its link is replaced on rotation). */
    mail?: GuestMail;
  } = {},
): Promise<ClaimMail | null> {
  const now = options.now ?? new Date();
  // One read: the guest, their offer and the event (loadGuestMail joins the event).
  const mail = options.mail ?? (await loadGuestMail(db, rsvpId, now));
  if (!mail || mail.data.guest.status !== 'waitlisted' || !mail.claimExpiresAt || mail.claimExpiresAt <= now) return null;
  if (mail.eventStatus !== 'published') return null;
  const claimExpiresAt = mail.claimExpiresAt;
  let commit = async () => {};
  // Part of the Idempotency-Key: a retry that carries a NEW link must go out (else the provider
  // drops it as a repeat, `commit()` stores the new link and the one the guest has dies).
  let linkTag = 'keep';
  if (options.rotate !== false) {
    const token = newToken();
    linkTag = hashToken(`idempotency:${token}`).slice(0, 16);
    mail.data.guest.manageUrl = `${options.origin ?? siteBase()}/r/${token}/`;
    // Conditional: a guest who left the waitlist meanwhile keeps whatever link they have.
    commit = async () => {
      await db.rsvp.updateMany({where: {id: rsvpId, status: 'waitlisted'}, data: {manageToken: hashToken(token)}});
    };
  }
  return {
    commit,
    to: mail.to,
    content: waitlistOfferEmail(mail.data, formatInZone(claimExpiresAt, mail.data.event.timezone)),
    fromName: mail.data.brand.senderName,
    replyTo: mail.replyTo,
    idempotencyKey: `claim:${rsvpId}:${claimExpiresAt.getTime()}:${linkTag}`,
  };
}

/** Sends the claim email now. Never throws; true when handed to a provider. */
export async function sendClaimEmail(db: Db, rsvpId: string, options: {origin?: string; now?: Date} = {}): Promise<boolean> {
  try {
    if (!canSendEventEmail()) return false;
    const mail = await claimMailFor(db, rsvpId, options);
    if (!mail) return false;
    const sent = await sendEventEmail(mail);
    if (sent) await mail.commit();
    return sent;
  } catch (error) {
    console.warn(`[claim] email not sent for rsvp ${rsvpId}: ${(error as Error).name}`);
    return false;
  }
}
