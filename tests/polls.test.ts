import {describe, expect, it, vi} from 'vitest';

import {parsePollInput} from '../src/server/routes/admin-polls';
import {invalidateResults, isUuid, normalizeJoinCode, orderedUuid, POLL_LIMITS, resultsFor, voteRefusal} from '../src/server/routes/polls-public';
import {RATE_LIMITS} from '../src/platform/auth/rate-limit';

describe('parsePollInput', () => {
  const ok = {question: ' Best day? ', type: 'single_choice', options: [' Mon ', 'Tue']};

  it('trims and defaults the flags', () => {
    expect(parsePollInput(ok)).toEqual({question: 'Best day?', type: 'single_choice', options: ['Mon', 'Tue'], anonymous: true, showResultsToVoters: true});
  });
  it('drops options for rating and short text polls', () => {
    expect(parsePollInput({question: 'Rate it', type: 'rating', options: ['x']})).toMatchObject({options: []});
    expect(parsePollInput({question: 'Say hi', type: 'short_text'})).toMatchObject({options: []});
  });
  it.each([
    [{...ok, question: '  '}, 'question'],
    [{...ok, question: 'x'.repeat(201)}, 'question'],
    [{...ok, type: 'ranked'}, 'type'],
    [{...ok, options: ['Only']}, 'options'],
    [{...ok, options: Array.from({length: 11}, (_, i) => `o${i}`)}, 'options'],
    [{...ok, options: ['A', 'a']}, 'options'],
    [{...ok, options: ['A', '']}, 'options'],
    [{...ok, options: ['A', 5]}, 'options'],
    [{...ok, options: 'A,B'}, 'options'],
    [{...ok, anonymous: 'yes'}, 'anonymous'],
    [null, 'question'],
  ])('refuses %j', (input, field) => {
    expect(parsePollInput(input)).toMatchObject({field});
  });
});

describe('join codes and ids', () => {
  it('normalizes typed codes', () => {
    expect(normalizeJoinCode('k7q-42x')).toBe('K7Q42X');
    expect(normalizeJoinCode(' k7q 42x ')).toBe('K7Q42X');
  });
  it('rejects wrong length and characters outside the alphabet (0, O, 1, I, L)', () => {
    expect(normalizeJoinCode('K7Q42')).toBeNull();
    expect(normalizeJoinCode('K7Q42XX')).toBeNull();
    expect(normalizeJoinCode('K0Q42X')).toBeNull();
  });
  it('validates uuids', () => {
    expect(isUuid(crypto.randomUUID())).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(7)).toBe(false);
  });
  it('orderedUuid is a valid uuid whose order follows its position', () => {
    const ids = [3, 0, 12, 1].map(orderedUuid);
    expect(ids.every(isUuid)).toBe(true);
    expect([...ids].sort().map(id => parseInt(id.slice(0, 8), 16))).toEqual([0, 1, 3, 12]);
    expect(orderedUuid(5)).not.toBe(orderedUuid(5));
  });
});

describe('vote rate limit (own table, no lock)', () => {
  it('never adds kinds to the managed limiter', () => {
    for (const kind of ['vote', 'vote_device', 'vote_new_device', 'poll_lookup']) expect((RATE_LIMITS as Record<string, unknown>)[kind]).toBeUndefined();
  });
  it('a room on one IP is allowed; new devices, the IP volume and a fast device are capped', () => {
    const ok = {ip: 0, fresh: 0, device: 0};
    expect(voteRefusal({...ok, ip: POLL_LIMITS.ipVotes.max - 1, fresh: POLL_LIMITS.newDevices.max - 1}, false)).toBeNull();
    expect(voteRefusal({...ok, fresh: POLL_LIMITS.newDevices.max}, false)?.retryAfter).toBe(POLL_LIMITS.newDevices.retryAfter);
    // A known device is not a new ballot: the new-device count doesn't stop it.
    expect(voteRefusal({...ok, fresh: POLL_LIMITS.newDevices.max}, true)).toBeNull();
    expect(voteRefusal({...ok, ip: POLL_LIMITS.ipVotes.max}, true)).not.toBeNull();
    expect(voteRefusal({...ok, device: POLL_LIMITS.deviceVotes.max}, true)?.retryAfter).toBe(POLL_LIMITS.deviceVotes.retryAfter);
  });
});

