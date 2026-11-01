import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({db: {} as Record<string, any>, stop: null as Response | null}));

vi.mock('../src/platform/guards', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/guards')>('../src/platform/guards');
  const dbMw = async (c: any, next: () => Promise<void>) => { c.set('db', state.db); await next(); };
  return {...actual, withDb: dbMw, withAuthCore: dbMw};
});
vi.mock('../src/platform/auth/kit', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/auth/kit')>('../src/platform/auth/kit');
  return {...actual, attempt: vi.fn(async () => ({stop: state.stop})), keysFor: vi.fn(async () => ({}))};
});

import {pollPublicRoutes, invalidateResults} from '../src/server/routes/polls-public';

const app = new Hono().route('/p', pollPublicRoutes);
const U = (n: number) => `0192f0a1-0000-7000-8000-${String(n).padStart(12, '0')}`;
const POLL = U(1), O1 = U(2), O2 = U(3);
const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request('/p/K7Q42X/votes', {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});

let poll: Record<string, any>;
beforeEach(() => {
  state.stop = null;
  invalidateResults(POLL);
  poll = {id: POLL, question: 'Q', type: 'single_choice', status: 'open', anonymous: true, showResultsToVoters: true, openedAt: new Date(), closedAt: null};
  state.db = {
    event: {findFirst: vi.fn(async () => ({id: 'e', title: 'Evt', pollJoinCode: 'K7Q42X'}))},
    poll: {findFirst: vi.fn(async () => poll)},
    pollOption: {findMany: vi.fn(async () => [{id: O1, pollId: POLL, label: 'A'}, {id: O2, pollId: POLL, label: 'B'}])},
    pollVote: {findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []), upsert: vi.fn(async () => ({}))},
  };
});

describe('public poll routes', () => {
  it('unknown/malformed code is 404 and no-store; throttle can 429', async () => {
    state.db.event.findFirst.mockResolvedValue(null);
    const res = await app.request('/p/nope/active');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('active: waiting without a poll, never leaks the voter token', async () => {
    state.db.poll.findFirst.mockResolvedValue(null);
    expect(await (await app.request('/p/K7Q42X/active')).json()).toMatchObject({status: 'waiting', poll: null, myVote: null});
    state.db.poll.findFirst.mockResolvedValue(poll);
    const open = await (await app.request('/p/k7q-42x/active', {headers: {cookie: `site_voter=${U(9)}`}})).text();
    expect(open).not.toContain(U(9));
  });
  it('first vote sets an HttpOnly scoped cookie and upserts', async () => {
    const res = await post({pollId: POLL, optionIds: [O1]});
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('site_voter=');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toContain('Path=/site-api/polls-public');
    expect(state.db.pollVote.upsert.mock.calls[0][0].create).toMatchObject({pollId: POLL, optionIds: [O1]});
    expect((await res.json()).results).not.toBeNull();
  });
  it('hides results when the host keeps them private', async () => {
    poll.showResultsToVoters = false;
    expect((await (await post({pollId: POLL, optionIds: [O1]})).json()).results).toBeNull();
    expect((await app.request('/p/K7Q42X/results')).status).toBe(403);
  });
  it('refuses bad shapes and closed/changed polls', async () => {
    expect((await post({pollId: 'x'})).status).toBe(422);
    expect((await post({pollId: POLL, optionIds: ['nope']})).status).toBe(422);
    expect((await post({pollId: POLL, optionIds: [O1, O2]})).status).toBe(422);
    expect((await post({pollId: POLL, optionIds: [U(77)]})).status).toBe(422);
    expect((await post({pollId: POLL, type: 'rating', optionIds: [O1]})).status).toBe(409);
    poll.status = 'closed';
    expect((await post({pollId: POLL, optionIds: [O1]})).status).toBe(409);
    state.db.poll.findFirst.mockResolvedValue(null);
    expect((await post({pollId: POLL, optionIds: [O1]})).status).toBe(404);
    expect(state.db.pollVote.upsert).not.toHaveBeenCalled();
  });
  it('short text: one answer per device; rating range enforced', async () => {
    poll.type = 'short_text';
    state.db.pollVote.findUnique.mockResolvedValue({optionIds: [], ratingValue: null, textValue: 'hi'});
    expect((await post({pollId: POLL, textValue: 'again'}, {cookie: `site_voter=${U(9)}`})).status).toBe(409);
    poll.type = 'rating';
    expect((await post({pollId: POLL, ratingValue: 9})).status).toBe(422);
  });
  it('results 404 with no opened poll', async () => {
    state.db.poll.findFirst.mockResolvedValue(null);
    expect((await app.request('/p/K7Q42X/results')).status).toBe(404);
  });
  it('vote rate-limit stop is returned before parsing the body', async () => {
    state.stop = new Response('slow', {status: 429});
    expect((await post({pollId: POLL, optionIds: [O1]})).status).toBe(429);
    expect(state.db.pollVote.upsert).not.toHaveBeenCalled();
  });
});
