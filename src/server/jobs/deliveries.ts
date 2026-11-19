import type {EventEmail} from '../mailer';
import {addMinutes} from '../../domain/time';
import {errorText, isUniqueViolation, PERMANENT_ERROR_PREFIX, STALE_CLAIM_MINUTES, type Db} from './shared';

/** Most sends one (rsvp, rule) delivery gets: after that its failure is permanent (audit M-19). */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Wait after try number `attempts` before the next one: 1, 2, 4, 8 … minutes, at most an hour. */
export const deliveryBackoffMinutes = (attempts: number): number =>
  attempts <= 0 ? 0 : Math.min(2 ** (attempts - 1), 60);

/**
 * A failed delivery that may be claimed again now: not permanent, under the attempt cap, and past
 * its backoff. `sentAt` holds the time of the last claim (a failure does not move it).
 */
export function retryableNow(row: {status: string; error: string | null; sentAt: Date | null; attempts?: number | null}, now: Date): boolean {
  if (row.status !== 'failed' || (row.error ?? '').startsWith(PERMANENT_ERROR_PREFIX)) return false;
  const attempts = row.attempts ?? 0;
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return false;
  return !row.sentAt || row.sentAt <= addMinutes(now, -deliveryBackoffMinutes(attempts));
}

/**
 * Claims the (rsvp, rule) pair BEFORE sending: only the run that gets an id may send.
 * `message_deliveries` has unique(rsvp_id, reminder_rule_id), so two runs (a retry, an
 * overlapping schedule tick) can never both claim it. A failed delivery that is not permanent,
 * under MAX_DELIVERY_ATTEMPTS and past its backoff, or a queued claim older than
 * STALE_CLAIM_MINUTES (a crashed run), is claimed again; each claim counts one attempt.
 * `message_deliveries` has no created_at: `sentAt` holds the claim time while it is queued.
 * `ignoreBackoff`: the caller has its own backoff (the guest email outbox); the cap still holds.
 */
export async function claimDelivery(
  db: Db,
  rsvpId: string,
  ruleId: string,
  now: Date,
  options: {ignoreBackoff?: boolean} = {},
): Promise<string | null> {
  try {
    const row = await db.messageDelivery.create({
      data: {rsvpId, reminderRuleId: ruleId, status: 'queued', sentAt: now, attempts: 1},
      select: {id: true},
    });
    return row.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const existing = await db.messageDelivery.findFirst({
    where: {rsvpId, reminderRuleId: ruleId},
    select: {id: true, status: true, error: true, sentAt: true, attempts: true},
  });
  if (!existing) return null;
  const attempts = existing.attempts ?? 0;
  const retryableFailure = options.ignoreBackoff
    ? existing.status === 'failed' && !(existing.error ?? '').startsWith(PERMANENT_ERROR_PREFIX) && attempts < MAX_DELIVERY_ATTEMPTS
    : retryableNow(existing, now);
  const staleClaim = existing.status === 'queued' && (!existing.sentAt || existing.sentAt <= addMinutes(now, -STALE_CLAIM_MINUTES));
  if (!retryableFailure && !staleClaim) return null;
  // Conditional write: of two runs looking at the same stale row, one wins.
  const won = await db.messageDelivery.updateMany({
    where: {id: existing.id, status: existing.status, sentAt: existing.sentAt, attempts: existing.attempts},
    data: {status: 'queued', sentAt: now, error: null, attempts: attempts + 1},
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

/**
 * Sends one email for a claimed delivery row and records the outcome. Never throws.
 * The delivery id is the provider's Idempotency-Key (unless the caller set one), so a retry after
 * a timeout is sent once. A failure on the row's last allowed try (or when `final`) is permanent.
 */
export async function sendClaimed(
  db: Db,
  deliveryId: string,
  send: SendFn,
  mail: EventEmail,
  now: Date,
  options: {final?: boolean | (() => boolean); rateLimited?: () => boolean} = {},
): Promise<{status: 'sent' | 'failed'; error?: string}> {
  const fail = async (reason: string) => {
    let error = reason;
    if (options.rateLimited?.()) {
      // Not this email's fault (the provider's rate limit): retryable, and the claim's try is given back.
      await db.messageDelivery
        .updateMany({where: {id: deliveryId, attempts: {gt: 0}}, data: {status: 'failed', error, attempts: {decrement: 1}}})
        .catch(() => undefined);
      return {status: 'failed' as const, error};
    }
    let final = typeof options.final === 'function' ? options.final() : options.final === true;
    if (!final) {
      const row = await db.messageDelivery.findUnique({where: {id: deliveryId}, select: {attempts: true}}).catch(() => null);
      final = (row?.attempts ?? 0) >= MAX_DELIVERY_ATTEMPTS;
    }
    if (final) error = `${PERMANENT_ERROR_PREFIX}${reason}`.slice(0, 500);
    await markDelivery(db, deliveryId, {status: 'failed', error}).catch(() => undefined);
    return {status: 'failed' as const, error};
  };
  try {
    const result = await send({...mail, idempotencyKey: mail.idempotencyKey ?? `delivery-${deliveryId}`});
    if (result) {
      await markDelivery(db, deliveryId, {status: 'sent', sentAt: now});
      return {status: 'sent'};
    }
    return await fail('The email could not be sent.');
  } catch (err) {
    return await fail(errorText(err));
  }
}
