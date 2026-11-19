import {afterEach, describe, expect, it, vi} from 'vitest';

const secrets = vi.hoisted(() => ({values: {} as Record<string, string | null>}));
vi.mock('../src/platform/config', () => ({
  config: {ownerSecret: (name: string) => secrets.values[name] ?? null, production: false},
}));

import {deliverEventEmail, senderDisplayName} from '../src/server/mailer';
import {deliveryBackoffMinutes, MAX_DELIVERY_ATTEMPTS, retryableNow} from '../src/server/jobs/deliveries';
import {outboxBackoffMinutes} from '../src/server/jobs/outbox-drain';

const email = {
  to: 'guest@example.test',
  content: {subject: 'Ana Lima, your seat', html: '<p>x</p>', text: 'x'},
  fromName: 'Smith, Jones & "Co"',
  idempotencyKey: 'outbox-0f0e0d0c-0b0a-4908-8706-050403020100',
};

afterEach(() => {
  secrets.values = {};
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mailer (audit L-3, L-13, L-21)', () => {
  it('quotes the sender name so a comma cannot split the From header', () => {
    expect(senderDisplayName('Smith, Jones & Co')).toBe('"Smith, Jones & Co"');
    expect(senderDisplayName('A "quoted" \\ name')).toBe('"A \\"quoted\\" \\\\ name"');
    expect(senderDisplayName('Evil\r\nBcc: x@y.z <a>')).toBe('"EvilBcc: x@y.z a"');
    expect(senderDisplayName('  ')).toBe('');
    expect(senderDisplayName(null)).toBe('');
  });

  it('never logs the subject or the address when no provider is configured', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await deliverEventEmail(email)).toEqual({outcome: 'no_provider'});
    const out = info.mock.calls.map(c => String(c[0])).join('\n');
    expect(out).not.toContain('Ana');
    expect(out).not.toContain('example.test');
  });

  it('sends the Idempotency-Key and maps provider answers to outcomes', async () => {
    secrets.values = {RESEND_API_KEY: 're_test', EVENT_EMAIL_FROM: 'Studio <events@studio.test>'};
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const answers = [
      new Response('{}', {status: 200}),
      new Response('{}', {status: 409}),
      new Response('{}', {status: 429, headers: {'retry-after': '7'}}),
      new Response('{}', {status: 422}),
      new Response('{}', {status: 503}),
    ];
    const fetchMock = vi.fn(async () => answers.shift()!);
    vi.stubGlobal('fetch', fetchMock);

    expect(await deliverEventEmail(email)).toEqual({outcome: 'sent'});
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(email.idempotencyKey);
    expect(JSON.parse(String(init.body)).from).toBe('"Smith, Jones & \\"Co\\"" <events@studio.test>');

    expect(await deliverEventEmail(email)).toEqual({outcome: 'sent'}); // 409: an earlier try with this key went through
    expect(await deliverEventEmail(email)).toEqual({outcome: 'rate_limited', retryAfterSeconds: 7});
    expect(await deliverEventEmail(email)).toEqual({outcome: 'rejected'});
    expect(await deliverEventEmail(email)).toEqual({outcome: 'failed'});
  });
});

describe('retry schedules (audit M-19, H-3)', () => {
  it('backs reminder deliveries off and stops at the cap', () => {
    const now = new Date('2026-11-13T12:00:00Z');
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    expect([1, 2, 3, 4, 10].map(deliveryBackoffMinutes)).toEqual([1, 2, 4, 8, 60]);
    const row = (attempts: number, sentAt: Date) => ({status: 'failed', error: 'x', sentAt, attempts});
    expect(retryableNow(row(1, ago(2)), now)).toBe(true);
    expect(retryableNow(row(3, ago(2)), now)).toBe(false); // still waiting 4 minutes
    expect(retryableNow(row(3, ago(5)), now)).toBe(true);
    expect(retryableNow(row(MAX_DELIVERY_ATTEMPTS, ago(500)), now)).toBe(false); // gave up
    expect(retryableNow({status: 'failed', error: 'permanent: no', sentAt: ago(500), attempts: 1}, now)).toBe(false);
  });

  it('backs outbox rows off 2, 4, 8 … minutes, at most 4 hours', () => {
    expect([1, 2, 3, 7, 8, 20].map(outboxBackoffMinutes)).toEqual([2, 4, 8, 128, 240, 240]);
  });
});
