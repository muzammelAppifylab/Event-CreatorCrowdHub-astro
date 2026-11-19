import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({db: {} as Record<string, any>}));

vi.mock('../src/platform/guards', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/guards')>('../src/platform/guards');
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    ...actual,
    withViewer: async (c: any, next: () => Promise<void>) => { c.set('viewer', {state: 'user', id: 7}); await next(); },
    requireAuth: pass,
    requirePermission: () => pass,
    withDb: async (c: any, next: () => Promise<void>) => { c.set('db', state.db); await next(); },
  };
});
vi.mock('../src/platform/auth/audit', () => ({audit: vi.fn(async () => undefined)}));
vi.mock('../src/server/webhook-emit', async () => {
  const actual = await vi.importActual<typeof import('../src/server/webhook-emit')>('../src/server/webhook-emit');
  return {...actual, emitWebhook: vi.fn()};
});

import {audit} from '../src/platform/auth/audit';
import {adminPollRoutes, POLL_EXPORT_MAX_ROWS, POLL_EXPORT_PAGE} from '../src/server/routes/admin-polls';
import {emitWebhook} from '../src/server/webhook-emit';

const app = new Hono().route('/polls', adminPollRoutes);
const call = (path: string, method = 'GET', body?: unknown) =>
  app.request(path, {method, headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});

const EV = '0192f0a1-0000-7000-8000-000000000001';
const P1 = '0192f0a1-0000-7000-8000-0000000000a1';
const P2 = '0192f0a1-0000-7000-8000-0000000000a2';
const good = {question: 'Best?', type: 'single_choice', options: ['A', 'B']};

let tx: Record<string, any>;
beforeEach(() => {
  vi.clearAllMocks();
  tx = {
    poll: {
      findMany: vi.fn(async () => [{id: P2}]),
      updateMany: vi.fn(async () => ({count: 1})),
      update: vi.fn(async () => ({id: P1, status: 'open'})),
    },
    pollOption: {deleteMany: vi.fn(), createMany: vi.fn()},
  };
  state.db = {
    event: {findFirst: vi.fn(async () => ({id: EV, title: 'T', startAt: new Date(), endAt: new Date()}))},
    poll: {
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({_max: {sortOrder: null}})),
      create: vi.fn(async () => ({id: P1, question: 'Best?', type: 'single_choice', status: 'draft', anonymous: true, showResultsToVoters: true, openedAt: null, closedAt: null})),
      findUnique: vi.fn(async () => ({id: P1, eventId: EV, status: 'draft'})),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({count: 1})),
      deleteMany: vi.fn(async () => ({count: 1})),
    },
    pollOption: {findMany: vi.fn(async () => [])},
    pollVote: {findMany: vi.fn(async () => [])},
    $executeRaw: vi.fn(async () => 2),
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg))),
  };
});

