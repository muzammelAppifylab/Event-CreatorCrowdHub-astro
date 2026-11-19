import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({db: {} as Record<string, any>}));

vi.mock('../src/platform/guards', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/guards')>('../src/platform/guards');
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    ...actual,
    withViewer: async (c: any, next: () => Promise<void>) => { c.set('viewer', {state: 'user', id: 7}); await next(); },
    requireAuth: pass,
    requirePermission: () => pass,
    withDb: async (c: any, next: () => Promise<void>) => { c.set('db', state.db); await next(); },
  };
});
vi.mock('../src/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/auth')>('../src/platform/auth');
  return {...actual, audit: vi.fn(async () => undefined)};
});

import {audit} from '../src/platform/auth';
import {adminGuestRoutes, EXPORT_MAX_ROWS, EXPORT_PAGE} from '../src/server/routes/admin-guests';

const app = new Hono().route('/a', adminGuestRoutes);
const EV = '0192f0a1-0000-7000-8000-000000000001';
const when = new Date('2026-10-30T10:00:00Z');

const rsvp = (n: number) => ({
  id: `0192f0a1-0000-7000-8000-${String(n).padStart(12, '0')}`,
  name: `Guest ${n}`, email: `g${n}@x.test`, response: 'going', status: 'confirmed', plusOnes: 0, seats: 1,
  ticketCode: null, ticketTypeId: null, marketingConsent: false, consentConfirmedAt: null, checkedInAt: null,
  attended: null, waitlistPosition: null, source: 'direct', createdAt: when, confirmedAt: when, claimExpiresAt: null,
  updatedAt: when, rsvpAnswers: [], ticketOrders: [],
});

/** The keyset cursor id of a page query (`keysetAfter('createdAt', 'desc', …)` inside `AND`), or undefined on page 1. */
const keysetId = (args: any): string | undefined => args.where?.AND?.[1]?.OR?.[1]?.id?.lt;

/**
 * A guest list `total` long, all sharing one createdAt (every page edge is a tie), ordered
 * createdAt desc, id desc and paged by value (`keysetAfter`) as the database would.
 */
function guests(total: number) {
  const all = Array.from({length: total}, (_, i) => rsvp(i)).sort((a, b) => (a.id < b.id ? 1 : -1));
  return vi.fn(async (args: any) => {
    const after = keysetId(args);
    const rest = after ? all.filter(r => r.id < after) : all;
    return rest.slice(0, args.take);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = {
    event: {findFirst: vi.fn(async () => ({id: EV, slug: 'party', title: 'Party'}))},
    rsvpQuestion: {findMany: vi.fn(async () => [])},
    ticketType: {findMany: vi.fn(async () => [])},
    rsvp: {findMany: guests(3)},
    $queryRaw: vi.fn(async () => []),
  };
});

describe('guest CSV export', () => {
  it('reads every page before it answers, keyset by value, and audits the rows written', async () => {
    state.db.rsvp.findMany = guests(EXPORT_PAGE + 5);
    const res = await app.request(`/a/events/${EV}/guests/export.csv`);
    // All reads are done before the response exists: none happens while the body is read.
    const reads = state.db.rsvp.findMany.mock.calls.length;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-export-truncated')).toBe('0');
    expect(res.headers.get('content-disposition')).toContain('guests-party-');
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines).toHaveLength(EXPORT_PAGE + 5 + 1);
    expect(new Set(lines).size).toBe(lines.length);
    expect(state.db.rsvp.findMany).toHaveBeenCalledTimes(reads);
    expect(reads).toBe(2);
    // Page 2 starts after page 1's last guest by value (createdAt, id): newest first, so the 1,000th highest id.
    const lastOfPage1 = rsvp(EXPORT_PAGE + 5 - EXPORT_PAGE).id;
    expect(keysetId(state.db.rsvp.findMany.mock.calls[1][0])).toBe(lastOfPage1);
    expect(state.db.rsvp.findMany.mock.calls[1][0].cursor).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({action: 'guests_exported', meta: {rows: EXPORT_PAGE + 5, truncated: false}}));
  });

  it('cuts at EXPORT_MAX_ROWS and says so', async () => {
    state.db.rsvp.findMany = guests(EXPORT_MAX_ROWS + 50);
    const res = await app.request(`/a/events/${EV}/guests/export.csv`);
    expect(res.headers.get('x-export-truncated')).toBe('1');
    expect((await res.text()).trim().split('\r\n')).toHaveLength(EXPORT_MAX_ROWS + 1);
    const takes = state.db.rsvp.findMany.mock.calls.map((c: any[]) => c[0].take as number);
    expect(takes.reduce((a: number, b: number) => a + b, 0)).toBe(EXPORT_MAX_ROWS + 1);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({meta: {rows: EXPORT_MAX_ROWS, truncated: true}}));
  });

  it('a failed read is an error answer with no audit row, never a cut file', async () => {
    state.db.rsvp.findMany = vi.fn(async () => { throw new Error('db down'); });
    const res = await app.request(`/a/events/${EV}/guests/export.csv`);
    expect(res.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });

  it('404 for an unknown event, nothing read', async () => {
    state.db.event.findFirst.mockResolvedValue(null);
    expect((await app.request(`/a/events/${EV}/guests/export.csv`)).status).toBe(404);
    expect(state.db.rsvp.findMany).not.toHaveBeenCalled();
  });
});

describe('contacts CSV export', () => {
  const contact = (n: number) => ({
    email: `c${String(n).padStart(6, '0')}@x.test`, name: `C ${n}`, event_count: 1, last_event_id: EV, last_event_title: 'Party',
    last_event_start_at: when, marketing_consent: true, attended_count: 0, first_seen_at: when,
  });

  it('pages by address before it answers, cuts at the cap, and audits', async () => {
    let served = 0;
    // `$queryRaw` is a tagged template: the values are LIMIT and the keyset address among others.
    state.db.$queryRaw = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const limit = values.find(v => typeof v === 'number') as number;
      return Array.from({length: limit}, () => contact(served++));
    });
    const res = await app.request('/a/contacts/export.csv');
    expect(served).toBe(EXPORT_MAX_ROWS + 1);
    expect(res.headers.get('x-export-truncated')).toBe('1');
    expect((await res.text()).trim().split('\r\n')).toHaveLength(EXPORT_MAX_ROWS + 1);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({action: 'contacts_exported', meta: {rows: EXPORT_MAX_ROWS, truncated: true}}));
  });
});
