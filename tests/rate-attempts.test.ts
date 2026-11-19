import {beforeEach, describe, expect, it, vi} from 'vitest';

const secret = vi.hoisted(() => ({value: 'test-secret-for-rate-attempts-0123456789' as string | null}));
vi.mock('../src/platform/config', async orig => {
  const real = await orig<typeof import('../src/platform/config')>();
  return {...real, config: new Proxy(real.config, {get: (t, k) => (k === 'jwtSecret' ? secret.value : Reflect.get(t, k))})};
});

import {guestMailAllowed, RATE_LIMITS, takeAttempt} from '../src/server/rate-attempts';

type Sql = {strings: readonly string[]; values: unknown[]};
const flatten = (call: unknown[]): Sql => {
  // Prisma's tagged template: strings first, values after (nested Prisma.sql fragments stay objects).
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  return {strings, values};
};

let queryRaw: ReturnType<typeof vi.fn>;
const db = () => ({$queryRaw: queryRaw}) as never;

beforeEach(() => {
  secret.value = 'test-secret-for-rate-attempts-0123456789';
  queryRaw = vi.fn(async () => [{n: [0, 0]}]);
});

describe('takeAttempt', () => {
  it('allows when every count is under its max, in ONE statement', async () => {
    const out = await takeAttempt(db(), [
      {limit: RATE_LIMITS.mailEventEmail, key: 'ev:ada@example.com'},
      {limit: RATE_LIMITS.mailEmail, key: 'ada@example.com'},
    ]);
    expect(out).toEqual({allowed: true, over: null});
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('names the first limit that refused', async () => {
    queryRaw.mockResolvedValueOnce([{n: [1, RATE_LIMITS.mailEmail.max]}]);
    const out = await takeAttempt(db(), [
      {limit: RATE_LIMITS.mailEventEmail, key: 'ev:ada@example.com'},
      {limit: RATE_LIMITS.mailEmail, key: 'ada@example.com'},
    ]);
    expect(out).toEqual({allowed: false, over: RATE_LIMITS.mailEmail});
  });

  it('never sends a raw email or IP to the database, only 64-hex keyed hashes', async () => {
    await guestMailAllowed(db(), 'ev-1', ' Ada@Example.com ');
    await takeAttempt(db(), [{limit: RATE_LIMITS.rsvpIp, key: '203.0.113.9'}]);
    const all = JSON.stringify(queryRaw.mock.calls.map(c => flatten(c)));
    expect(all).not.toMatch(/ada@example\.com|203\.0\.113\.9/i);
    expect(all).toMatch(/[0-9a-f]{64}/);
  });

  it('hashes the address case-insensitively (one inbox, one cap)', async () => {
    await guestMailAllowed(db(), 'ev-1', 'ADA@example.com');
    await guestMailAllowed(db(), 'ev-1', 'ada@example.com');
    const hashes = (i: number) => JSON.stringify(queryRaw.mock.calls[i]).match(/[0-9a-f]{64}/g);
    expect(hashes(0)).toEqual(hashes(1));
  });

  it('does not limit without a hash key or before the migration', async () => {
    secret.value = null;
    expect(await takeAttempt(db(), [{limit: RATE_LIMITS.rsvpIp, key: 'x'}])).toEqual({allowed: true, over: null});
    expect(queryRaw).not.toHaveBeenCalled();
    secret.value = 'test-secret-for-rate-attempts-0123456789';
    queryRaw.mockRejectedValueOnce(Object.assign(new Error('relation "rate_attempts" does not exist'), {code: 'P2021'}));
    expect((await takeAttempt(db(), [{limit: RATE_LIMITS.rsvpIp, key: 'x'}])).allowed).toBe(true);
  });

  it('caps a guest email at 3 per event per hour and 10 per address per day', () => {
    expect(RATE_LIMITS.mailEventEmail).toMatchObject({max: 3, windowMs: 3_600_000});
    expect(RATE_LIMITS.mailEmail).toMatchObject({max: 10, windowMs: 86_400_000});
    for (const limit of Object.values(RATE_LIMITS)) expect(limit.kind.length).toBeLessThanOrEqual(24);
  });
});
