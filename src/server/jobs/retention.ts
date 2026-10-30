import type {PrismaClient} from '../../generated/prisma/client';
import {eraseRsvp, expiredGuestIds} from '../privacy';

/**
 * Retention sweep (docs/porting/privacy.md): anonymises RSVPs whose event ended more than
 * `RETENTION_DAYS` ago. Runs daily (background.json `guest-retention`).
 *
 * Bounded: at most `BATCHES` x `BATCH_SIZE` guests per run (the next day continues). Idempotent:
 * anonymised rows (email `...@invalid`) are no longer selected, and `eraseRsvp` re-checks inside
 * its own transaction. A guest mid-checkout is skipped and retried by a later run.
 */
export const RETENTION_BATCH_SIZE = 100;
export const RETENTION_MAX_BATCHES = 5;

export async function runRetention(db: PrismaClient, now: Date): Promise<{erased: number; skipped: number}> {
  let erased = 0;
  let skipped = 0;
  for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch++) {
    const ids = await expiredGuestIds(db, now, RETENTION_BATCH_SIZE);
    if (ids.length === 0) break;
    let progressed = 0;
    for (const id of ids) {
      const result = await eraseRsvp(db, id);
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
