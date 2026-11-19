import type {PrismaClient} from '../../generated/prisma/client';
import {deleteExpiredInvites, eraseRsvp, expiredGuestIds, prunePrivacyAttempts, restoredErasedIds} from '../privacy';

/**
 * Retention sweep (docs/ARCHITECTURE.md), daily (background.json `guest-retention`):
 *   1. re-applies erasures a backup restore brought back (`guest_erasures`, audit M-27);
 *   2. anonymises RSVPs whose event ended more than `RETENTION_DAYS` ago;
 *   3. deletes host invites (name + address) for those events (audit M-26);
 *   4. prunes the privacy-link rate-limit rows older than a day.
 *
 * Bounded: at most `BATCHES` x `BATCH_SIZE` guests per step per run (the next day continues).
 * Idempotent: anonymised rows (email `...@invalid`) are no longer selected, and `eraseRsvp` re-checks
 * inside its own transaction. A guest mid-checkout is skipped and retried by a later run. Neither
 * step writes the erasure log (`log: false`). Expired guests' events ended long ago, so step 2 does
 * not promote (`promote: false`); a restored RSVP may be a confirmed seat for an upcoming event, so
 * step 1 hands the freed seat to the waitlist (`promote: true`; `eraseRsvp` only promotes for a
 * published event that has not ended).
 */
export const RETENTION_BATCH_SIZE = 100;
export const RETENTION_MAX_BATCHES = 5;

type Source = (db: PrismaClient, now: Date, limit: number) => Promise<string[]>;

async function eraseAll(db: PrismaClient, now: Date, source: Source, promote: boolean): Promise<{erased: number; skipped: number}> {
  let erased = 0;
  let skipped = 0;
  for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
    const ids = await source(db, now, RETENTION_BATCH_SIZE);
    if (ids.length === 0) break;
    let progressed = 0;
    for (const id of ids) {
      const result = await eraseRsvp(db, id, {now, promote, log: false});
      if (result === 'erased') {
        erased++;
        progressed++;
      } else if (result === 'checkout_in_progress') skipped++;
    }
    // Nothing moved (all skipped): the same rows would come back, so stop instead of looping.
    if (progressed === 0 || ids.length < RETENTION_BATCH_SIZE) break;
  }
  return {erased, skipped};
}

export async function runRetention(
  db: PrismaClient,
  now: Date,
): Promise<{erased: number; skipped: number; reapplied: number; invitesDeleted: number}> {
  const restored = await eraseAll(db, now, (d, _now, limit) => restoredErasedIds(d, limit), true);
  const expired = await eraseAll(db, now, expiredGuestIds, false);
  let invitesDeleted = 0;
  for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
    const n = await deleteExpiredInvites(db, now, 500);
    invitesDeleted += n;
    if (n < 500) break;
  }
  // A busy day can leave more than one batch of rate-limit rows: drain up to a few batches, bounded.
  for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
    if ((await prunePrivacyAttempts(db, now, 5000)) < 5000) break;
  }
  return {
    erased: expired.erased,
    skipped: expired.skipped + restored.skipped,
    reapplied: restored.erased,
    invitesDeleted,
  };
}