describe('resultsFor (per-isolate cache)', () => {
  const options = [
    {id: 'o1', pollId: 'p', label: 'A'},
    {id: 'o2', pollId: 'p', label: 'B'},
  ];
  // The database does the counting now (one GROUP BY statement): the fake answers its rows.
  const fakeDb = (rows: unknown[]) => {
    const findVotes = vi.fn(async () => rows);
    const db = {pollOption: {findMany: vi.fn(async () => options)}, $queryRaw: findVotes};
    return {db: db as never, findVotes};
  };
  const poll = {id: 'cache-poll', type: 'single_choice' as const, status: 'open' as const};
  const row = (kind: string, key: string | null, n: number) => ({kind, poll_id: poll.id, key, n, text: null, at: null});

  it('aggregates, shares one query for a second, and refreshes after invalidate', async () => {
    invalidateResults(poll.id);
    const {db, findVotes} = fakeDb([row('o', 'o1', 2), row('o', 'o2', 1), row('v', null, 3)]);
    const [first, second] = await Promise.all([resultsFor(db, poll, 1000), resultsFor(db, poll, 1100)]);
    expect(first.totalVoters).toBe(3);
    expect(first.options.map(o => [o.label, o.count, o.percent])).toEqual([['A', 2, 67], ['B', 1, 33]]);
    expect(second).toBe(first);
    await resultsFor(db, poll, 1900);
    expect(findVotes).toHaveBeenCalledTimes(1);
    await resultsFor(db, poll, 2200);
    expect(findVotes).toHaveBeenCalledTimes(2);
    invalidateResults(poll.id);
    await resultsFor(db, poll, 2300);
    expect(findVotes).toHaveBeenCalledTimes(3);
  });

  it('does not keep a failed load', async () => {
    invalidateResults('bad');
    const db = {pollOption: {findMany: async () => options}, $queryRaw: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue([])} as never;
    await expect(resultsFor(db, {id: 'bad', type: 'rating', status: 'open'}, 5000)).rejects.toThrow('down');
    await expect(resultsFor(db, {id: 'bad', type: 'rating', status: 'open'}, 5001)).resolves.toMatchObject({totalVoters: 0});
  });
});

describe('jsonForScript', () => {
  it('cannot close the script tag and still parses back to the same value', async () => {
    const {jsonForScript} = await import('../src/server/routes/polls-public');
    const value = {q: '</script><img src=x onerror=1>', amp: 'a&b', sep: String.fromCharCode(0x2028, 0x2029)};
    const out = jsonForScript(value);
    expect(out).not.toMatch(/[<>&]/);
    expect(out).not.toContain(String.fromCharCode(0x2028));
    expect(out).toContain(String.fromCharCode(92) + 'u003c');
    expect(JSON.parse(out)).toEqual(value);
    expect(jsonForScript(undefined)).toBe('null');
  });
});

describe('poll code lookup', () => {
  it('only resolves published, live events and skips the query for malformed codes', async () => {
    const {eventByCode} = await import('../src/server/routes/polls-public');
    const findFirst = vi.fn(async (_args: unknown) => null);
    const db = {event: {findFirst}} as never;
    expect(await eventByCode(db, 'nope')).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
    await eventByCode(db, 'K7Q42X');
    expect(findFirst.mock.calls[0][0]).toMatchObject({where: {pollJoinCode: 'K7Q42X', deletedAt: null, status: 'published'}});
  });
  it('caps lookup misses per IP', () => {
    expect(POLL_LIMITS.lookupMisses.max).toBe(30);
  });
});
