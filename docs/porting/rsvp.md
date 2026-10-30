# RSVP (public guest flows)

## Mount in `src/server/app.ts` (not done by this slice)

```ts
import {rsvpRoutes} from './routes/rsvp';
// …in the chain, after `.use(csrf)` / bodyLimit, next to `.route('/jobs', jobRoutes)`:
.route('/rsvp', rsvpRoutes)
```

Until it is mounted the event page simply shows no RSVP form (the pages read `/site-api/rsvp/*` in-process
and tolerate a 404).

## Routes (`/site-api/rsvp`)
| Route | What |
| --- | --- |
| `GET /events/:slug?invite=` | form rules, tickets, seats left (private events need a live invite) |
| `POST /events/:slug` | submit; free tickets confirm / waitlist / pend; repeat email -> 202 `check_email` (never overwrites) |
| `POST /events/:slug/manage-link` | "lost my link", always 202 |
| `GET /invite/:token` | invite landing data |
| `GET/PATCH /manage/:token`, `POST /manage/:token/cancel`, `GET /manage/:token/calendar.ics` | the guest's RSVP |

Pages: `/events/<slug>` (form), `/i/<token>` (invite), `/r/<token>` (confirmation + manage + ticket QR).
Manage tokens are stored as sha256 only; changes stop 90 days after the event, views/.ics after 180.

## Paid-ticket hook (payments agent)
In `src/server/routes/rsvp.ts`:
- `setPaidCheckoutHook(fn)`: register at module load. `fn({origin, event, rsvp, ticket, manageToken})` returns
  `{checkoutUrl}` or `null`. The seat is held as `awaiting_payment` while it runs; `null` releases it (409).
  With no hook, paid tickets answer 409 `payments_unavailable` and hold nothing.
- `confirmRsvpPayment(db, rsvpId, origin, manageToken?)`: payment landed -> `confirmed` (idempotent, emails the
  confirmation, returns `{seated}`; `false` = refund).
- `releaseRsvpHold(db, rsvpId, origin)`: checkout expired -> `cancelled`, seats go to the waitlist.
- Paid waitlist: promotion only sets `claim_expires_at` (offer); the claim email and claim checkout are the payments agent's.

## Email
`src/server/mailer.ts` `sendEventEmail({to, content, fromName, replyTo})`. The platform relay only carries account
emails, so this uses Resend when the owner adds secrets `RESEND_API_KEY` and `EVENT_EMAIL_FROM`; otherwise it logs
subject + recipient domain only (never links). Manage links are only rotated (repeat RSVP, "lost link") when a
provider is configured.

## Deferred
Host page (no workspace concept here), marketing-consent confirmation link, paid claim email/checkout, DB-backed
rate limits (in-memory per isolate, like the source), integration tests (local dev DB was unreachable).
