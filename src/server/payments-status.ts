import type {Catalogue, PaymentMode} from '../platform/payments';
import {ticketPriceKey} from './ticket-checkout';

/**
 * Pure shaping for `GET /site-api/event-settings/payments`: what the site can know about its
 * built-in checkout. No keys, no secrets: the platform holds the gateway (docs/agent/payments.md).
 *
 * `listed`   the catalogue has this ticket's price (a guest can pay).
 * `missing`  no catalogue price yet. Prices are created when the first guest starts checkout from
 *            the Preview/editor; the live site cannot create them (E_PAYMENTS_EDITOR_ONLY), so a
 *            guest sees `ticket_price_missing` ("tickets are not on sale yet").
 * `mismatch` the key exists with another amount; checkout refuses rather than mis-charge.
 * `unknown`  the catalogue could not be read.
 */
export type PriceStatus = 'listed' | 'missing' | 'mismatch' | 'unknown';

export interface PaidTicketRow {
  id: string;
  eventId: string;
  eventTitle: string;
  name: string;
  priceCents: number;
  currency: string;
  priceStatus: PriceStatus;
}

export interface PaymentsStatusDto {
  /** `null` when the platform could not be reached. */
  mode: PaymentMode | null;
  ready: boolean;
  catalogueReachable: boolean;
  paidTicketTypes: PaidTicketRow[];
  paidCount: number;
  missingCount: number;
  checkedAt: string;
}

export interface PaidTicketInput {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  eventId: string;
  eventTitle: string;
}

export function shapePaymentsStatus(tickets: PaidTicketInput[], catalogue: Catalogue | null, now: Date = new Date()): PaymentsStatusDto {
  const byKey = new Map((catalogue?.prices ?? []).map(p => [p.key, p]));
  const rows = tickets
    .filter(t => t.priceCents > 0)
    .map<PaidTicketRow>(t => {
      let priceStatus: PriceStatus = 'unknown';
      if (catalogue) {
        const found = byKey.get(ticketPriceKey(t));
        priceStatus = !found ? 'missing' : found.amountCents === t.priceCents && found.currency.toUpperCase() === t.currency.toUpperCase() ? 'listed' : 'mismatch';
      }
      return {id: t.id, eventId: t.eventId, eventTitle: t.eventTitle, name: t.name, priceCents: t.priceCents, currency: t.currency.toUpperCase(), priceStatus};
    });
  return {
    mode: catalogue?.mode ?? null,
    ready: catalogue?.ready ?? false,
    catalogueReachable: catalogue !== null,
    paidTicketTypes: rows,
    paidCount: rows.length,
    missingCount: rows.filter(r => r.priceStatus === 'missing' || r.priceStatus === 'mismatch').length,
    checkedAt: now.toISOString(),
  };
}
