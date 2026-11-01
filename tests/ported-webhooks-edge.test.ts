import {beforeEach, describe, expect, it, vi} from 'vitest';

import {DontRetry} from '../src/platform/background';

const sent: Array<{url: string; list: string; data: {items: Array<{id: string; event: string; body: string; endpointIds: string[]}>}; opts: {key?: string}}> = [];
const sendJobImpl = vi.hoisted(() => ({fn: null as null | ((...a: unknown[]) => Promise<unknown>)}));
vi.mock('../src/platform/background', async orig => ({
  ...(await orig<typeof import('../src/platform/background')>()),
  sendJob: async (url: string, list: string, data: never, opts: never) => {
    if (sendJobImpl.fn) return sendJobImpl.fn(url, list, data, opts);
    sent.push({url, list, data, opts});
    return {id: 'j'} as never;
  },
}));

import {attemptDelivery, deliverWebhookJob, envelope, signBody, verifySignature, WEBHOOK_EVENTS} from '../src/server/webhook-delivery';
import {dispatchWebhook, eventsOf} from '../src/server/webhooks';

const dbOf = (endpoints: Array<{id: string; events: unknown}>) => ({webhookEndpoint: {findMany: async () => endpoints}}) as never;
const json = (status: number) => async () => new Response('x', {status});

beforeEach(() => {
  sent.length = 0;
  sendJobImpl.fn = null;
});

