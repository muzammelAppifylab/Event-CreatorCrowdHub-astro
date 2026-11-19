import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * docs/agent/orders-and-stock.md "Prove it": ten checkout starts for ONE booking at the same moment,
 * against the real Postgres, record exactly one order and all get the same checkout. The payment
 * platform is mocked the way it behaves: one checkout per idempotency key.
 */
const platform = vi.hoisted(() => ({byKey: new Map<string, string>(), creates: 0}));
vi.mock('../../src/platform/payments', async importOriginal => ({
  ...(await importOriginal<object>()),
  findPrice: vi.fn(async () => ({ok: true, data: {amountCents: 2500, currency: 'USD'}})),
  createPrice: vi.fn(),
  getCheckout: vi.fn(async () => ({
    ok: true,
    data: {status: 'open', embedded: {kind: 'window', gateway: 'x', checkoutUrl: 'https://pay.example.com/x', returnUrl: '/thanks/'}},
  })),
  createCheckout: vi.fn(async (_url: unknown, input: {idempotencyKey?: string}) => {
    platform.creates++;
    await new Promise(resolve => setTimeout(resolve, 5));
    const key = input.idempotencyKey ?? `none-${platform.creates}`;
    if (!platform.byKey.has(key)) platform.byKey.set(key, `pcs_race${String(platform.byKey.size + 1).padStart(6, '0')}`);
    return {ok: true, data: {id: platform.byKey.get(key)!, mode: 'test', embedded: null}};
  }),
}));

import {startTicketCheckout} from '../../src/server/ticket-checkout';
import {resetEvents} from './support/events-fixtures';
import {configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

describe.skipIf(!DATABASE_URL)('ticket checkout start under a race (real Postgres)', () => {
  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    platform.byKey.clear();
    platform.creates = 0;
  });

  it('ten starts at once for one booking record one order and one checkout', async () => {
    const start = new Date(Date.now() + 7 * 86_400_000);
    const event = await db.event.create({
      data: {
        slug: 'race-workshop', title: 'Race Workshop', startAt: start, endAt: new Date(start.getTime() + 3_600_000),
        timezone: 'UTC', format: 'online', status: 'published', pollJoinCode: 'RACE01', capacity: 10,
      },
    });
    const ticket = await db.ticketType.create({data: {eventId: event.id, name: 'General', priceCents: 2500, currency: 'USD'}});
    const rsvp = await db.rsvp.create({
      data: {
        eventId: event.id, ticketTypeId: ticket.id, name: 'Ada', email: 'ada@example.com', response: 'going',
        status: 'awaiting_payment', seats: 1, ticketCode: 'RACE0001', manageToken: 'race-manage-token-hash',
      },
    });

    const results = await Promise.all(
      Array.from({length: 10}, () => startTicketCheckout(db as never, rsvp.id, {requestUrl: 'https://site.example.com/'})),
    );

    expect(results.every(r => r.ok)).toBe(true);
    const ids = new Set(results.map(r => (r.ok ? r.checkoutId : null)));
    expect(ids.size).toBe(1);
    const orders = await db.ticketOrder.findMany({where: {rsvpId: rsvp.id}});
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({checkoutId: [...ids][0], status: 'pending', amountCents: 2500, seats: 1});
    expect(platform.byKey.size).toBe(1);
  });
});
