import {DontRetry, defineBackground} from '../platform/background';
import {deliverWebhookJob} from './webhook-delivery';
import {getDb} from '../platform/db';
import {GUEST_EMAIL_LIST, type GuestEmailKind, sendGuestEmail} from './jobs/guest-emails';
import {runRetention} from './jobs/retention';
import {runScheduler} from './jobs/run';

/**
 * This site's BACKGROUND JOBS: one handler per list (docs/agent/background-jobs.md).
 *
 *   event-scheduler  every 5 minutes (background.json): reminders, "we're live", thank-yous,
 *                    lapsed waitlist claims, expired payment holds. Bounded and idempotent.
 *   guest-retention  daily (background.json): anonymises RSVPs of events that ended over RETENTION_DAYS ago.
 *   rsvp-emails      one transactional email to one guest (confirmation after payment, a
 *                    waitlist offer, hold expired). Sent with `queueGuestEmail()`.
 *
 * Handlers re-check the rows they act on and are safe to run twice (message_deliveries has
 * unique(rsvp_id, reminder_rule_id); every status change is conditional).
 */
const KINDS: ReadonlySet<string> = new Set<GuestEmailKind>(['confirmation', 'waitlist_offer', 'hold_expired']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const background = defineBackground({
  'webhook-deliveries': (data, job) => deliverWebhookJob(data as never, job),

  'event-scheduler': async () => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off.');
    const summary = await runScheduler(db, new Date());
    console.info(
      `[scheduler] reminders sent=${summary.reminders.sent} failed=${summary.reminders.failed} lapsed=${summary.waitlist.lapsed} offered=${summary.waitlist.offered} holds=${summary.holds.expired}`,
    );
    // A step that threw is retried by the next tick; fail the run so the owner sees it in the Jobs tab.
    if (summary.errors.length > 0) throw new Error(summary.errors.slice(0, 3).join(' | ').slice(0, 400));
  },

  'guest-retention': async () => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off.');
    const {erased, skipped} = await runRetention(db, new Date());
    console.info(`[retention] erased=${erased} skipped=${skipped}`);
  },

  [GUEST_EMAIL_LIST]: async (data: {kind?: unknown; rsvpId?: unknown}) => {
    if (typeof data?.kind !== 'string' || !KINDS.has(data.kind) || typeof data.rsvpId !== 'string' || !UUID.test(data.rsvpId)) {
      throw new DontRetry('This email job has no valid guest.');
    }
    const db = getDb();
    if (!db) throw new Error('The Site Database is off.');
    const outcome = await sendGuestEmail(db, data.kind as GuestEmailKind, data.rsvpId);
    if (outcome === 'failed') throw new Error('The email could not be sent. It will be tried again.');
  },
});
