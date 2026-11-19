import {beforeEach, describe, expect, it, vi} from 'vitest';

const sendEventEmail = vi.fn(async (_email: unknown) => true);
vi.mock('../src/server/mailer', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/server/mailer')>()),
  sendEventEmail: (email: unknown) => sendEventEmail(email),
}));
vi.mock('../src/platform/config', async importOriginal => {
  const real = await importOriginal<typeof import('../src/platform/config')>();
  return {...real, config: new Proxy(real.config, {get: (t, k) => (k === 'jwtSecret' ? 'test-secret-for-consent-links-0123456789' : Reflect.get(t, k))})};
});
vi.mock('../src/server/jobs/shared', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/server/jobs/shared')>()),
  loadGuestMail: async () => ({
    to: 'guest@example.com',
    replyTo: undefined,
    eventStatus: 'published',
    data: {brand: {senderName: 'Events'}, guest: {consentUrl: null}},
  }),
}));
vi.mock('../src/emails', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/emails')>()),
  consentEmail: () => ({subject: 's', html: 'h', text: 't'}),
}));

import {consentEmailKey, sendConsentEmail} from '../src/server/consent-mail';
import {guestEmailKey, inviteStatusAfterDiscard} from '../src/server/routes/rsvp';

const RSVP = '11111111-1111-4111-8111-111111111111';

describe('inviteStatusAfterDiscard (audit M-1 leftover)', () => {
  it('puts back the status the invite had before the RSVP', () => {
    expect(inviteStatusAfterDiscard('sent', null)).toBe('sent');
    expect(inviteStatusAfterDiscard('queued', new Date())).toBe('queued');
    expect(inviteStatusAfterDiscard('bounced', new Date())).toBe('bounced');
  });
  it('falls back to sent / queued from sentAt, never responded', () => {
    expect(inviteStatusAfterDiscard(null, new Date())).toBe('sent');
    expect(inviteStatusAfterDiscard(undefined, null)).toBe('queued');
    expect(inviteStatusAfterDiscard('responded', new Date())).toBe('sent');
    expect(inviteStatusAfterDiscard('responded', null)).toBe('queued');
  });
});

describe('guestEmailKey', () => {
  it('is stable for the same email and changes with kind, status or link', () => {
    const a = guestEmailKey('confirmation', RSVP, 'confirmed', 'tok-a');
    expect(guestEmailKey('confirmation', RSVP, 'confirmed', 'tok-a')).toBe(a);
    expect(guestEmailKey('manage-link', RSVP, 'confirmed', 'tok-a')).not.toBe(a);
    expect(guestEmailKey('confirmation', RSVP, 'waitlisted', 'tok-a')).not.toBe(a);
    expect(guestEmailKey('confirmation', RSVP, 'confirmed', 'tok-b')).not.toBe(a);
  });
  it('never carries the raw token and fits the provider key charset', () => {
    const token = 'RawSecretManageToken_abcdefghijklmnopqrstuvwx';
    const key = guestEmailKey('confirmation', RSVP, 'confirmed', token);
    expect(key).not.toContain(token);
    expect(key).toMatch(/^[A-Za-z0-9:_.-]{1,256}$/);
  });
});

describe('sendConsentEmail idempotency key', () => {
  beforeEach(() => sendEventEmail.mockClear());

  it('sends with a key per RSVP and its updatedAt', async () => {
    const updatedAt = new Date('2026-11-01T12:00:00Z');
    const db = {rsvp: {findUnique: async () => ({marketingConsent: true, consentConfirmedAt: null, updatedAt})}};
    expect(await sendConsentEmail(db as never, RSVP, {origin: 'https://site.test'})).toBe(true);
    expect(sendEventEmail).toHaveBeenCalledTimes(1);
    expect((sendEventEmail.mock.calls[0]![0] as {idempotencyKey?: string}).idempotencyKey).toBe(consentEmailKey(RSVP, updatedAt));
  });

  it('a new opt-in (new updatedAt) is a new key', () => {
    expect(consentEmailKey(RSVP, new Date(1))).not.toBe(consentEmailKey(RSVP, new Date(2)));
  });
});
