import {describe, expect, it} from 'vitest';

import {attendeeFrom, MAX_PUBLIC_ATTENDEES, shapeAttendees} from '../src/lib/guest-list';

describe('guest list shaping', () => {
  it('keeps the first name only, with initials', () => {
    expect(attendeeFrom('  sam  lee ')).toEqual({name: 'sam', initials: 'SL'});
    expect(attendeeFrom('Prince')).toEqual({name: 'Prince', initials: 'P'});
  });
  it('drops empty names and email-like values', () => {
    expect(attendeeFrom('   ')).toBeNull();
    expect(attendeeFrom('a@b.co')).toBeNull();
  });
  it('is bounded', () => {
    const names = Array.from({length: 40}, (_, i) => `Guest${i} Last`);
    expect(shapeAttendees(names)).toHaveLength(MAX_PUBLIC_ATTENDEES);
    expect(shapeAttendees(names, 3).map(a => a.name)).toEqual(['Guest0', 'Guest1', 'Guest2']);
  });
  it('never exposes the surname', () => {
    expect(JSON.stringify(shapeAttendees(['Ada Lovelace']))).not.toContain('Lovelace');
  });
});
