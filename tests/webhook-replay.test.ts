import {describe, expect, it, vi} from 'vitest';

import {
  attemptDelivery,
  envelope,
  signBody,
  signBodyV2,
  TIMESTAMP_TOLERANCE_SEC,
  verifySignature,
  verifySignatureV2,
} from '../src/server/webhook-delivery';

const ENDPOINT = {url: 'https://hooks.zapier.com/x', secret: 's3cret'};

describe('X-Ezy-Signature-V2 (timestamp-bound)', () => {
  it('matches a known HMAC-SHA256 vector over "<timestamp>.<body>"', async () => {
    // node: createHmac('sha256','key').update('1700000000.{"a":1}')
    expect(await signBodyV2('key', 1700000000, '{"a":1}')).toBe('v2=a438e398bfafc57e4396bb7fc2304422f0f768e965d073ca313cb52e22e6ad03');
    expect(await signBodyV2('key', '1700000000', '{"a":1}')).toBe(await signBodyV2('key', 1700000000, '{"a":1}'));
  });

  it('binds the timestamp: another timestamp, body or secret gives another signature', async () => {
    const sig = await signBodyV2('k', 100, 'body');
    expect(await signBodyV2('k', 101, 'body')).not.toBe(sig);
    expect(await signBodyV2('k', 100, 'body2')).not.toBe(sig);
    expect(await signBodyV2('k2', 100, 'body')).not.toBe(sig);
  });

  it('is not the V1 signature (V1 stays "sha256=" over the body alone)', async () => {
    expect(await signBody('k', 'body')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await signBodyV2('k', 100, 'body')).toMatch(/^v2=[0-9a-f]{64}$/);
  });

  it('verifies inside the freshness window and refuses outside it', async () => {
    const now = 1_700_000_000;
    const ts = String(now);
    const sig = await signBodyV2('k', ts, 'b');
    expect(await verifySignatureV2('k', 'b', ts, sig, {nowSec: now})).toBe(true);
    expect(await verifySignatureV2('k', 'b', ts, sig, {nowSec: now + TIMESTAMP_TOLERANCE_SEC})).toBe(true);
    expect(await verifySignatureV2('k', 'b', ts, sig, {nowSec: now + TIMESTAMP_TOLERANCE_SEC + 1})).toBe(false);
    expect(await verifySignatureV2('k', 'b', ts, sig, {nowSec: now - TIMESTAMP_TOLERANCE_SEC - 1})).toBe(false);
  });

  it('refuses a doctored timestamp, a tampered body, a wrong secret or missing parts', async () => {
    const now = 1_700_000_000;
    const sig = await signBodyV2('k', now, 'b');
    expect(await verifySignatureV2('k', 'b', String(now + 1), sig, {nowSec: now})).toBe(false);
    expect(await verifySignatureV2('k', 'tampered', String(now), sig, {nowSec: now})).toBe(false);
    expect(await verifySignatureV2('other', 'b', String(now), sig, {nowSec: now})).toBe(false);
    expect(await verifySignatureV2('k', 'b', null, sig, {nowSec: now})).toBe(false);
    expect(await verifySignatureV2('k', 'b', String(now), null, {nowSec: now})).toBe(false);
    expect(await verifySignatureV2('k', 'b', 'not-a-number', sig, {nowSec: now})).toBe(false);
  });
});

describe('attemptDelivery headers', () => {
  it('sends the old signature unchanged plus a timestamp and the V2 signature', async () => {
    const fetch = vi.fn(async () => new Response(null, {status: 204}));
    const {id, body} = envelope('rsvp.created', {a: 1});
    await attemptDelivery(ENDPOINT, 'rsvp.created', id, body, {fetch, nowMs: () => 1_700_000_123_999});
    const headers = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['X-Ezy-Signature']).toBe(await signBody('s3cret', body));
    expect(await verifySignature('s3cret', body, headers['X-Ezy-Signature'])).toBe(true);
    expect(headers['X-Ezy-Timestamp']).toBe('1700000123'); // unix seconds, floored
    expect(headers['X-Ezy-Signature-V2']).toBe(await signBodyV2('s3cret', '1700000123', body));
    expect(await verifySignatureV2('s3cret', body, headers['X-Ezy-Timestamp'], headers['X-Ezy-Signature-V2'], {nowSec: 1_700_000_130})).toBe(true);
    expect(headers['X-Ezy-Delivery']).toBe(id);
  });

  it('stamps every attempt fresh: a retry has a new timestamp and V2 signature, the same delivery id and V1 signature', async () => {
    const calls: Record<string, string>[] = [];
    const fetch = vi.fn(async (_u: string, init: RequestInit) => (calls.push(init.headers as Record<string, string>), new Response(null, {status: 200})));
    const {id, body} = envelope('rsvp.created', {a: 1});
    await attemptDelivery(ENDPOINT, 'rsvp.created', id, body, {fetch, nowMs: () => 1_000_000_000_000});
    await attemptDelivery(ENDPOINT, 'rsvp.created', id, body, {fetch, nowMs: () => 1_000_000_600_000});
    expect(calls[0]['X-Ezy-Delivery']).toBe(calls[1]['X-Ezy-Delivery']);
    expect(calls[0]['X-Ezy-Signature']).toBe(calls[1]['X-Ezy-Signature']);
    expect(calls[0]['X-Ezy-Timestamp']).not.toBe(calls[1]['X-Ezy-Timestamp']);
    expect(calls[0]['X-Ezy-Signature-V2']).not.toBe(calls[1]['X-Ezy-Signature-V2']);
  });

  it('uses the current clock by default', async () => {
    const fetch = vi.fn(async () => new Response(null, {status: 200}));
    await attemptDelivery(ENDPOINT, 'e', 'd', '{}', {fetch});
    const ts = Number(((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)['X-Ezy-Timestamp']);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5);
  });
});
