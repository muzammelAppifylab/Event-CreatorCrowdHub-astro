import type {PrismaClient} from '../../generated/prisma/client';
import {sendEventEmail} from '../mailer';
import type {SendFn} from './deliveries';
import {queueGuestEmail} from './guest-emails';
import {expireCheckoutHolds} from './holds';
import {type ReminderRun, runReminders} from './reminders';
import {eventsWithLapsedClaims, expireEventClaims} from './waitlist';

export const RUN_DEADLINE_MS = 45_000;

export interface SchedulerSummary {
  ranAt: string;
  reminders: ReminderRun;
  waitlist: {lapsed: number; offered: number};
  holds: {expired: number};
  errors: string[];
}

const why = (error: unknown) => (error instanceof Error ? error.message.slice(0, 200) : 'failed');

/**
 * The scheduler tick (the `event-scheduler` list, every 5 minutes). Each step is independent:
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
        for (const offer of result.offers) {
          summary.waitlist.offered += 1;
          await queueGuestEmail('waitlist_offer', offer.rsvpId, String(offer.claimExpiresAt.getTime()));
        }
      } catch (error) {
        summary.errors.push(`waitlist ${eventId}: ${why(error)}`);
      }
    }
  } catch (error) {
    summary.errors.push(`waitlist: ${why(error)}`);
  }

  try {
    summary.holds.expired = (await expireCheckoutHolds(db, now)).released.length;
  } catch (error) {
    summary.errors.push(`holds: ${why(error)}`);
  }

  return summary;
}