describe('admin polls routes', () => {
  it('404s on a non-uuid or missing event', async () => {
    expect((await call('/polls/event/nope')).status).toBe(404);
    state.db.event.findFirst.mockResolvedValueOnce(null);
    expect((await call(`/polls/event/${EV}`, 'POST', good)).status).toBe(404);
  });
  it('lists with no-store', async () => {
    const res = await call(`/polls/event/${EV}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
  it('by-code ignores malformed codes', async () => {
    expect((await call('/polls/by-code/xx')).status).toBe(404);
    expect(state.db.event.findFirst).not.toHaveBeenCalled();
  });
  it('creates a draft with 201 and refuses invalid input with 422', async () => {
    const res = await call(`/polls/event/${EV}`, 'POST', good);
    expect(res.status).toBe(201);
    expect(state.db.poll.create.mock.calls[0][0].data).toMatchObject({eventId: EV, question: 'Best?', anonymous: true});
    expect((await call(`/polls/event/${EV}`, 'POST', {...good, options: ['x']})).status).toBe(422);
    expect((await call(`/polls/event/${EV}`, 'POST', null)).status).toBe(422);
  });
  it('caps polls at 100 per event (409)', async () => {
    state.db.poll.count.mockResolvedValue(100);
    expect((await call(`/polls/event/${EV}`, 'POST', good)).status).toBe(409);
  });
  it('only edits and deletes drafts', async () => {
    expect((await call(`/polls/${P1}`, 'PATCH', good)).status).toBe(200);
    state.db.poll.findUnique.mockResolvedValue({id: P1, eventId: EV, status: 'open'});
    expect((await call(`/polls/${P1}`, 'PATCH', good)).status).toBe(409);
    expect((await call(`/polls/${P1}`, 'DELETE')).status).toBe(409);
    expect(state.db.poll.deleteMany).not.toHaveBeenCalled();
    state.db.poll.findUnique.mockResolvedValue({id: P1, eventId: EV, status: 'draft'});
    expect((await call(`/polls/${P1}`, 'DELETE')).status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({action: 'poll_deleted'}));
  });
  it('404s unknown poll ids', async () => {
    expect((await call('/polls/nope', 'DELETE')).status).toBe(404);
    state.db.poll.findUnique.mockResolvedValue(null);
    expect((await call(`/polls/${P1}/open`, 'POST')).status).toBe(404);
    expect((await call(`/polls/${P1}/results`)).status).toBe(404);
  });
  it('opening closes the others and audits; reopening an open poll is a no-op', async () => {
    expect((await call(`/polls/${P1}/open`, 'POST')).status).toBe(200);
    expect(tx.poll.updateMany.mock.calls[0][0]).toMatchObject({where: {id: {in: [P2]}}, data: {status: 'closed'}});
    expect(tx.poll.update.mock.calls[0][0].data).toMatchObject({status: 'open', closedAt: null});
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({action: 'poll_opened'}));
    vi.clearAllMocks();
    state.db.poll.findUnique.mockResolvedValue({id: P1, eventId: EV, status: 'open'});
    expect((await call(`/polls/${P1}/open`, 'POST')).status).toBe(200);
    expect(state.db.$transaction).not.toHaveBeenCalled();
  });
  it('maps a unique-index race on open to 409', async () => {
    state.db.$transaction.mockRejectedValueOnce(Object.assign(new Error('dup'), {code: 'P2002'}));
    expect((await call(`/polls/${P1}/open`, 'POST')).status).toBe(409);
  });
  it('close: refuses drafts, emits webhook once for open polls', async () => {
    expect((await call(`/polls/${P1}/close`, 'POST')).status).toBe(409);
    state.db.poll.findUnique.mockResolvedValue({id: P1, eventId: EV, status: 'open'});
    expect((await call(`/polls/${P1}/close`, 'POST')).status).toBe(200);
    expect(emitWebhook).toHaveBeenCalledTimes(1);
    vi.mocked(emitWebhook).mockClear();
    state.db.poll.updateMany.mockResolvedValue({count: 0});
    await call(`/polls/${P1}/close`, 'POST');
    expect(emitWebhook).not.toHaveBeenCalled();
    state.db.poll.findUnique.mockResolvedValue({id: P1, eventId: EV, status: 'closed'});
    expect((await call(`/polls/${P1}/close`, 'POST')).status).toBe(200);
  });
  it('reorder requires every poll exactly once', async () => {
    state.db.poll.findMany.mockResolvedValue([{id: P1}, {id: P2}]);
    expect((await call(`/polls/event/${EV}/order`, 'PATCH', {ids: [P1]})).status).toBe(422);
    expect((await call(`/polls/event/${EV}/order`, 'PATCH', {ids: [P1, P1]})).status).toBe(422);
    expect(state.db.$executeRaw).not.toHaveBeenCalled();
    expect((await call(`/polls/event/${EV}/order`, 'PATCH', {ids: [P2, P1]})).status).toBe(200);
    expect(state.db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(state.db.$executeRaw.mock.calls[0].slice(1)).toEqual([[P2, P1], EV]);
  });
  it('csv export sets headers, audits, and flags truncation', async () => {
    state.db.poll.findUnique.mockResolvedValue({id: P1, question: 'Q', type: 'single_choice', status: 'closed', anonymous: true});
    const res = await call(`/polls/${P1}/results.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('x-export-truncated')).toBe('0');
    expect(res.headers.get('content-disposition')).toContain('poll-votes-0192f0a1');
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({action: 'poll_results_exported', meta: {rows: 0, truncated: false}}));
  });
  it('csv export reads every page before it answers and cuts at POLL_EXPORT_MAX_ROWS', async () => {
    state.db.poll.findUnique.mockResolvedValue({id: P1, question: 'Q', type: 'rating', status: 'closed', anonymous: true});
    const when = new Date('2026-10-30T10:00:00Z');
    let served = 0;
    // An endless poll: every query answers as many votes as it asked for.
    state.db.pollVote.findMany.mockImplementation(async (args: any) =>
      Array.from({length: args.take}, () => ({id: `v${served++}`, optionIds: [], ratingValue: 3, textValue: null, createdAt: when, updatedAt: when}))
    );
    const res = await call(`/polls/${P1}/results.csv`);
    // The database is done before the response exists: nothing is read while the body is sent.
    const queries = state.db.pollVote.findMany.mock.calls.length;
    expect(served).toBe(POLL_EXPORT_MAX_ROWS + 1);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-export-truncated')).toBe('1');
    expect((await res.text()).trim().split('\r\n')).toHaveLength(POLL_EXPORT_MAX_ROWS + 1);
    expect(state.db.pollVote.findMany).toHaveBeenCalledTimes(queries);
    expect(Math.max(...state.db.pollVote.findMany.mock.calls.map((c: any[]) => c[0].take))).toBe(POLL_EXPORT_PAGE);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({meta: {rows: POLL_EXPORT_MAX_ROWS, truncated: true}}));
  });
  it('event csv: 404 for unknown event, rows per poll, emails only for named polls, audited', async () => {
    expect((await call('/polls/event/nope/results.csv')).status).toBe(404);
    const when = new Date('2026-10-30T10:00:00Z');
    state.db.poll.findMany.mockResolvedValue([
      {id: P1, question: 'Anon?', type: 'rating', anonymous: true},
      {id: P2, question: 'Named?', type: 'short_text', anonymous: false},
    ]);
    const votes = [
      {id: 'v1', pollId: P2, optionIds: [], ratingValue: null, textValue: 'hi', createdAt: when, updatedAt: when, rsvp: {email: 'a@x.test'}},
      {id: 'v2', pollId: P1, optionIds: [], ratingValue: 5, textValue: null, createdAt: when, updatedAt: when, rsvp: {email: 'b@x.test'}},
    ];
    // Read per poll (keyset pages), all before the answer: each call reads one poll's votes.
    state.db.pollVote.findMany.mockImplementation(async (args: any) => votes.filter(v => v.pollId === args.where.pollId));
    const res = await call(`/polls/event/${EV}/results.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('x-export-truncated')).toBe('0');
    expect(res.headers.get('content-disposition')).toContain('poll-votes-0192f0a1');
    const csv = await res.text();
    expect(csv).toContain('Anon?,5,2026-10-30T10:00:00.000Z,\r\n');
    expect(csv).toContain('Named?,hi,2026-10-30T10:00:00.000Z,a@x.test');
    expect(csv).not.toContain('b@x.test');
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({action: 'poll_results_exported', target: ['event', EV]}));
  });
  it("event csv: the cap counts votes across polls, and a later poll is not read once it is reached", async () => {
    const when = new Date("2026-10-30T10:00:00Z");
    state.db.poll.findMany.mockResolvedValue([
      {id: P1, question: "One", type: "rating", anonymous: true},
      {id: P2, question: "Two", type: "rating", anonymous: true},
    ]);
    let served = 0;
    state.db.pollVote.findMany.mockImplementation(async (args: any) =>
      Array.from({length: args.take}, () => ({id: `v${served++}`, optionIds: [], ratingValue: 1, textValue: null, createdAt: when, updatedAt: when}))
    );
    const res = await call(`/polls/event/${EV}/results.csv`);
    expect(res.headers.get("x-export-truncated")).toBe("1");
    expect(served).toBe(POLL_EXPORT_MAX_ROWS + 1);
    expect(state.db.pollVote.findMany.mock.calls.every((c: any[]) => c[0].where.pollId === P1)).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({target: ["event", EV], meta: {polls: 2, rows: POLL_EXPORT_MAX_ROWS, truncated: true}}));
  });
});
