import type {EventEmail} from '../mailer';
import {addMinutes} from '../../domain/time';
import {errorText, isUniqueViolation, PERMANENT_ERROR_PREFIX, STALE_CLAIM_MINUTES, type Db} from './shared';

/**
 * Claims the (rsvp, rule) pair BEFORE sending: only the run that gets an id may send.
 * `message_deliveries` has unique(rsvp_id, reminder_rule_id), so two runs (a retry, an
 * overlapping schedule tick) can never both claim it. A failed delivery that is not permanent,
 * or a queued claim older than STALE_CLAIM_MINUTES (a crashed run), is claimed again.
 * `message_deliveries` has no created_at: `sentAt` holds the claim time while it is queued.
 */
export async function claimDelivery(db: Db, rsvpId: string, ruleId: string, now: Date): Promise<string | null> {
  try {
    const row = await db.messageDelivery.create({
      data: {rsvpId, reminderRuleId: ruleId, status: 'queued', sentAt: now},
      select: {id: true},
    });
    return row.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const existing = await db.messageDelivery.findFirst({
    where: {rsvpId, reminderRuleId: ruleId},
    select: {id: true, status: true, error: true, sentAt: true},
  });
  if (!existing) return null;
  const retryableFailure = existing.status === 'failed' && !(existing.error ?? '').startsWith(PERMANENT_ERROR_PREFIX);
  const staleClaim = existing.status === 'queued' && (!existing.sentAt || existing.sentAt <= addMinutes(now, -STALE_CLAIM_MINUTES));
  if (!retryableFailure && !staleClaim) return null;
  // Conditional write: of two runs looking at the same stale row, one wins.
  const won = await db.messageDelivery.updateMany({
    where: {id: existing.id, status: existing.status, sentAt: existing.sentAt},
    data: {status: 'queued', sentAt: now, error: null},
  });
  return won.count === 1 ? existing.id : null;
}

export async function markDelivery(db: Db, id: string, patch: {status: 'sent' | 'failed'; error?: string | null; sentAt?: Date}): Promise<void> {
  await db.messageDelivery.update({
    where: {id},
    data: {status: patch.status, error: patch.error ?? null, ...(patch.sentAt ? {sentAt: patch.sentAt} : {})},
  });
}

/** The event mail helper's shape (src/server/mailer.ts): true when handed to a provider. */
export type SendFn = (email: EventEmail) => Promise<boolean>;

/** Sends one email for a claimed delivery row and records the outcome. Never throws. */
export async function sendClaimed(
  db: Db,
  deliveryId: string,
  send: SendFn,
  mail: EventEmail,
  now: Date,
): Promise<{status: 'sent' | 'failed'; error?: string}> {
  try {
    const result = await send(mail);
    if (result) {
      await markDelivery(db, deliveryId, {status: 'sent', sentAt: now});
      return {status: 'sent'};
    }
    const error = 'The email could not be sent.';
    await markDelivery(db, deliveryId, {status: 'failed', error});
    return {status: 'failed', error};
  } catch (err) {
    const error = errorText(err);
    await markDelivery(db, deliveryId, {status: 'failed', error}).catch(() => undefined);
    return {status: 'failed', error};
  }
}
