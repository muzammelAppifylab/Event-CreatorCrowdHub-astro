import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({db: {} as Record<string, unknown>}));
vi.mock('../src/platform/guards', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/guards')>('../src/platform/guards');
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    ...actual,
    withViewer: async (c: {set: (k: string, v: unknown) => void}, next: () => Promise<void>) => {
      c.set('viewer', {state: 'user', id: 7});
      await next();
    },
    requireAuth: pass,
    requirePermission: () => pass,
    withDb: async (c: {set: (k: string, v: unknown) => void}, next: () => Promise<void>) => {
      c.set('db', state.db);
      await next();
    },
  };
});
vi.mock('../src/platform/auth', () => ({audit: vi.fn(async () => undefined)}));
vi.mock('../src/server/webhook-delivery', async () => {
  const actual = await vi.importActual<typeof import('../src/server/webhook-delivery')>('../src/server/webhook-delivery');
  return {...actual, attemptDelivery: vi.fn(async () => ({ok: true, status: 200, durationMs: 1, error: null, retryable: false}))};
});

import {audit} from '../src/platform/auth';
import {adminWebhookRoutes} from '../src/server/routes/admin-webhooks';

const app = new Hono().route('/wh', adminWebhookRoutes);
const ID = '0192f0a1-0000-7000-8000-000000000009';
const req = (path: string, method: string, body?: unknown) =>
  app.request(`/wh${path === '/' ? '' : path}`, {method, headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
const row = {id: ID, url: 'https://hooks.example.com/x', secret: 'whsec_abcd', events: ['rsvp.created'], active: true};

beforeEach(() => {
  vi.mocked(audit).mockClear();
  state.db = {
    webhookEndpoint: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({count: 1})),
      deleteMany: vi.fn(async () => ({count: 1})),
      findUnique: vi.fn(async () => row),
    },
  };
});

describe('webhook admin audit trail', () => {
  it('records create, update, test and delete without the url or secret', async () => {
    expect((await req('/', 'POST', {url: row.url, events: ['rsvp.created']})).status).toBe(201);
    expect((await req(`/${ID}`, 'PATCH', {active: false})).status).toBe(200);
    expect((await req(`/${ID}/test`, 'POST')).status).toBe(200);
    expect((await req(`/${ID}`, 'DELETE')).status).toBe(204);
    const actions = vi.mocked(audit).mock.calls.map(([, e]) => e.action);
    expect(actions).toEqual(['webhook_created', 'webhook_updated', 'webhook_tested', 'webhook_deleted']);
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toMatch(/hooks\.example|whsec_/);
  });
  it('rejects http: receiver URLs and audits nothing', async () => {
    expect((await req('/', 'POST', {url: 'http://hooks.example.com/x', events: ['rsvp.created']})).status).toBe(422);
    expect(audit).not.toHaveBeenCalled();
  });
});
