import {DontRetry, defineBackground} from '../platform/background';
import {isUuid} from '../lib/text';
import {deliverWebhookJob} from './webhook-delivery';
import {getDb} from '../platform/db';
import {GUEST_EMAIL_LIST, type GuestEmailKind, queueGuestEmail} from './jobs/guest-emails';
import {chainGuestEmails, OUTBOX_LIST} from './jobs/outbox';
import {drainGuestEmailOutbox} from './jobs/outbox-drain';
import {runRetention} from './jobs/retention';
import {runScheduler} from './jobs/run';

/**
 * This site's BACKGROUND JOBS: one handler per list (docs/agent/background-jobs.md).
 *
 *   event-scheduler     every 5 minutes (background.json): reminders, "we're live", thank-yous,
 *                       lapsed waitlist claims, expired payment holds, the webhook outbox, and
 *                       the guest email outbox as a backstop. Bounded and idempotent.
 *   guest-retention     daily (background.json): anonymises RSVPs of events that ended over RETENTION_DAYS ago.
 *   guest-email-outbox  drains the guest email outbox (./jobs/outbox): every guest email
 *                       (confirmations, waitlist offers, hold expired, event cancelled, broadcasts,
 *                       invites) is a row there, never one job each. Kicked by `kickGuestEmails()`
 *                       after an enqueue (at most one job a minute), and chained while rows are due.
 *   rsvp-emails         LEGACY: one job per email, from before the outbox. Jobs still waiting on
 *                       the platform at deploy time are moved into the outbox. Remove later.
 *   webhook-deliveries  signed outbound webhooks (`dispatchWebhooks()` in ./webhooks).
 *
 * A handler gets the job's data (JSON) and returns when done. Throw to try again later;
 * throw `DontRetry` (from ../platform/background) when trying again cannot help. It may run more
 * than once: make it safe to repeat. Load what you need by id from the Site Database here; never
 * put a whole record (or a secret) in the data. The message of a thrown error is shown to the
 * owner in the Jobs tab: words for people, never a stack trace or a secret.
 *
 * Handlers re-check the rows they act on and are safe to run twice (message_deliveries has
 * unique(rsvp_id, reminder_rule_id); outbox rows are claimed with a lease; every status change is conditional).
 */
const KINDS: ReadonlySet<string> = new Set<GuestEmailKind>(['confirmation', 'waitlist_offer', 'hold_expired', 'event_cancelled']);

/**
 * L-40: the webhook job's data, checked before use: a batch (`{items: [...]}`, each item with string
 * ids and body; webhook-outbox.ts) or one legacy delivery (`{endpointId, event, deliveryId, body}`)
 * whose endpoint id is a UUID. Anything else can never succeed: DontRetry.
 */
function webhookJobData(data: unknown): Parameters<typeof deliverWebhookJob>[0] {
  const d = (data ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (Array.isArray(d.items)) {
    const ok =
      d.items.length <= 1000 &&
      d.items.every(i => {
        const item = (i ?? {}) as Record<string, unknown>;
        const ids = item.endpointIds;
        return typeof i === 'object' && str(item.id, 200) && str(item.event, 100) && typeof item.body === 'string' && Array.isArray(ids) && ids.every(e => typeof e === 'string');
      });
    if (!ok) throw new DontRetry('The webhook job is malformed.');
    return d as never;
  }
  if (!isUuid(d.endpointId) || !str(d.event, 100) || !str(d.deliveryId, 200) || typeof d.body !== 'string') {
    throw new DontRetry('The webhook job is malformed.');
  }
  return {endpointId: d.endpointId, event: d.event as string, deliveryId: d.deliveryId as string, body: d.body};
}

export const background = defineBackground({
  'webhook-deliveries': (data, job) => deliverWebhookJob(webhookJobData(data), job),

  'event-scheduler': async (_data, job) => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off.');
    const summary = await runScheduler(db, new Date());
    console.info(
      `[scheduler] reminders sent=${summary.reminders.sent} failed=${summary.reminders.failed} lapsed=${summary.waitlist.lapsed} offered=${summary.waitlist.offered} holds=${summary.holds.expired} webhooks=${summary.webhooks.sent} emails=${summary.emails.sent}`,
    );
    if (summary.emails.more && !job.local) await chainGuestEmails();
    // A step that threw is retried by the next tick; fail the run so the owner sees it in the Jobs tab.
    if (summary.errors.length > 0) throw new Error(summary.errors.slice(0, 3).join(' | ').slice(0, 400));
  },

  'guest-retention': async () => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off.');
    const {erased, skipped} = await runRetention(db, new Date());
    console.info(`[retention] erased=${erased} skipped=${skipped}`);
  },

  [OUTBOX_LIST]: async (_data, job) => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off.');
    let run = await drainGuestEmailOutbox(db, new Date());
    // Locally nothing chains a next run (jobs run inline, the scheduler may not tick): keep going
    // while rows are due and each run gets somewhere (bounded: a broadcast is at most 500 rows).
    for (let i = 0; job.local && run.more && run.sent + run.skipped + run.failed > 0 && i < 5; i++) {
      run = await drainGuestEmailOutbox(db, new Date());
    }
    console.info(`[outbox] sent=${run.sent} skipped=${run.skipped} failed=${run.failed} retrying=${run.retrying}${run.more ? ' more due' : ''}`);
    // Rows still due (a big broadcast, the provider's rate limit): the next run in about a minute.
    if (run.more && !job.local) await chainGuestEmails();
  },

  // LEGACY (before the outbox): move the email into the outbox and return; never sends from here.
  [GUEST_EMAIL_LIST]: async (data: {kind?: unknown; rsvpId?: unknown}) => {
    if (typeof data?.kind !== 'string' || !KINDS.has(data.kind) || !isUuid(data.rsvpId)) {
      throw new DontRetry('This email job has no valid guest.');
    }
    await queueGuestEmail(data.kind as GuestEmailKind, data.rsvpId, 'legacy');
  },
});
