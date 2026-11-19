import {Hono} from 'hono';

import type {PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {PERMISSIONS} from '../permissions';
import {refundedTicket} from '../ticket-checkout';
import {keysetAfter} from '../../lib/text';
import {isUuid, parsePageCursor} from '../validate';

/**
 * Refunds to finish (ported from CreatorCrowdHub `FailedRefunds`). Holders of `site:event:manage`.
 * Mounted at `/site-api/refunds`:
 *
 *   GET  /refunds?eventId&before        paid orders waiting for a refund (keyset, 50 a page, newest first)
 *   GET  /refunds/count?eventId         how many, capped: {count, more} ("25+"; for badges and cards)
 *   POST /refunds/:id/mark-refunded     the owner refunded it in the platform dashboard: close the order
 *
 * The platform has no refund API for site code (docs/agent/payments.md): the owner refunds in the
 * dashboard's Payments tab and the `payment.refunded` event closes the order by itself. This route
 * is the manual fallback when that event never came. The guest's email is never returned.
 */

export const REFUNDS_PAGE_SIZE = 50;
const MANAGE = PERMISSIONS.EVENT_MANAGE;

export type RefundRow = {id: string; guestName: string; eventId: string; eventTitle: string; amountCents: number; currency: string; since: string};

const orderSelect = {
  id: true,
  amountCents: true,
  currency: true,
  createdAt: true,
  rsvp: {select: {name: true, event: {select: {id: true, title: true}}}},
} as const;

type OrderRow = {
  id: string;
  amountCents: number;
  currency: string;
  createdAt: Date;
  rsvp: {name: string; event: {id: string; title: string}} | null;
};

export const toRefundRow = (o: OrderRow): RefundRow => ({
  id: o.id,
  guestName: o.rsvp?.name ?? 'Guest',
  eventId: o.rsvp?.event.id ?? '',
  eventTitle: o.rsvp?.event.title ?? 'Event',
  amountCents: o.amountCents,
  currency: o.currency,
  since: o.createdAt.toISOString(),
});

const baseWhere = (eventId?: string) => ({status: 'refund_due', ...(eventId ? {rsvp: {eventId}} : {})});

/** One keyset page, newest first. `nextBefore` is null on the last page. */
export async function listRefundDue(db: PrismaClient, opts: {eventId?: string; before?: unknown} = {}): Promise<{items: RefundRow[]; nextBefore: string | null}> {
  const cursor = parsePageCursor(opts.before);
  const where = baseWhere(opts.eventId);
  // Millisecond cursor vs microsecond column: `keysetAfter` (text.ts) compares at the cursor's precision.
  const paged = cursor ? {AND: [where, keysetAfter('createdAt', 'desc', cursor)]} : where;
  const rows = (await db.ticketOrder.findMany({
    where: paged,
    select: orderSelect,
    orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
    take: REFUNDS_PAGE_SIZE + 1,
  })) as OrderRow[];
  const page = rows.slice(0, REFUNDS_PAGE_SIZE);
  const last = page[page.length - 1];
  return {items: page.map(toRefundRow), nextBefore: rows.length > REFUNDS_PAGE_SIZE && last ? `${last.createdAt.toISOString()}_${last.id}` : null};
}

export const REFUNDS_COUNT_CAP = 25;

/**
 * How many orders wait for a refund, capped: never a COUNT() per request (AGENTS.md). Reads at most
 * `REFUNDS_COUNT_CAP + 1` ids; `more` is true when there are over `REFUNDS_COUNT_CAP` ("25+").
 */
export async function countRefundDue(db: PrismaClient, eventId?: string): Promise<{count: number; more: boolean}> {
  const rows = await db.ticketOrder.findMany({where: baseWhere(eventId), select: {id: true}, take: REFUNDS_COUNT_CAP + 1});
  return {count: Math.min(rows.length, REFUNDS_COUNT_CAP), more: rows.length > REFUNDS_COUNT_CAP};
}

/**
 * Close one order the owner refunded. Idempotent: an order already `refunded` answers `already`.
 * Uses `refundedTicket` so the seat is freed and the waitlist promoted exactly as the event would.
 */
export async function markRefunded(db: PrismaClient, id: string): Promise<'done' | 'already' | 'not_found' | 'not_due'> {
  if (!isUuid(id)) return 'not_found';
  const order = await db.ticketOrder.findUnique({where: {id}, select: {id: true, status: true, checkoutId: true, amountCents: true, currency: true}});
  if (!order) return 'not_found';
  if (order.status === 'refunded') return 'already';
  if (order.status !== 'refund_due') return 'not_due';
  const result = await refundedTicket(db, {checkoutId: order.checkoutId, amountCents: order.amountCents, currency: order.currency, full: true, refundedAt: new Date().toISOString()});
  if (result.closed) return 'done';
  // Lost a race with the platform's own `payment.refunded`: fine, it is closed.
  const fresh = await db.ticketOrder.findUnique({where: {id}, select: {status: true}});
  return fresh?.status === 'refunded' ? 'already' : 'not_due';
}

const eventFilter = (value: string | undefined) => (value && isUuid(value) ? value : undefined);

export const adminRefundRoutes = new Hono()
  // Registered before `/:id/...` routes; `/count` is its own path.
  .get('/count', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(await countRefundDue(c.var.db, eventFilter(c.req.query('eventId'))));
  })

  .get('/', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(await listRefundDue(c.var.db, {eventId: eventFilter(c.req.query('eventId')), before: c.req.query('before')}));
  })

  .post('/:id/mark-refunded', withViewer, requireAuth, requirePermission(MANAGE), withDb, async c => {
    const id = c.req.param('id');
    const outcome = await markRefunded(c.var.db, id);
    if (outcome === 'not_found') return c.json(problem('not_found', 'No such order.'), 404);
    if (outcome === 'not_due') return c.json(problem('not_refund_due', 'This order is not waiting for a refund.'), 409);
    if (outcome === 'done') await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'order_marked_refunded', target: ['ticket_order', id]});
    return c.json({ok: true, already: outcome === 'already'});
  });
