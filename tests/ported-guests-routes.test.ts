import {describe, expect, it} from 'vitest';

import {
  adminGuestRoutes,
  BULK_MAX,
  checkGuestPatch,
  CONTACTS_PAGE_SIZE,
  EXPORT_MAX_ROWS,
  guestWhere,
  GUESTS_PAGE_SIZE,
  likePattern,
  parseCursor,
  parseGuestFilter,
} from '../src/server/routes/admin-guests';

const UUID = '3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b';
const EVENT = '4f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b';

describe('ported guests routes (no database)', () => {
  it('keeps the source limits', () => {
    expect([GUESTS_PAGE_SIZE, CONTACTS_PAGE_SIZE, BULK_MAX, EXPORT_MAX_ROWS]).toEqual([50, 50, 100, 20_000]);
  });

  it('filters: blanks are no filter, unknown values rejected, ticket code searched uppercased', () => {
    expect(parseGuestFilter({status: ' ', response: '', checkedIn: ''})).toEqual({filter: {}});
    expect('error' in parseGuestFilter({status: 'bogus'})).toBe(true);
    expect('error' in parseGuestFilter({response: 'yes'})).toBe(true);
    expect('error' in parseGuestFilter({ticketTypeId: 'nope'})).toBe(true);
    expect('error' in parseGuestFilter({checkedIn: 'maybe'})).toBe(true);
    const parsed = parseGuestFilter({status: 'waitlisted', checkedIn: 'no', q: 'abc', ticketTypeId: UUID});
    expect(parsed).toEqual({filter: {status: 'waitlisted', checkedIn: false, q: 'abc', ticketTypeId: UUID}});
    const where = guestWhere(EVENT, (parsed as {filter: never}).filter);
    expect(where).toMatchObject({eventId: EVENT, status: 'waitlisted', checkedInAt: null, ticketTypeId: UUID});
    expect(JSON.stringify(where.OR)).toContain('ABC');
  });

  it('cursor and LIKE escaping', () => {
    const iso = '2026-10-10T09:00:00.000Z';
    expect(parseCursor(`${iso}_${UUID}`)).toEqual({at: new Date(iso), id: UUID});
    expect(parseCursor('')).toBeNull();
    expect(parseCursor(`${iso}_nope`)).toBeNull();
    expect(parseCursor(`junk_${UUID}`)).toBeNull();
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('patch validation', () => {
    expect('fields' in checkGuestPatch({})).toBe(true);
    expect('fields' in checkGuestPatch({plusOnes: 11})).toBe(true);
    expect('fields' in checkGuestPatch({plusOnes: 1.5})).toBe(true);
    expect('fields' in checkGuestPatch({marketingConsent: 'yes'})).toBe(true);
    expect('fields' in checkGuestPatch({attended: 'x'})).toBe(true);
    expect(checkGuestPatch({name: '  A   B ', email: ' X@Y.com ', attended: null, checkedIn: true})).toEqual({
      patch: {name: 'A B', email: 'x@y.com', attended: null, checkedIn: true},
    });
  });

  it('registers every guest and contact path', () => {
    const paths = adminGuestRoutes.routes.map(r => `${r.method} ${r.path}`);
    for (const p of [
      'GET /events/:eventId/guests',
      'GET /events/:eventId/guests/export.csv',
      'POST /events/:eventId/guests/bulk',
      'GET /events/:eventId/guests/:rsvpId',
      'GET /events/:eventId/guests/:rsvpId/data',
      'PATCH /events/:eventId/guests/:rsvpId',
      'DELETE /events/:eventId/guests/:rsvpId',
      'GET /contacts',
      'GET /contacts/export.csv',
    ]) {
      expect(paths).toContain(p);
    }
  });
});
