import {describe, expect, it} from 'vitest';

import {DAILY_INVITE_LIMIT, DailyInviteLimitError, INVITE_LIMIT_LOCK, reserveDailyInvites} from '../src/server/routes/admin-invites';
import type {Db} from '../src/server/jobs/shared';

/**
 * A fake database for the M-15 check: `pg_advisory_xact_lock` is a real in-memory lock held until the
 * fake transaction ends, and the outbox count sees only committed rows (READ COMMITTED).
 */
function fakeDb(committed: number) {
  const calls: string[] = [];
  let lockTail: Promise<void> = Promise.resolve();
  let countWhere: unknown = null;
  const db = {
    get committed() {
      return committed;
    },
    calls,
    get countWhere() {
      return countWhere;
    },
    /** One transaction: `work` gets a tx; rows it queues are committed when it returns, then the lock is released. */
    async transaction<T>(work: (tx: Db, queue: (n: number) => void) => Promise<T>): Promise<T> {
      let release: (() => void) | null = null;
      let pending = 0;
      const tx = {
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          calls.push(`lock:${strings.join('?')}|${values.join(',')}`);
          const prev = lockTail;
          let unlock!: () => void;
          lockTail = new Promise<void>(r => (unlock = r));
          await prev;
          release = unlock;
          return 1;
        },
        guestEmailOutbox: {
          count: async (args: {where: unknown}) => {
            calls.push('count');
            countWhere = args.where;
            return committed;
          },
        },
      } as unknown as Db;
      try {
        const out = await work(tx, n => (pending += n));
        committed += pending;
        return out;
      } finally {
        (release as (() => void) | null)?.();
      }
    },
  };
  return db;
}

describe('reserveDailyInvites (M-15)', () => {
  const now = new Date('2026-11-13T12:00:00Z');

  it('takes the advisory lock first, then counts invite emails of the last 24 hours', async () => {
    const db = fakeDb(10);
    await db.transaction(tx => reserveDailyInvites(tx, 5, now));
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]).toContain('pg_advisory_xact_lock(hashtextextended(');
    expect(db.calls[0]).toContain(INVITE_LIMIT_LOCK);
    expect(db.calls[1]).toBe('count');
    expect(db.countWhere).toEqual({kind: 'invite', createdAt: {gte: new Date('2026-11-12T12:00:00Z')}});
  });

  it('allows a send that lands exactly on the limit and refuses one past it', async () => {
    await expect(fakeDb(DAILY_INVITE_LIMIT - 3).transaction(tx => reserveDailyInvites(tx, 3, now))).resolves.toBeUndefined();
    await expect(fakeDb(DAILY_INVITE_LIMIT - 3).transaction(tx => reserveDailyInvites(tx, 4, now))).rejects.toBeInstanceOf(DailyInviteLimitError);
    await expect(fakeDb(DAILY_INVITE_LIMIT).transaction(tx => reserveDailyInvites(tx, 1, now))).rejects.toBeInstanceOf(DailyInviteLimitError);
  });

  it('does nothing (no lock, no query) for an empty send', async () => {
    const db = fakeDb(DAILY_INVITE_LIMIT);
    await db.transaction(tx => reserveDailyInvites(tx, 0, now));
    expect(db.calls).toEqual([]);
  });

  it('lets only one of two simultaneous sends take the last free place', async () => {
    const db = fakeDb(DAILY_INVITE_LIMIT - 1);
    const send = () =>
      db.transaction(async (tx, queue) => {
        await reserveDailyInvites(tx, 1, now);
        await new Promise(r => setTimeout(r, 5)); // the insert takes a moment while the lock is held
        queue(1);
        return 'sent';
      });
    const results = await Promise.allSettled([send(), send()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(DailyInviteLimitError);
    expect(db.committed).toBe(DAILY_INVITE_LIMIT);
  });
});
