import {describe, expect, it, vi} from 'vitest';

vi.mock('../src/platform/config', () => ({config: {jwtSecret: 'test-secret-test-secret', siteUrl: 'https://x.example'}}));

import {pollGuestToken, pollLinkFor, verifyPollGuestToken} from '../src/domain/tokens';
import {hashToken} from '../src/domain/secureToken';
import {guestRsvpId} from '../src/server/routes/polls-public';

const S = 'test-secret-test-secret';
const dbWith = (rows: Array<{id: string; eventId: string; manageToken?: string}>) =>
  ({rsvp: {findFirst: vi.fn(async ({where}: any) => rows.find(r => (where.id ? r.id === where.id : r.manageToken === where.manageToken) && r.eventId === where.eventId) ?? null)}}) as any;

describe('signed poll guest token', () => {
  it('round-trips and rejects tampering, wrong secret, expiry', () => {
    const t = pollGuestToken('r1', 'e1', S);
    expect(t.startsWith('pg_')).toBe(true);
    expect(verifyPollGuestToken(t, S)).toEqual({rsvpId: 'r1', eventId: 'e1'});
    expect(verifyPollGuestToken(t, 'other-secret')).toBeNull();
    expect(verifyPollGuestToken(t.slice(0, -2) + 'xx', S)).toBeNull();
    expect(verifyPollGuestToken(t, S, new Date(Date.now() + 200 * 86400_000))).toBeNull();
    expect(verifyPollGuestToken('nope', S)).toBeNull();
  });
  it('pollLinkFor ends with a slash and keeps the query', () => {
    expect(pollLinkFor('https://x.example/', 'ABC234', 'r1', 'e1', null)).toBe('https://x.example/p/ABC234/');
    const u = new URL(pollLinkFor('https://x.example', 'ABC234', 'r1', 'e1', S));
    expect(u.pathname).toBe('/p/ABC234/');
    expect(verifyPollGuestToken(u.searchParams.get('g')!, S)).toEqual({rsvpId: 'r1', eventId: 'e1'});
  });
});

describe('guestRsvpId', () => {
  const db = dbWith([{id: 'r1', eventId: 'e1', manageToken: hashToken('raw')}]);
  it('accepts a raw manage token and a signed token for the same event', async () => {
    expect(await guestRsvpId(db, 'e1', 'raw')).toBe('r1');
    expect(await guestRsvpId(db, 'e1', pollGuestToken('r1', 'e1', S))).toBe('r1');
  });
  it('ignores signed tokens for another event, forged, or unknown rsvps', async () => {
    expect(await guestRsvpId(db, 'e2', pollGuestToken('r1', 'e1', S))).toBeNull();
    expect(await guestRsvpId(db, 'e1', pollGuestToken('r1', 'e1', 'bad-secret-bad-secret'))).toBeNull();
    expect(await guestRsvpId(db, 'e1', pollGuestToken('r9', 'e1', S))).toBeNull();
    expect(await guestRsvpId(db, 'e1', 'pg_' + 'a'.repeat(500))).toBeNull();
  });
});
