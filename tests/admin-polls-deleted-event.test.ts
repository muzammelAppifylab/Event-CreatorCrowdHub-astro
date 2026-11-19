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
  return {...actual, emitWebhook: vi.fn(), emitWebhooks: vi.fn()};
});

import {adminPollRoutes} from '../src/server/routes/admin-polls';

const app = new Hono().route('/polls', adminPollRoutes);
const call = (path: string, method = 'GET', body?: unknown) =>
  app.request(path, {method, headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});

const P1 = '0192f0a1-0000-7000-8000-0000000000a1';
const good = {question: 'Best?', type: 'single_choice', options: ['A', 'B']};

const routes: [string, string, unknown?][] = [
  ['PATCH', `/polls/${P1}`, good],
  ['DELETE', `/polls/${P1}`],
  ['POST', `/polls/${P1}/open`],
  ['POST', `/polls/${P1}/close`],
  ['GET', `/polls/${P1}/results`],
  ['GET', `/polls/${P1}/results.csv`],
];

beforeEach(() => {
  vi.clearAllMocks();
  state.db = {
    poll: {
      // The database answers null when the poll's event is soft-deleted (the filter is in the where).
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({count: 1})),
      deleteMany: vi.fn(async () => ({count: 1})),
    },
    pollOption: {deleteMany: vi.fn(), createMany: vi.fn()},
    pollVote: {findMany: vi.fn(async () => [])},
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(),
  };
});

describe('single-poll admin routes on a soft-deleted event', () => {
  it.each(routes)('%s %s reads the poll only when its event is not deleted, else 404', async (method, path, body) => {
    const res = await call(path, method, body);
    expect(res.status).toBe(404);
    expect(state.db.poll.findUnique).toHaveBeenCalledTimes(1);
    const arg = state.db.poll.findUnique.mock.calls[0]![0];
    expect(arg.where).toEqual({id: P1, event: {deletedAt: null}});
    // Nothing is written for a poll that was not found.
    expect(state.db.$transaction).not.toHaveBeenCalled();
    expect(state.db.poll.updateMany).not.toHaveBeenCalled();
    expect(state.db.poll.deleteMany).not.toHaveBeenCalled();
    expect(state.db.pollVote.findMany).not.toHaveBeenCalled();
  });
});
