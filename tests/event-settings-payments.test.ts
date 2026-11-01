import {describe, expect, it} from 'vitest';

import type {Catalogue} from '../src/platform/payments';
import {shapePaymentsStatus} from '../src/server/payments-status';
import {ticketPriceKey} from '../src/server/ticket-checkout';

const t = (n: number, priceCents: number, currency = 'USD') => ({
  id: `0190aaaa-bbbb-7ccc-8ddd-${String(n).padStart(12, '0')}`,
  name: `Ticket ${n}`,
  priceCents,
  currency,
  eventId: 'e1',
  eventTitle: 'Launch',
});
const price = (ticket: ReturnType<typeof t>, amountCents = ticket.priceCents) => ({
  key: ticketPriceKey(ticket), name: 'x', description: null, amountCents, currency: ticket.currency, interval: 'one_time' as const, intervalCount: 1, trialDays: 0,
});
const catalogue = (prices: Catalogue['prices'], mode: Catalogue['mode'] = 'test'): Catalogue => ({mode, ready: true, prices});

describe('shapePaymentsStatus', () => {
  it('marks listed, missing and mismatched prices and counts the problems', () => {
    const a = t(1, 1500), b = t(2, 2500), c = t(3, 900);
    const dto = shapePaymentsStatus([a, b, c], catalogue([price(a), price(c, 800)]));
    expect(dto.paidTicketTypes.map(r => r.priceStatus)).toEqual(['listed', 'missing', 'mismatch']);
    expect(dto).toMatchObject({mode: 'test', ready: true, paidCount: 3, missingCount: 2, catalogueReachable: true});
  });
  it('ignores free tickets', () => {
    const dto = shapePaymentsStatus([t(1, 0), t(2, 500)], catalogue([]));
    expect(dto.paidCount).toBe(1);
    expect(dto.missingCount).toBe(1);
  });
  it('reports unknown when the catalogue is unreachable, without counting it as missing', () => {
    const dto = shapePaymentsStatus([t(1, 500)], null);
    expect(dto).toMatchObject({mode: null, ready: false, catalogueReachable: false, missingCount: 0});
    expect(dto.paidTicketTypes[0]!.priceStatus).toBe('unknown');
  });
  it('carries the live mode', () => {
    expect(shapePaymentsStatus([], catalogue([], 'live')).mode).toBe('live');
  });
});
