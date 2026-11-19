import {confirmationEmail, eventCancelledEmail, holdExpiredEmail, waitlistOfferEmail, type EmailBrand, type EmailContent} from '../../emails';
import {formatInZone} from '../../domain/time';
import {getDb} from '../../platform/db';
import {claimMailFor} from '../claim-mail';
import {canSendEventEmail, sendEventEmail} from '../mailer';
import {claimDelivery, sendClaimed, type SendFn} from './deliveries';
import {enqueueGuestEmails, type GuestEmailKind, kickGuestEmails} from './outbox';
import {type GuestMail, loadGuestMail, PERMANENT_ERROR_PREFIX, type Db} from './shared';

export type {GuestEmailKind} from './outbox';
export type GuestEmailOutcome = 'sent' | 'skipped' | 'failed';

/** The old one-job-per-email list: kept only so jobs queued before the outbox still run (they enqueue). */
export const GUEST_EMAIL_LIST = 'rsvp-emails';

/**
 * Queue one transactional email: a row in the guest email outbox (./outbox), then a kick so it goes
 * out within seconds. The key makes a repeat a no-op. Hooks and the scheduler never send mail
 * inline. Never throws: the state change already happened, a lost notification is only logged.
 * Pass `db` (a transaction client) and `kick: false` to enqueue inside the caller's transaction,
 * then call `kickGuestEmails()` after the commit.
 */
export async function queueGuestEmail(
  kind: GuestEmailKind,
  rsvpId: string,
  stamp = '',
  options: {db?: Db; kick?: boolean} = {},
): Promise<void> {
  await queueGuestEmails([{kind, rsvpId, stamp}], options);
}

