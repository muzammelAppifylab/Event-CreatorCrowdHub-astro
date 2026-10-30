import {describe, expect, it, vi} from 'vitest';

import {DontRetry} from '../src/platform/background';
import {parseEndpointInput} from '../src/server/routes/admin-webhooks';
import {
  attemptDelivery,
  deliverWebhookJob,
  envelope,
  newSecret,
  signBody,
  verifySignature,
  webhookUrlProblem,
} from '../src/server/webhook-delivery';

describe('webhook signing', () => {
  it('matches a known HMAC-SHA256 vector and verifies', async () => {
    // RFC 4231 style: key "key", message "The quick brown fox jumps over the lazy dog"
    const sig = await signBody('key', 'The quick brown fox jumps over the lazy dog');
    expect(sig).toBe('sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
    expect(await verifySignature('key', 'The quick brown fox jumps over the lazy dog', sig)).toBe(true);
    expect(await verifySignature('key', 'tampered', sig)).toBe(false);
    expect(await verifySignature('key', 'x', null)).toBe(false);
  });

  it('makes distinct whsec_ secrets', () => {
    expect(newSecret()).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(newSecret()).not.toBe(newSecret());
  });
});

describe('webhookUrlProblem (SSRF guard)', () => {
  it('accepts public https hosts', () => {
    expect(webhookUrlProblem('https://hooks.zapier.com/hooks/catch/1/abc/')).toBeNull();
    expect(webhookUrlProblem('https://hook.eu1.make.com:443/x')).toBeNull();
  });
  it.each([
    'http://example.com/x',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://2130706433/',
    'https://0x7f.1/',
    'https://127.1/',
    'https://[::1]/',
    'https://10.0.0.5/',
    'https://169.254.169.254/latest',
    'https://intranet/x',
    'https://db.internal/x',
    'https://printer.local/x',
    'https://user:pw@example.com/x',
    'https://example.com:8443/x',
    'ftp://example.com',
    'not a url',
    '',
  ])('refuses %s', url => {
    expect(webhookUrlProblem(url)).not.toBeNull();
  });
});

describe('endpoint input', () => {
  it('requires url and events on create, normalises event order', () => {
    expect(parseEndpointInput({}, false)).toMatchObject({field: 'url'});
    expect(parseEndpointInput({url: 'https://a.example.org/x', events: []}, false)).toMatchObject({field: 'events'});
    expect(parseEndpointInput({url: 'https://a.example.org/x', events: ['nope']}, false)).toMatchObject({field: 'events'});
    expect(parseEndpointInput({url: 'https://a.example.org/x', events: ['poll.closed', 'rsvp.created']}, false)).toEqual({
      url: 'https://a.example.org/x',
      events: ['rsvp.created', 'poll.closed'],
    });
  });
  it('allows partial updates', () => {
    expect(parseEndpointInput({active: false}, true)).toEqual({active: false});
    expect(parseEndpointInput({active: 'no'}, true)).toMatchObject({field: 'active'});
  });
});

const db = (row: unknown) => ({webhookEndpoint: {findUnique: vi.fn(async () => row)}}) as never;
const ENDPOINT = {url: 'https://hooks.zapier.com/x', secret: 's3cret', active: true};
const job = (body = envelope('rsvp.created', {id: 1})) => ({endpointId: 'e1', event: 'rsvp.created', deliveryId: body.id, body: body.body});

describe('attemptDelivery', () => {
  it('posts signed JSON, never following redirects', async () => {
    const fetch = vi.fn(async () => new Response(null, {status: 204}));
    const {id, body} = envelope('rsvp.created', {a: 1});
    const r = await attemptDelivery(ENDPOINT, 'rsvp.created', id, body, {fetch});
    expect(r.ok).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT.url);
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Ezy-Event']).toBe('rsvp.created');
    expect(headers['X-Ezy-Delivery']).toBe(id);
    expect(await verifySignature('s3cret', body, headers['X-Ezy-Signature'])).toBe(true);
  });
  it('never calls fetch for a bad stored URL', async () => {
    const fetch = vi.fn();
    const r = await attemptDelivery({url: 'https://10.0.0.1/', secret: 'x'}, 'e', 'd', '{}', {fetch});
    expect(r).toMatchObject({ok: false, retryable: false});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('classifies 3xx/4xx as final, 429/5xx and network errors as retryable', async () => {
    const run = (status: number) => attemptDelivery(ENDPOINT, 'e', 'd', '{}', {fetch: async () => new Response(null, {status})});
    expect((await run(302)).retryable).toBe(false);
    expect((await run(404)).retryable).toBe(false);
    expect((await run(429)).retryable).toBe(true);
    expect((await run(503)).retryable).toBe(true);
    const down = await attemptDelivery(ENDPOINT, 'e', 'd', '{}', {fetch: async () => Promise.reject(new Error('https://secret-path'))});
    expect(down).toMatchObject({ok: false, retryable: true});
    expect(down.error).not.toContain('secret-path');
  });
});

describe('deliverWebhookJob', () => {
  it('returns on success, ignores deleted or paused endpoints', async () => {
    await expect(deliverWebhookJob(job(), undefined, {db: db(ENDPOINT), fetch: async () => new Response(null, {status: 200})})).resolves.toBeUndefined();
    const fetch = vi.fn();
    await deliverWebhookJob(job(), undefined, {db: db(null), fetch});
    await deliverWebhookJob(job(), undefined, {db: db({...ENDPOINT, active: false}), fetch});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('throws to retry on 5xx, DontRetry on 4xx and malformed jobs', async () => {
    const answer = (status: number) => ({db: db(ENDPOINT), fetch: async () => new Response(null, {status})});
    const retry = await deliverWebhookJob(job(), undefined, answer(500)).catch(e => e);
    expect(retry).toBeInstanceOf(Error);
    expect(retry).not.toBeInstanceOf(DontRetry);
    await expect(deliverWebhookJob(job(), undefined, answer(410))).rejects.toBeInstanceOf(DontRetry);
    await expect(deliverWebhookJob({} as never, undefined, {db: db(ENDPOINT)})).rejects.toBeInstanceOf(DontRetry);
  });
  it('throws a plain error when the database is off', async () => {
    await expect(deliverWebhookJob(job(), undefined, {db: null})).rejects.not.toBeInstanceOf(DontRetry);
  });
});
