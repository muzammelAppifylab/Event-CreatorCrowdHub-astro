import {confirmationEmail, holdExpiredEmail, waitlistOfferEmail, type EmailContent} from '../../emails';
import {formatInZone} from '../../domain/time';
import {sendJob} from '../../platform/background';
import {claimMailFor} from '../claim-mail';
import {canSendEventEmail, sendEventEmail} from '../mailer';
import {claimDelivery, sendClaimed, type SendFn} from './deliveries';
import {loadGuestMail, siteBase, type Db} from './shared';

export type GuestEmailKind = 'confirmation' | 'waitlist_offer' | 'hold_expired';
export type GuestEmailOutcome = 'sent' | 'skipped' | 'failed';

export const GUEST_EMAIL_LIST = 'rsvp-emails';

/** Queue one transactional email (hooks and the scheduler must not send mail inline). The key makes a repeat a no-op. */
export async function queueGuestEmail(kind: GuestEmailKind, rsvpId: string, stamp = ''): Promise<void> {
  try {
    await sendJob(siteBase(), GUEST_EMAIL_LIST, {kind, rsvpId}, {key: `${kind}-${rsvpId}${stamp ? `-${stamp}` : ''}`, label: `Email · ${kind.replace('_', ' ')}`});
  } catch (error) {
    // The state change already happened; a lost notification is logged, never blocks it.
    console.error(`[jobs] could not queue ${kind} email: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
  }
}

/**
 * Sends one of the guest emails now, after re-checking the RSVP still warrants it.
 * Confirmation emails go through the event's confirmation rule so a repeat never double sends
 * (unique rsvp+rule). Throws nothing the caller cannot retry: `failed` means try again later.
 */
export async function sendGuestEmail(
  db: Db,
  kind: GuestEmailKind,
  rsvpId: string,
  options: {now?: Date; send?: SendFn} = {},
): Promise<GuestEmailOutcome> {
  const now = options.now ?? new Date();
  const send = options.send ?? sendEventEmail;
  const mail = await loadGuestMail(db, rsvpId, now);
  if (!mail) return 'skipped';
  const {data} = mail;
  let content: EmailContent;
  let ruleId: string | null = null;

  if (kind === 'confirmation') {
    if (mail.eventStatus !== 'published' || data.guest.status !== 'confirmed') return 'skipped';
    const rsvp = await db.rsvp.findUnique({where: {id: rsvpId}, select: {eventId: true}});
    const rule = rsvp
      ? await db.reminderRule.findFirst({where: {eventId: rsvp.eventId, kind: 'confirmation'}, select: {id: true, enabled: true, subject: true, body: true}})
      : null;
    if (rule && !rule.enabled) return 'skipped';
    ruleId = rule?.id ?? null;
    content = confirmationEmail(data, rule ? {subject: rule.subject, body: rule.body} : null);
  } else if (kind === 'waitlist_offer') {
    const rsvp = await db.rsvp.findUnique({where: {id: rsvpId}, select: {claimExpiresAt: true}});
    if (data.guest.status !== 'waitlisted' || !rsvp?.claimExpiresAt || rsvp.claimExpiresAt <= now) return 'skipped';
    const claim = await claimMailFor(db, rsvpId, {now, rotate: Boolean(options.send) || canSendEventEmail()});
    content = claim?.content ?? waitlistOfferEmail(data, formatInZone(rsvp.claimExpiresAt, data.event.timezone));
  } else {
    // Only for a hold that was really released; a guest who booked again needs no apology.
    if (data.guest.status !== 'cancelled') return 'skipped';
    content = holdExpiredEmail(data);
  }

  const payload = {to: mail.to, content, fromName: mail.data.brand.senderName, replyTo: mail.replyTo};
  if (ruleId) {
    const deliveryId = await claimDelivery(db, rsvpId, ruleId, now);
    if (!deliveryId) return 'skipped';
    const result = await sendClaimed(db, deliveryId, send, payload, now);
    return result.status;
  }
  const row = await db.messageDelivery.create({data: {rsvpId, status: 'queued'}, select: {id: true}});
  const result = await sendClaimed(db, row.id, send, payload, now);
  return result.status;
}
