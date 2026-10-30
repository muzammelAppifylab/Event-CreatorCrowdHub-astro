import {describe, expect, it} from 'vitest';

import {DOOR_LIST_LIMIT, normalizeTicketCode, toDoorGuest} from '../src/server/routes/admin-checkin';

describe('door check-in', () => {
  it('normalises typed and scanned codes', () => {
    expect(normalizeTicketCode('  k7m2qx9a\n')).toBe('K7M2QX9A');
  });
  it('shows door staff names, codes, seats, status and time only: never an email or id', () => {
    const guest = toDoorGuest({name: 'Gina', ticketCode: 'ABCD2345', seats: 2, status: 'confirmed', checkedInAt: new Date('2026-10-30T18:02:00Z')});
    expect(guest).toEqual({name: 'Gina', ticketCode: 'ABCD2345', seats: 2, status: 'confirmed', checkedInAt: '2026-10-30T18:02:00.000Z'});
    expect(Object.keys(toDoorGuest({...guest, checkedInAt: null}))).not.toContain('email');
    expect(toDoorGuest({...guest, checkedInAt: null}).checkedInAt).toBeNull();
  });
  it('caps the door list', () => expect(DOOR_LIST_LIMIT).toBe(200));
});