describe('dispatchWebhook', () => {
  it('queues ONE job per event carrying every subscribed endpoint, with a delivery id and idempotency key', async () => {
    const n = await dispatchWebhook(dbOf([{id: 'a', events: ['order.paid']}, {id: 'b', events: ['order.paid', 'rsvp.created']}, {id: 'c', events: ['rsvp.created']}]), 'order.paid', {rsvpId: 'r'});
    expect(n).toBe(1);
    expect(sent).toHaveLength(1);
    const [job] = sent;
    expect(job.list).toBe('webhook-deliveries');
    expect(job.data.items).toHaveLength(1);
    const [item] = job.data.items;
    expect(item.endpointIds).toEqual(['a', 'b']);
    expect(job.opts.key).toBe(`wh-${item.id}`);
    const body = JSON.parse(item.body);
    expect(body).toMatchObject({id: item.id, event: 'order.paid', data: {rsvpId: 'r'}});
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  });

  it('ignores garbage in the stored events column', async () => {
    expect(eventsOf(['order.paid', 'nope', 3, null])).toEqual(['order.paid']);
    expect(eventsOf('order.paid')).toEqual([]);
    expect(await dispatchWebhook(dbOf([{id: 'a', events: 'order.paid'}]), 'order.paid', {})).toBe(0);
  });

  it('only asks for active endpoints', async () => {
    const findMany = vi.fn(async () => []);
    await dispatchWebhook({webhookEndpoint: {findMany}} as never, 'rsvp.created', {});
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({where: {active: true}}));
  });

  it('never throws: a failing db returns 0; a refused job (and no outbox) is logged, not thrown', async () => {
    const bad = {webhookEndpoint: {findMany: async () => Promise.reject(new Error('db down'))}} as never;
    expect(await dispatchWebhook(bad, 'rsvp.created', {})).toBe(0);
    sendJobImpl.fn = async () => Promise.reject(new Error('platform refused'));
    await expect(dispatchWebhook(dbOf([{id: 'a', events: ['rsvp.created']}]), 'rsvp.created', {})).resolves.toBe(1);
  });

  it('skips an oversized payload instead of queueing it', async () => {
    const n = await dispatchWebhook(dbOf([{id: 'a', events: ['rsvp.created']}]), 'rsvp.created', {blob: 'x'.repeat(30_000)});
    expect(n).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('every declared event name can be dispatched', async () => {
    for (const e of WEBHOOK_EVENTS) expect(await dispatchWebhook(dbOf([{id: 'a', events: [e]}]), e, {})).toBe(1);
  });
});

describe('delivery', () => {
  const endpoint = {url: 'https://hooks.example-receiver.com/in/abc', secret: 'whsec_test'};

  it('signs the exact body bytes and sends event + delivery id headers', async () => {
    const {id, body} = envelope('order.paid', {a: 1});
    let seen: RequestInit | undefined;
    const r = await attemptDelivery(endpoint, 'order.paid', id, body, {fetch: async (_u, init) => ((seen = init), new Response(null, {status: 204}))});
    expect(r).toMatchObject({ok: true, status: 204, retryable: false});
    const h = seen!.headers as Record<string, string>;
    expect(h['X-Ezy-Event']).toBe('order.paid');
    expect(h['X-Ezy-Delivery']).toBe(id);
    expect(seen!.body).toBe(body);
    expect(await verifySignature('whsec_test', body, h['X-Ezy-Signature'])).toBe(true);
    // a one-byte change or another secret never verifies
    expect(await verifySignature('whsec_test', body + ' ', h['X-Ezy-Signature'])).toBe(false);
    expect(await verifySignature('other', body, h['X-Ezy-Signature'])).toBe(false);
    expect(await verifySignature('whsec_test', body, null)).toBe(false);
    expect(await verifySignature('whsec_test', body, 'sha256=short')).toBe(false);
  });

  it.each([[408, true], [429, true], [500, true], [503, true], [400, false], [404, false], [301, false], [302, false]])('status %i retryable=%s', async (status, retryable) => {
    const r = await attemptDelivery(endpoint, 'e', 'd', '{}', {fetch: json(status)});
    expect(r).toMatchObject({ok: false, status, retryable});
  });

  it('a network error is retryable and its message (which could carry the secret URL) is not kept', async () => {
    const r = await attemptDelivery(endpoint, 'e', 'd', '{}', {fetch: async () => Promise.reject(new Error('connect ECONNREFUSED https://hooks.example-receiver.com/in/abc'))});
    expect(r).toMatchObject({ok: false, status: null, retryable: true});
    expect(r.error).not.toContain('abc');
  });

  it('a timeout is reported as a timeout and is retryable', async () => {
    const r = await attemptDelivery(endpoint, 'e', 'd', '{}', {
      timeoutMs: 20,
      fetch: (_u, init) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    expect(r).toMatchObject({ok: false, retryable: true});
    expect(r.error).toMatch(/Timed out/);
  });

  it('a retry sends the same delivery id and body (receivers dedupe), still validly signed', async () => {
    const calls: RequestInit[] = [];
    const db = {webhookEndpoint: {findUnique: async () => ({...endpoint, active: true})}} as never;
    const data = (() => {
      const {id, body} = envelope('order.paid', {rsvpId: 'r'});
      return {endpointId: 'e1', event: 'order.paid', deliveryId: id, body};
    })();
    const flaky = async (_u: string, init: RequestInit) => (calls.push(init), new Response(null, {status: calls.length === 1 ? 502 : 200}));
    await expect(deliverWebhookJob(data, undefined, {db, fetch: flaky})).rejects.not.toBeInstanceOf(DontRetry);
    await expect(deliverWebhookJob(data, undefined, {db, fetch: flaky})).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect((calls[0]!.headers as Record<string, string>)['X-Ezy-Delivery']).toBe((calls[1]!.headers as Record<string, string>)['X-Ezy-Delivery']);
    expect(calls[0]!.body).toBe(calls[1]!.body);
  });

  it('a 4xx throws DontRetry; a missing or paused endpoint returns quietly without fetching', async () => {
    const fetch = vi.fn(json(410));
    const active = {webhookEndpoint: {findUnique: async () => ({...endpoint, active: true})}} as never;
    await expect(deliverWebhookJob({endpointId: 'e', event: 'e', deliveryId: 'd', body: '{}'}, undefined, {db: active, fetch})).rejects.toBeInstanceOf(DontRetry);
    fetch.mockClear();
    for (const row of [null, {...endpoint, active: false}]) {
      const db = {webhookEndpoint: {findUnique: async () => row}} as never;
      await expect(deliverWebhookJob({endpointId: 'e', event: 'e', deliveryId: 'd', body: '{}'}, undefined, {db, fetch})).resolves.toBeUndefined();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('signBody is deterministic and secret dependent', async () => {
    expect(await signBody('a', 'b')).toBe(await signBody('a', 'b'));
    expect(await signBody('a', 'b')).not.toBe(await signBody('c', 'b'));
    expect(await signBody('a', 'b')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
