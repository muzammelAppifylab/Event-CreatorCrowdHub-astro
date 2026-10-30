# Ticket payments and scheduler: how they map onto the platform

## Paid tickets
Source Stripe code is NOT ported. A paid ticket uses the platform checkout (`payments.md`):

1. The public RSVP route creates the RSVP as `awaiting_payment` (seats held) and calls
   `startTicketCheckout(db, rsvpId, {requestUrl})` from `src/server/ticket-checkout.ts`. It returns
   `{ok, checkoutId, redirectUrl: '/checkout/?id=pcs_…', embedded}` or `{ok:false, status, code, message}`
   (answer the guest with `status` and `message`). The browser goes to `redirectUrl`; the existing
   `/checkout/` page takes the payment and `/thanks/` confirms.
2. A `ticket_orders` row (status `pending`, keyed by the platform `checkoutId`) is written.
3. `src/server/payments-hooks.ts` (`checkout.paid`, and the thanks page's confirm): `confirmPaidTicket`
   sets RSVP `confirmed`, order `paid`, queues the confirmation email. Idempotent.
   `checkout.failed` releases the hold. `payment.refunded` (full) closes the order, cancels the RSVP,
   promotes the waitlist.
4. Holds lapse after `appConfig.checkoutHoldMinutes` (sweep in the scheduler): RSVP `cancelled`, order
   `expired`, waitlist promoted, "hold expired" email. A payment that arrives after that re-seats the
   guest if seats are still free, otherwise the order becomes `refund_due`.

`refund_due` (also: amount mismatch, event cancelled, `markEventOrdersRefundDue(db, eventId)`) means the
owner refunds it in the dashboard's Payments tab. The platform has no refund API for site code, so this
is a documented manual step; `payment.refunded` then marks it `refunded`. The event-cancel route should
call `markEventOrdersRefundDue` and send `eventCancelledEmail(..., {refund: true})`.

### Dynamic per-ticket price: the limit and the approach
The catalogue is the only source of amounts (no per-checkout amount; prices are immutable; the live
site cannot create prices). Closest correct approach: ONE catalogue price per ticket type AND amount,
key `tkt-<24 hex of ticket type id>-<cents>-<currency>` (`ticketPriceKey`), `quantity` = seats. Changing
a ticket's price therefore means a new key, never a changed price.
- `startTicketCheckout` looks the key up, and creates it when missing. Creation only works in the editor
  or Preview (`E_PAYMENTS_EDITOR_ONLY` on the live site, surfaced as 503 `ticket_price_missing`; "prices
  reach the live account by themselves"). So: the host must create/edit tickets and try one checkout in
  the Preview, or run `npm run platform -- prices add --key <key> --name "…" --amount-cents N --currency USD --interval one_time`.
  Ticket creation in the admin UI should show the key (`ticketPriceKey`) for this.
- A catalogue amount that differs from the ticket type is refused (`ticket_price_mismatch`), never charged.
- Paid amount is re-verified in `confirmPaidTicket` against the order (price x seats).

## Scheduler (background jobs)
`background.json`: list `event-scheduler` (concurrency 1) with a `*/5 * * * *` UTC schedule, list
`rsvp-emails`. `src/server/background.ts` handlers:
- `event-scheduler` -> `runScheduler` (`src/server/jobs/run.ts`): reminders / we're live / thank-yous,
  lapsed waitlist claims (paid events), expired payment holds. Steps are independent and bounded.
- `rsvp-emails` -> `sendGuestEmail`: `confirmation`, `waitlist_offer`, `hold_expired`; queued by
  `queueGuestEmail(kind, rsvpId, stamp?)` (job `key` dedupes). Other routes may call it too.
Idempotence: `claimDelivery` inserts the `message_deliveries` row first (unique rsvp+rule); failed
non-permanent rows and 15-minute-stale claims are re-claimed; status changes are conditional.
Schedules do not tick locally: test with `sendJob(url, 'event-scheduler', {})`.

Mailer: code uses the real `sendEventEmail({to, content, fromName?, replyTo?}): Promise<boolean>` from
`src/server/mailer.ts`. Without `RESEND_API_KEY` it returns false, so reminders are recorded `failed`
and retried each tick while still due (no data loss, some log noise).
Manage links: tokens are stored hashed, so emails link to the event page `/e/<slug>/` (as the source).

## Paste-in for src/server/app.ts (after `csrf`, with the other routes)
```ts
import {eventCheckoutRoutes} from './routes/event-checkout';
// …
.route('/event-checkout', eventCheckoutRoutes)   // POST {token}: start/resume payment for a held RSVP
```
Public RSVP route usage:
```ts
import {startTicketCheckout} from '../ticket-checkout';
const pay = await startTicketCheckout(c.var.db, rsvp.id, {requestUrl: c.req.url});
if (!pay.ok) return c.json(problem(pay.code, pay.message), pay.status);
return c.json({status: 'awaiting_payment', redirectUrl: pay.redirectUrl});
```

## Notes / limits
- No schema change was needed. Suggested index (not required): `rsvps (status, claim_expires_at)` for the
  lapsed-claim scan, `ticket_orders (status, created_at)` for the hold sweep.
- Sweeps are bounded (200 holds, 50 events with lapsed claims, 500 reminder sends, 45 s per run); the rest is due next tick.
- Waitlist promotion for a FREE event on cancellation belongs to the RSVP/cancel code; it can reuse
  `promoteWaitlist(tx, eventId, now)` (src/server/jobs/waitlist.ts) under `lockEvent`.
- Type check was not run (`typescript` is not installed in this checkout); vitest runs pass.
- Tests: `tests/ticket-checkout.test.ts`, `tests/event-jobs.test.ts` (in-memory fake DB, `tests/ticket-fake-db.ts`).
