import {describe, expect, it, vi} from 'vitest';

import {parsePollInput} from '../src/server/routes/admin-polls';
import {invalidateResults, isUuid, normalizeJoinCode, orderedUuid, resultsFor} from '../src/server/routes/polls-public';
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

describe('vote rate limit', () => {
  it('registers a per-IP policy for the vote kind', () => {
    const policy = (RATE_LIMITS as Record<string, {ip?: {free: number; counts: string}}>)['vote'];
    expect(policy?.ip?.free).toBeGreaterThan(100);
    expect(policy?.ip?.counts).toBe('all');
  });
});

describe('resultsFor (per-isolate cache)', () => {
  const options = [
    {id: 'o1', pollId: 'p', label: 'A'},
    {id: 'o2', pollId: 'p', label: 'B'},
  ];
  const fakeDb = (votes: unknown[]) => {
    const findVotes = vi.fn(async () => votes);
    const db = {pollOption: {findMany: vi.fn(async () => options)}, pollVote: {findMany: findVotes}};
    return {db: db as never, findVotes};
  };
  const poll = {id: 'cache-poll', type: 'single_choice' as const, status: 'open' as const};
  const vote = (voterToken: string, optionIds: string[]) => ({voterToken, optionIds, ratingValue: null, textValue: null, createdAt: new Date(), updatedAt: new Date()});

  it('aggregates, shares one query for a second, and refreshes after invalidate', async () => {
    invalidateResults(poll.id);
    const {db, findVotes} = fakeDb([vote('a', ['o1']), vote('b', ['o1']), vote('c', ['o2'])]);
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
    const db = {pollOption: {findMany: async () => options}, pollVote: {findMany: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue([])}} as never;
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
  it('registers a miss throttle', () => {
    expect((RATE_LIMITS as Record<string, unknown>)['poll_lookup']).toBeDefined();
  });
});
