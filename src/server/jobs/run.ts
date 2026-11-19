import type {PrismaClient} from '../../generated/prisma/client';
import {sendEventEmail} from '../mailer';
import type {SendFn} from './deliveries';
import {queueGuestEmails} from './guest-emails';
import {expireCheckoutHolds} from './holds';
import {type ReminderRun, runReminders} from './reminders';
import {drainWebhookOutbox} from '../webhooks';
import {drainGuestEmailOutbox, type OutboxRun} from './outbox-drain';
import {eventsWithLapsedClaims, expireEventClaims} from './waitlist';

export const RUN_DEADLINE_MS = 45_000;

export interface SchedulerSummary {
  ranAt: string;
  reminders: ReminderRun;
  waitlist: {lapsed: number; offered: number};
  holds: {expired: number};
  webhooks: {sent: number; dropped: number};
  /** The guest email outbox (backstop for the drain job a send kicks). */
  emails: OutboxRun;
  errors: string[];
}

const why = (error: unknown) => (error instanceof Error ? error.message.slice(0, 200) : 'failed');

/**
 * The scheduler tick (the `event-scheduler` list, every 5 minutes): reminders, lapsed waitlist
 * claims, expired holds, the webhook outbox, then the guest email outbox. Each step is independent:
 * one failing never stops the others, and the summary lists what threw. Every step is bounded
 * and idempotent, so an overlapping or repeated tick is harmless.
 */
export async function runScheduler(
  db: PrismaClient,
  now = new Date(),
  options: {send?: SendFn; deadlineMs?: number} = {},
): Promise<SchedulerSummary> {
  const deadline = Date.now() + (options.deadlineMs ?? RUN_DEADLINE_MS);
  const summary: SchedulerSummary = {
    ranAt: now.toISOString(),
    reminders: {due: 0, sent: 0, failed: 0, skipped: 0, errors: []},
    waitlist: {lapsed: 0, offered: 0},
    holds: {expired: 0},
    webhooks: {sent: 0, dropped: 0},
    emails: {sent: 0, skipped: 0, failed: 0, retrying: 0, more: false},
    errors: [],
  };

  try {
    summary.reminders = await runReminders(db, now, {send: options.send ?? sendEventEmail, deadline});
  } catch (error) {
    summary.errors.push(`reminders: ${why(error)}`);
  }

  try {
    for (const eventId of await eventsWithLapsedClaims(db, now)) {
      if (Date.now() >= deadline) break;
      try {
        const result = await expireEventClaims(db, eventId, now);
        summary.waitlist.lapsed += result.lapsed;
        summary.waitlist.offered += result.offers.length;
        // One outbox insert per event; no kick: this tick drains the outbox below.
        await queueGuestEmails(
          result.offers.map(offer => ({kind: 'waitlist_offer' as const, rsvpId: offer.rsvpId, stamp: String(offer.claimExpiresAt.getTime())})),
          {kick: false},
        );
      } catch (error) {
        summary.errors.push(`waitlist ${eventId}: ${why(error)}`);
      }
    }
  } catch (error) {
    summary.errors.push(`waitlist: ${why(error)}`);
  }

  try {
    summary.holds.expired = (await expireCheckoutHolds(db, now, undefined, {deadline})).released.length;
  } catch (error) {
    summary.errors.push(`holds: ${why(error)}`);
  }

  // Webhook deliveries the platform would not queue (rate limit) or a receiver refused: bounded, never throws.
  const outbox = await drainWebhookOutbox(db, now);
  summary.webhooks = {sent: outbox.sent, dropped: outbox.dropped};

  // Guest emails (waitlist offers queued above included): whatever time this tick has left.
  if (Date.now() < deadline) {
    try {
      summary.emails = await drainGuestEmailOutbox(db, now, {deadline});
    } catch (error) {
      summary.errors.push(`emails: ${why(error)}`);
    }
  }

  return summary;
}
