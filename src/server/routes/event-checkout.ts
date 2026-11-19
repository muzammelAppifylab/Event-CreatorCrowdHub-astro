import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {problem, withDb} from '../../platform/guards';
import {sha256Hex} from '../../platform/auth/encoding';
import {startTicketCheckout} from '../ticket-checkout';

/**
 * Pay for a ticket (docs/ARCHITECTURE.md).
 *
 *   POST /site-api/event-checkout   {token}   start or resume the platform checkout for the
 *                                             guest's awaiting_payment RSVP ("Finish booking")
 *
 * The caller proves it owns the RSVP with the raw manage token from its manage link (stored
 * hashed, 256 random bits). No amount, price or RSVP id comes from the browser: the amount is
 * the ticket type's price x the RSVP's seats, recomputed in `startTicketCheckout`. The answer is
 * the same shape as `/site-api/checkout`: `{id, redirectUrl, embedded}`; the page sends the buyer to
 * `redirectUrl` (`/checkout/?id=…`) where `EmbeddedCheckout` takes the payment. The thanks page
 * confirms the payment (`GET /site-api/checkout/:id` runs the paid hook).
 *
 * Never charged twice (docs/agent/orders-and-stock.md): every start sends the platform an
 * idempotency key made from the RSVP and the attempt (`ticketAttemptKey`), so a double click, a
 * retry or a second tab answer the SAME checkout. An attempt that was already paid answers
 * `{id, redirectUrl: '/thanks/?checkout=…', embedded: null, paid: true}` (nothing new charged);
 * the same attempt still starting answers 409 `checkout_in_progress` ("try again in a moment").
 * Mount in app.ts AFTER csrf: `.route('/event-checkout', eventCheckoutRoutes)`.
 */
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;
/** More checkouts than this for one RSVP within an hour is a loop or abuse, not a buyer. */
const MAX_STARTS_PER_HOUR = 6;

export const eventCheckoutRoutes = new Hono().post(
  '/',
  validator('json', (value, c) => {
    const token = typeof (value as {token?: unknown} | null)?.token === 'string' ? (value as {token: string}).token.trim() : '';
    if (!TOKEN.test(token)) return c.json({...problem('invalid_input', 'That booking link is not valid.'), fields: {token: 'That booking link is not valid.'}}, 422);
    return {token};
  }),
  withDb,
  async c => {
    const {token} = c.req.valid('json');
    const rsvp = await c.var.db.rsvp.findUnique({where: {manageToken: await sha256Hex(token)}, select: {id: true, status: true}});
    // The same answer for "no such booking" and "not yours": no oracle.
    if (!rsvp) return c.json(problem('not_found', 'No such booking.'), 404);

    const recent = await c.var.db.ticketOrder.findMany({
      where: {rsvpId: rsvp.id, createdAt: {gt: new Date(Date.now() - 3600_000)}},
      select: {id: true},
      take: MAX_STARTS_PER_HOUR + 1,
    });
    if (recent.length > MAX_STARTS_PER_HOUR) return c.json(problem('rate_limited', 'Too many attempts. Try again in an hour.'), 429);

    const started = await startTicketCheckout(c.var.db, rsvp.id, {requestUrl: c.req.url});
    c.header('Cache-Control', 'private, no-store');
    if (!started.ok) return c.json(problem(started.code, started.message), started.status);
    return c.json({id: started.checkoutId, redirectUrl: started.redirectUrl, embedded: started.embedded, ...(started.paid ? {paid: true} : {})});
  },
);
