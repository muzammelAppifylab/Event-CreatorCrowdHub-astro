import {Prisma} from '../../generated/prisma/client';
import {JobRejected, runsJobsLocally, sendJob} from '../../platform/background';
import {siteBase, type Db} from './shared';

/**
 * The guest email OUTBOX (audit H-3, M-21): every guest email (a confirmation after payment, a
 * waitlist offer, hold expired, event cancelled, a host broadcast, an invite) is a row in
 * `guest_email_outbox`, never one platform job each (the platform adds ~10 jobs a minute, so a
 * fan-out of jobs drops most of them). Callers insert rows, in the same transaction as the change
 * that warrants the email when they can, then call `kickGuestEmails()` after the commit. The
 * `guest-email-outbox` job (and every `event-scheduler` tick as a backstop) drains the outbox in
 * bounded batches (`drainGuestEmailOutbox` in ./outbox-drain).
 *
 * This file only enqueues and kicks: no email rendering here, so routes can import it cheaply.
 */

export const OUTBOX_LIST = 'guest-email-outbox';

export type GuestEmailKind = 'confirmation' | 'waitlist_offer' | 'hold_expired' | 'event_cancelled';
/** A host's decision on a guest (approve, decline, promote in the dashboard): `noticeContent` in ../guest-mail. */
export type NoticeKind = 'notice_confirmation' | 'notice_declined';
export type OutboxKind = GuestEmailKind | NoticeKind | 'broadcast' | 'invite';

export interface OutboxRow {
  /** Unique per email: a second enqueue with the same key is a no-op (re-armed only after REARM_AFTER_HOURS once finished). */
  key: string;
  kind: OutboxKind;
  rsvpId?: string | null;
  inviteId?: string | null;
  messageId?: string | null;
}

/** A finished row whose key comes again this long after it was enqueued AND sent is sent again (the old job key's
 * 24 h dedupe window; past the provider's 24 h Idempotency-Key memory, since the row id is that key). */
export const REARM_AFTER_HOURS = 24;
const INSERT_CHUNK = 500;

/**
 * Inserts outbox rows (one statement per 500). A row whose key exists is left alone, unless it
 * finished more than REARM_AFTER_HOURS ago: then it is pending again (a new hold that lapsed, a
 * second paid confirmation). Pass the transaction client to enqueue atomically with the change.
 */
export async function enqueueGuestEmails(db: Db, rows: OutboxRow[], now: Date = new Date()): Promise<void> {
  const rearmBefore = new Date(now.getTime() - REARM_AFTER_HOURS * 3_600_000);
  // One row per (cut) key, the first one kept: Postgres refuses to update the same conflicting row
  // twice in one statement (21000), which would lose the whole chunk.
  const seen = new Set<string>();
  const unique: Array<OutboxRow & {key: string}> = [];
  for (const r of rows) {
    const key = r.key.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({...r, key});
  }
  for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
    const values = unique
      .slice(i, i + INSERT_CHUNK)
      .map(
        r =>
          Prisma.sql`(${r.key}, ${r.kind}, ${r.rsvpId ?? null}::uuid, ${r.inviteId ?? null}::uuid, ${r.messageId ?? null}::uuid, ${now}, ${now})`,
      );
    await db.$executeRaw`
      INSERT INTO guest_email_outbox (idempotency_key, kind, rsvp_id, invite_id, message_id, next_attempt_at, created_at)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (idempotency_key) DO UPDATE
        SET status = 'pending', attempts = 0, next_attempt_at = EXCLUDED.next_attempt_at,
            last_error = NULL, sent_at = NULL, created_at = ${now}
        WHERE guest_email_outbox.status <> 'pending'
          AND GREATEST(guest_email_outbox.created_at, COALESCE(guest_email_outbox.sent_at, guest_email_outbox.created_at)) < ${rearmBefore}`;
  }
}

/** The outbox key of a host notice: per guest and per status reached, so a repeat of the same action is a no-op. */
export const noticeKey = (kind: NoticeKind, rsvpId: string, status: string) => `${kind}-${rsvpId}-${status}`.slice(0, 200);

/** One host notice row: `key` is its idempotency key (`noticeRows` in ../guest-notices builds them). */
export interface NoticeRow {
  key: string;
  kind: NoticeKind | 'waitlist_offer';
  rsvpId: string;
}

/**
 * Host notices (audit M-21): ONE statement for the whole action. A notice is about the guest's own
 * RSVP (approved, declined, promoted, a waitlist offer), so it goes out even to a guest who
 * unsubscribed from the host's updates: that opt-out covers broadcasts only (M-25, the privacy and
 * unsubscribe pages say so). A repeated key is a no-op, re-armed
 * as in `enqueueGuestEmails`. Returns how many emails were queued. Call `kickGuestEmails()` after the commit.
 */
