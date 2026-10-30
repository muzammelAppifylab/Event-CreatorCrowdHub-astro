import {consentEmail} from '../emails';
import {config} from '../platform/config';
import {loadGuestMail, siteBase, type Db} from './jobs/shared';
import {sendEventEmail} from './mailer';
import {consentUrl} from './privacy';

/**
 * Marketing-consent double opt-in (security audit M13): when an RSVP is created with
 * `marketingConsent`, the guest gets one email whose button hits `/privacy/consent/<token>`.
 * Until they confirm (`consentConfirmedAt`) nothing marketing is sent to them.
 * Call it after the commit, through `background(c, …)`. Never throws; returns whether it was handed to a provider.
 */
export async function sendConsentEmail(db: Db, rsvpId: string, options: {origin?: string; now?: Date} = {}): Promise<boolean> {
  try {
    const secret = config.jwtSecret;
    if (!secret) return false;
    const now = options.now ?? new Date();
    const rsvp = await db.rsvp.findUnique({where: {id: rsvpId}, select: {marketingConsent: true, consentConfirmedAt: true}});
    if (!rsvp?.marketingConsent || rsvp.consentConfirmedAt) return false;
    const mail = await loadGuestMail(db, rsvpId, now);
    if (!mail || mail.eventStatus === 'cancelled') return false;
    mail.data.guest.consentUrl = consentUrl(options.origin ?? siteBase(), rsvpId, secret, now);
    return await sendEventEmail({
      to: mail.to,
      content: consentEmail(mail.data),
      fromName: mail.data.brand.senderName,
      replyTo: mail.replyTo,
    });
  } catch (error) {
    console.warn(`[consent] email not sent for rsvp ${rsvpId}: ${(error as Error).name}`);
    return false;
  }
}
