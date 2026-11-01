import {confirmationEmail, eventCancelledEmail, holdExpiredEmail, waitlistOfferEmail, type EmailContent} from '../../emails';
import {formatInZone} from '../../domain/time';
import {sendJob} from '../../platform/background';
import {claimMailFor} from '../claim-mail';
import {canSendEventEmail, sendEventEmail} from '../mailer';
import {claimDelivery, sendClaimed, type SendFn} from './deliveries';
import {loadGuestMail, siteBase, type Db} from './shared';

export type GuestEmailKind = 'confirmation' | 'waitlist_offer' | 'hold_expired' | 'event_cancelled';
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
 * The event's `confirmation` rule: `skip` when the host switched it off, else its id and the
 * host's edited subject/body (merge tags are rendered by `confirmationEmail`), or none for the default.
 */
export async function confirmationRuleFor(
  db: Pick<Db, 'reminderRule'>,
  eventId: string,
): Promise<{skip: boolean; ruleId: string | null; copy: {subject: string; body: string} | null}> {
  const rule = await db.reminderRule.findFirst({where: {eventId, kind: 'confirmation'}, select: {id: true, enabled: true, subject: true, body: true}});
  if (rule && !rule.enabled) return {skip: true, ruleId: rule.id, copy: null};
  return {skip: false, ruleId: rule?.id ?? null, copy: rule ? {subject: rule.subject, body: rule.body} : null};
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
    const rule = rsvp ? await confirmationRuleFor(db, rsvp.eventId) : null;
    if (rule?.skip) return 'skipped';
    ruleId = rule?.ruleId ?? null;
    content = confirmationEmail(data, rule?.copy ?? null);
  } else if (kind === 'waitlist_offer') {
    const rsvp = await db.rsvp.findUnique({where: {id: rsvpId}, select: {claimExpiresAt: true}});
    if (data.guest.status !== 'waitlisted' || !rsvp?.claimExpiresAt || rsvp.claimExpiresAt <= now) return 'skipped';
    const claim = await claimMailFor(db, rsvpId, {now, rotate: Boolean(options.send) || canSendEventEmail()});
    content = claim?.content ?? waitlistOfferEmail(data, formatInZone(rsvp.claimExpiresAt, data.event.timezone));
  } else if (kind === 'event_cancelled') {
    // US-11: everyone still expecting the event hears about it; paid guests are told a refund follows.
    if (mail.eventStatus !== 'cancelled' || !['confirmed', 'waitlisted', 'pending', 'awaiting_payment'].includes(data.guest.status)) return 'skipped';
    const paid = await db.ticketOrder.findFirst({where: {rsvpId, status: {in: ['refund_due', 'refunded']}}, select: {id: true}});
    content = eventCancelledEmail(data, {refund: Boolean(paid)});
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