/** Several transactional emails in ONE insert and one kick (never `queueGuestEmail` in a loop). Never throws. */
export async function queueGuestEmails(
  items: Array<{kind: GuestEmailKind; rsvpId: string; stamp?: string}>,
  options: {db?: Db; kick?: boolean} = {},
): Promise<void> {
  if (!items.length) return;
  try {
    const db = options.db ?? getDb();
    if (!db) throw new Error('The Site Database is off.');
    await enqueueGuestEmails(
      db,
      items.map(({kind, rsvpId, stamp}) => ({key: `${kind}-${rsvpId}${stamp ? `-${stamp}` : ''}`, kind, rsvpId})),
    );
  } catch (error) {
    const kinds = [...new Set(items.map(i => i.kind))].join(', ');
    console.error(`[outbox] could not queue ${kinds} email: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    return;
  }
  if (options.kick !== false) await kickGuestEmails();
}

/**
 * The event's `confirmation` rule: `skip` when the host switched it off, else its id and the
 * host's edited subject/body (merge tags are rendered by `confirmationEmail`), or none for the default.
 */
export type ConfirmationRule = {skip: boolean; ruleId: string | null; copy: {subject: string; body: string} | null};

const confirmationRuleSelect = {id: true, enabled: true, subject: true, body: true} as const;

function toConfirmationRule(rule: {id: string; enabled: boolean; subject: string; body: string} | null): ConfirmationRule {
  if (rule && !rule.enabled) return {skip: true, ruleId: rule.id, copy: null};
  return {skip: false, ruleId: rule?.id ?? null, copy: rule ? {subject: rule.subject, body: rule.body} : null};
}

export async function confirmationRuleFor(db: Pick<Db, 'reminderRule'>, eventId: string): Promise<ConfirmationRule> {
  const rule = await db.reminderRule.findFirst({where: {eventId, kind: 'confirmation'}, select: confirmationRuleSelect});
  return toConfirmationRule(rule);
}

/** `confirmationRuleFor` for several events in ONE query (a drain round): every asked event gets an entry. */
export async function confirmationRulesFor(db: Pick<Db, 'reminderRule'>, eventIds: readonly string[]): Promise<Map<string, ConfirmationRule>> {
  const ids = [...new Set(eventIds)];
  const rules = new Map<string, ConfirmationRule>();
  if (!ids.length) return rules;
  const rows = await db.reminderRule.findMany({where: {eventId: {in: ids}, kind: 'confirmation'}, select: {...confirmationRuleSelect, eventId: true}});
  const firstByEvent = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!firstByEvent.has(row.eventId)) firstByEvent.set(row.eventId, row);
  for (const id of ids) rules.set(id, toConfirmationRule(firstByEvent.get(id) ?? null));
  return rules;
}

/**
 * Sends one of the guest emails now, after re-checking the RSVP still warrants it.
 * Confirmation emails go through the event's confirmation rule so a repeat never double sends
 * (unique rsvp+rule). Throws nothing the caller cannot retry: `failed` means try again later.
 *
 * Options (the outbox drain passes them): `final` says this is the last try (evaluated after the
 * send, so it can depend on what the provider said): a failure is then recorded as permanent.
 * Emails without a rule get ONE message_deliveries row, written when sent or on the final failure,
 * never one per retry (audit L-20). `idempotencyKey` goes to the provider; `brand` saves a read.
 * `mail` (this RSVP's, from `loadGuestMails`; `null`: it is gone) and `rule` (a confirmation's,
 * from `confirmationRulesFor`) were read for the whole round, so this reads neither again.
 */
export async function sendGuestEmail(
  db: Db,
  kind: GuestEmailKind,
  rsvpId: string,
  options: {
    now?: Date;
    send?: SendFn;
    final?: boolean | (() => boolean);
    /** The provider said 429 (or the run stopped): a rule delivery gets its try back (not counted against MAX_DELIVERY_ATTEMPTS). */
    rateLimited?: () => boolean;
    idempotencyKey?: string;
    brand?: EmailBrand;
    /** Preloaded mail data; `null` means the RSVP or its event is gone. Omit it to load it here. */
    mail?: GuestMail | null;
    /** The event's preloaded confirmation rule. Omit it to load it here. */
    rule?: ConfirmationRule;
  } = {},
): Promise<GuestEmailOutcome> {
  const now = options.now ?? new Date();
  const send = options.send ?? sendEventEmail;
  const isFinal = () => (typeof options.final === 'function' ? options.final() : options.final === true);
  const mail = options.mail !== undefined ? options.mail : await loadGuestMail(db, rsvpId, now, options.brand ? {brand: options.brand} : {});
  if (!mail) return 'skipped';
  const {data} = mail;
  let content: EmailContent;
  let ruleId: string | null = null;
  // A waitlist offer's new link is stored only once its email was accepted (claim-mail.ts).
  let afterSent = async () => {};

  if (kind === 'confirmation') {
    if (mail.eventStatus !== 'published' || data.guest.status !== 'confirmed') return 'skipped';
    const rule = options.rule ?? (await confirmationRuleFor(db, mail.eventId));
    if (rule.skip) return 'skipped';
    ruleId = rule.ruleId;
    content = confirmationEmail(data, rule.copy);
  } else if (kind === 'waitlist_offer') {
    const {claimExpiresAt} = mail;
    if (data.guest.status !== 'waitlisted' || !claimExpiresAt || claimExpiresAt <= now) return 'skipped';
    const claim = await claimMailFor(db, rsvpId, {now, rotate: Boolean(options.send) || canSendEventEmail(), mail});
    content = claim?.content ?? waitlistOfferEmail(data, formatInZone(claimExpiresAt, data.event.timezone));
    if (claim) afterSent = claim.commit;
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

  const payload = {to: mail.to, content, fromName: mail.data.brand.senderName, replyTo: mail.replyTo, idempotencyKey: options.idempotencyKey};
  if (ruleId) {
    const deliveryId = await claimDelivery(db, rsvpId, ruleId, now, {ignoreBackoff: true});
    if (!deliveryId) return 'skipped';
    const result = await sendClaimed(db, deliveryId, send, payload, now, {final: isFinal, rateLimited: options.rateLimited});
    return result.status;
  }
  let ok = false;
  let error = 'The email could not be sent.';
  try {
    ok = await send(payload);
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 400);
  }
  if (ok) {
    await afterSent();
    await db.messageDelivery.create({data: {rsvpId, status: 'sent', sentAt: now, attempts: 1}, select: {id: true}});
    return 'sent';
  }
  if (isFinal()) {
    await db.messageDelivery.create({data: {rsvpId, status: 'failed', error: `${PERMANENT_ERROR_PREFIX}${error}`, attempts: 1}, select: {id: true}});
  }
  return 'failed';
}
