import {beforeEach, describe, expect, it, vi} from 'vitest';

const privacy = vi.hoisted(() => ({
  expiredGuestIds: vi.fn(async () => [] as string[]),
  eraseRsvp: vi.fn(async () => 'erased'),
  restoredErasedIds: vi.fn(async () => [] as string[]),
  deleteExpiredInvites: vi.fn(async () => 0),
  prunePrivacyAttempts: vi.fn(async () => 0),
}));
vi.mock('../src/server/privacy', () => privacy);

import {runRetention} from '../src/server/jobs/retention';

const NOW = new Date('2026-11-12T12:00:00Z');

beforeEach(() => {
  for (const fn of Object.values(privacy)) fn.mockClear();
});

describe('runRetention: promote only for re-applied (restored) erasures (audit M-27)', () => {
  it('a restored RSVP is erased with promote: true; an expired one with promote: false; neither logs', async () => {
    privacy.restoredErasedIds.mockResolvedValueOnce(['restored-1']);
    privacy.expiredGuestIds.mockResolvedValueOnce(['expired-1']);
    const r = await runRetention({} as never, NOW);
    expect(r).toMatchObject({reapplied: 1, erased: 1, skipped: 0});
    expect(privacy.eraseRsvp).toHaveBeenCalledWith({}, 'restored-1', {now: NOW, promote: true, log: false});
    expect(privacy.eraseRsvp).toHaveBeenCalledWith({}, 'expired-1', {now: NOW, promote: false, log: false});
  });
});