export async function enqueueGuestNotices(db: Db, rows: NoticeRow[], now: Date = new Date()): Promise<number> {
  // One row per key: Postgres refuses to update the same conflicting row twice in one statement.
  const unique = [...new Map(rows.map(r => [r.key.slice(0, 200), r])).entries()];
  if (!unique.length) return 0;
  const rearmBefore = new Date(now.getTime() - REARM_AFTER_HOURS * 3_600_000);
  const keys = unique.map(([key]) => key);
  const kinds = unique.map(([, r]) => r.kind);
  const ids = unique.map(([, r]) => r.rsvpId);
  return db.$executeRaw`
    INSERT INTO guest_email_outbox (idempotency_key, kind, rsvp_id, next_attempt_at, created_at)
    SELECT v.key, v.kind, r.id, ${now}, ${now}
    FROM unnest(${keys}::text[], ${kinds}::text[], ${ids}::uuid[]) AS v(key, kind, id)
    JOIN rsvps AS r ON r.id = v.id
    ON CONFLICT (idempotency_key) DO UPDATE
      SET status = 'pending', attempts = 0, next_attempt_at = EXCLUDED.next_attempt_at,
          last_error = NULL, sent_at = NULL, created_at = ${now}
      WHERE guest_email_outbox.status <> 'pending'
          AND GREATEST(guest_email_outbox.created_at, COALESCE(guest_email_outbox.sent_at, guest_email_outbox.created_at)) < ${rearmBefore}`;
}

let lastKickMinute = -1;

/**
 * Asks for a drain now, so emails go out within seconds instead of at the next scheduler tick.
 * Live: one job per minute, keyed `outbox-<minute>` so every Worker shares it (the platform adds
 * ~10 jobs a minute for the whole site); a second kick in the same minute asks for the drain at the
 * start of the next minute instead (the same key `chainGuestEmails` uses). A refused kick is fine:
 * the scheduler tick drains the outbox anyway. Locally (the Preview, a developer's machine, tests)
 * the drain runs right here, now. Never throws. Call it AFTER the transaction that inserted the rows has committed.
 */
export async function kickGuestEmails(): Promise<void> {
  const local = runsJobsLocally();
  const minute = Math.floor(Date.now() / 60_000);
  if (!local && lastKickMinute === minute) return chainGuestEmails();
  lastKickMinute = minute;
  try {
    const sent = await sendJob(siteBase(), OUTBOX_LIST, {}, local ? {label: 'Guest emails'} : {key: `outbox-${minute}`, label: 'Guest emails'});
    // This minute's drain already ran (a chained run at the minute's start): ask for the next one instead.
    if (sent.deduplicated) await chainGuestEmails();
  } catch (error) {
    if (!(error instanceof JobRejected && error.code === 'E_JOBS_RATE_LIMITED')) lastKickMinute = -1;
    console.info(`[outbox] drain not requested now (${error instanceof Error ? error.message.slice(0, 120) : 'failed'}); the scheduler will send.`);
  }
}

let lastChainMinute = -1;

/** Asks for the next drain at the start of the next minute (emails still due). Live only; at most once a minute per Worker. Never throws. */
export async function chainGuestEmails(): Promise<void> {
  if (runsJobsLocally()) return;
  const minute = Math.floor(Date.now() / 60_000) + 1;
  if (lastChainMinute === minute) return;
  lastChainMinute = minute;
  try {
    await sendJob(siteBase(), OUTBOX_LIST, {}, {at: new Date(minute * 60_000), key: `outbox-${minute}`, label: 'Guest emails'});
  } catch (error) {
    console.info(`[outbox] next drain not requested (${error instanceof Error ? error.message.slice(0, 120) : 'failed'}); the scheduler will send.`);
  }
}

/**
 * US-11: one `event_cancelled` email for every guest still expecting the event, in ONE statement
 * (no page of ids through the Worker, no cap). Keyed like `queueGuestEmail` (`event_cancelled-<rsvp>`),
 * so a repeat is a no-op. Returns how many rows were added. Call `kickGuestEmails()` after.
 */
export async function enqueueEventCancelledEmails(db: Db, eventId: string, now: Date = new Date()): Promise<number> {
  return db.$executeRaw`
    INSERT INTO guest_email_outbox (idempotency_key, kind, rsvp_id, next_attempt_at, created_at)
    SELECT 'event_cancelled-' || r.id::text, 'event_cancelled', r.id, ${now}, ${now}
    FROM rsvps AS r
    WHERE r.event_id = ${eventId}::uuid AND r.status IN ('confirmed', 'waitlisted', 'pending', 'awaiting_payment')
    ON CONFLICT (idempotency_key) DO NOTHING`;
}
