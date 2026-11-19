# Architecture

CreatorCrowdHub on the Astro app template: one Astro 7 project, one Cloudflare Worker, Hono as the
only backend (`src/server/app.ts`, mounted at `/site-api/*` by `src/pages/site-api/[...path].ts`),
Prisma 7 on the Site Database (Postgres). `src/platform/**` and `docs/agent/**` are managed: never edit.

## Roles and permissions

No workspaces, no teams: one site, one `event_settings` row (id 1). Catalogue in
`src/server/permissions.ts`:

| Codename | Key (ability) | Gives | Default roles |
| --- | --- | --- | --- |
| `site:event:manage` | `EVENT_MANAGE` (`manageEvents`) | events, guests, invites, messages, polls, settings, analytics | `admin` |
| `site:event:checkin` | `EVENT_CHECKIN` (`checkinGuests`) | door check-in only | `admin` |
| `site:event:integrations` | `EVENT_INTEGRATIONS` (`manageIntegrations`) | outbound webhooks (Integrations screen) | none: `owner` only (`*`) |

- `owner` is the platform's all-powerful role; `admin` gets the catalogue defaults; `checkin-staff` is a
  non-system role created by the migration `prisma/migrations/20261030100000_checkin_role` holding only
  `site:event:checkin` (owners assign it to users in the Roles / Users screens).
- Door routes accept EVENT_CHECKIN or EVENT_MANAGE (`doorAccess` in `routes/admin-checkin.ts`).
- Gate on codenames, never on role slugs. `/site-api/me` returns `abilities` for the UI.

## Site API route table (`src/server/app.ts`)

Order: `previewCookies`, `sameOrigin`, `/checkout` (own form CSRF), `csrf`, 64 KB body limit, permission sync.
Guest routes carry no session: access is by token in the path/body (or public).

| Mount | File | Access |
| --- | --- | --- |
| `/checkout`, `/memberships` | `routes/checkout.ts` | template payments (public / member) |
| `/health`, `/health/deep` (database check for uptime monitors: 200 or 503), `/me` | `app.ts` | public / viewer |
| `/auth`, `/admin` | `src/platform/auth/*` | managed auth; users, roles, audit (admin) |
| `/site` | `routes/site.ts` | public site brand |
| `/events` | `routes/events.ts` | PUBLIC: list, `/sitemap`, `/:slug` |
| `/admin-events` | `routes/admin-events.ts` | `EVENT_MANAGE`: event CRUD, publish/unpublish, cancel (+preview), duplicate, ticket types |
| `/event-admin` | `routes/admin-guests.ts` | `EVENT_MANAGE`: guests (list, CSV, bulk, edit, delete), contacts (+CSV) |
| `/event-admin` | `routes/admin-invites.ts` | `EVENT_MANAGE`: invites (create, resend, revoke), share kit |
| `/event-admin` | `routes/admin-messages.ts` | `EVENT_MANAGE`: reminder rules, preview, segments, log, broadcast |
| `/event-settings` | `routes/event-settings.ts` | `GET /brand` public; `GET` and `PATCH /` need `EVENT_MANAGE` |
| `/overview` | `routes/admin-overview.ts` | `EVENT_MANAGE` |
| `/checkin` | `routes/admin-checkin.ts` | events, event door list, code lookup/toggle: `EVENT_CHECKIN` or `EVENT_MANAGE`; attendees, attendance, attendance import: `EVENT_MANAGE` |
| `/analytics` | `routes/admin-analytics.ts` | `EVENT_MANAGE`: `GET /events/:eventId` |
| `/polls` | `routes/admin-polls.ts` | `EVENT_MANAGE`: CRUD, open/close, results, by-code |
| `/webhook-endpoints` | `routes/admin-webhooks.ts` | `EVENT_INTEGRATIONS` (owner only): CRUD, test |
| `/rsvp` | `routes/rsvp.ts` | guest: event + invite lookup, RSVP, manage link, `/manage/:token` (get/patch/cancel/calendar.ics) |
| `/event-checkout` | `routes/event-checkout.ts` | guest: POST `{token}` starts/resumes payment for a held RSVP |
| `/polls-public` | `routes/polls-public.ts` | guest: active poll, vote, results (by join code) |
| `/privacy` | `routes/privacy.ts` | guest, token: consent, unsubscribe, data view/export/erase |
| `/pageviews` | `routes/pageviews.ts` | public beacon `POST /:slug` |

## Portal (`/dashboard`, `src/portal/routes.tsx`)

`/` overview, `/account`, `/users`, `/roles`, `/activity`, `/events`, `/events/new`,
`/events/$id/edit`, `/events/$id` (hub; tabs guests, invites, messages, polls, analytics, check-in,
settings via `?tab=`; files in `src/portal/screens/`), `/contacts`, `/event-settings`, `/checkin`,
`/checkin/$eventId`, `/polls/$code/present`, `/integrations` (webhooks), `/components`.
`/portal/*` redirects to `/dashboard/*`.

## Public pages (`src/pages/`)

`/events/` and `/events/<slug>/` (SSR, JSON-LD, in the sitemap), `/r/<token>/` (manage an RSVP),
`/i/<token>/` (invite landing), `/p/<code>/` (live poll voting, SSR, noindex), `/host/`,
`/privacy/` and `/privacy/consent|unsubscribe|guest/<token>/`, `/checkout/` and `/thanks/` (platform
payments), plus template pages (`/`, `/about/`, `/blog/`, `/account/*`).

### Site Cache for the public event detail (audit M-29)

- `GET /site-api/events/:slug` reads PUBLIC events through the Site Cache (`cache.getOrSet`), key
  `event:slug:<slug>`, 1 day (`src/server/event-cache.ts`). Unlisted events are never cached (their slug is the secret link).
- Only the event's own columns are cached; seats left, the RSVP form and ticket prices come from other routes.
- Every event write in `admin-events.ts` calls `clearPublicEvents()` right after it succeeds, clearing the whole
  `event:slug:` prefix (a slug can change).
- The page HTML is the same for everyone (`public, max-age=60`); visitor parts and live seats load in the browser.
  Unlisted events are `private, no-store`.

## Data model (`prisma/schema.prisma`)

- Template: `users`, roles/permissions, tokens, sign-in/verification tables, `audit_events`,
  `login_attempts` (also the rate-limit store), `orders`, `memberships`, `jobs`, `job_deliveries`,
  `payment_events`.
- Events: `Event` (slug unique among non-deleted, soft delete, `pollJoinCode`), `TicketType`,
  `RsvpQuestion`, `Rsvp` (+ `RsvpAnswer`; email lower-cased; manage token stored hashed), `Invite`,
  `ReminderRule`, `Message` / `MessageDelivery`, `Poll` / `PollOption` / `PollVote`, `PageView`,
  `WebhookEndpoint`, `WebhookOutbox` (`webhook_outbox`: deliveries waiting for a retry), `GuestEmailOutbox`
  (`guest_email_outbox`: guest emails waiting to be sent), `EventSettings` (singleton, id 1), `TicketOrder` (platform `checkoutId`).
  Enums cover event format/status/visibility, RSVP status/response/source, invite status, poll
  status/type, question type, reminder kind, delivery status, segment, font preset.

## Payments

Source Stripe code is not ported. A paid RSVP is held `awaiting_payment`; `startTicketCheckout`
(`src/server/ticket-checkout.ts`) sends the guest to the platform checkout (`/checkout/?id=pcs_...`);
`src/server/payments-hooks.ts` confirms, releases or refunds. Amounts come only from the catalogue: one
price per ticket type AND amount, key `tkt-<24 hex>-<cents>-<currency>` (`ticketPriceKey`), creatable only in
the editor/Preview. `refund_due` orders are refunded manually in the dashboard's Payments tab. Holds last
`appConfig.checkoutHoldMinutes` (30, `src/config/app.config.ts`). Detail: `docs/porting/payments-jobs.md`.

## Background jobs (`background.json`, `src/server/background.ts`, `src/server/jobs/`)

- `event-scheduler`: cron `*/5 * * * *` UTC, concurrency 1; `runScheduler` does reminders, waitlist
  claims, expired payment holds, the guest email outbox and the webhook outbox drains (bounded sweeps).
- `guest-email-outbox`: drains the guest email outbox (below). Sent with a per-minute key by
  `kickGuestEmails()` after a write; every `event-scheduler` tick drains it too, as a backstop.
- `guest-retention`: cron `17 3 * * *` UTC; anonymises guests past the retention period.
- `rsvp-emails`: legacy. Kept for one deploy only, to move jobs queued before the outbox into it;
  remove it from `background.json` after that deploy.
- `webhook-deliveries`: outbound webhooks (`src/server/webhook-delivery.ts`, retries 3). The platform allows ~10 job
  sends a minute, so ONE job carries a whole emit (many events, each with its endpoint ids; the handler fans out)
  and a refused send is parked in `webhook_outbox` (`webhook-outbox.ts`), which the scheduler tick drains (max 8
  jobs per tick, exponential backoff, dropped after 8 tries or 24 h). Nothing is lost to the rate limit. Detail:
  `docs/porting/webhooks.md`.

Schedules do not tick locally: trigger with `sendJob(url, 'event-scheduler', {})`.

### Guest email outbox (audit H-3, M-21)

- Every guest email (confirmation, waitlist offer, hold expired, event cancelled, host notice, broadcast,
  invite) is a row in `guest_email_outbox`, inserted in the same transaction as the change when possible
  (`enqueueGuestEmails` in `src/server/jobs/outbox.ts`; a unique `key` makes a repeat a no-op).
- Never one platform job per email: the platform accepts only ~10 job sends a minute, so a fan-out would drop most.
- The drain (`drainGuestEmailOutbox`, `src/server/jobs/outbox-drain.ts`) claims rows 10 at a time with
  `FOR UPDATE SKIP LOCKED` (two drains at once are safe), at most 150 rows or ~40 s a run, and uses the row id as
  the provider's Idempotency-Key.
- A failed send waits 2, 4, 8 … minutes (at most 4 h) and is given up after 8 tries; a provider 429 doesn't
  count as a try. Finished rows are deleted after 30 days.

Before restoring a database backup, export the `guest_erasures` table and re-import it after (a full restore rolls that log back
too). The daily `guest-retention` job then erases again any RSVP the restore brought back (audit M-27).

## Email

`src/server/mailer.ts` `sendEventEmail` sends through Resend when the owner secrets `RESEND_API_KEY` and
`EVENT_EMAIL_FROM` (e.g. `Studio <events@domain>`) are set; otherwise it returns false (deliveries are
recorded `failed` and retried while due). Templates live in `src/emails/`. Account emails use the
platform relay. With no provider, local dev (`import.meta.env.DEV`, never production) also prints the
links in the email text to the server console prefixed `[dev email]`, so a guest manage page can be opened.

## Environment

Read only through `src/platform/config.ts`: `SITE_URL`, `DATABASE_URL`, `JWT_SECRET`, `SITE_KEY`,
`SITE_PREVIEW`, `SITE_OWNER_ID` (see `.env.example`); owner secrets `RESEND_API_KEY` and
`EVENT_EMAIL_FROM` via `config.ownerSecret`. Tests only: `TEST_DATABASE_URL`.

Owners come only from the platform's "View as admin"; no email list or first-account rule makes one.
Locally, sign in as an admin with `npm run dev-admin -- you@example.com`.

## Run locally

```bash
npx prisma dev start ccd-astro      # local Postgres; put its URL in .env as DATABASE_URL
npx prisma migrate deploy
npm run db:seed:demo                # demo events, RSVPs, polls (dev only; never touches users)
npm run db:seed                     # sample data (prisma/seed.sql): safe to run twice, refuses a database in use
npx astro dev                       # http://localhost:4321
```

## Testing

- Unit: `npx vitest run` (`src/domain/*.test.ts`, `src/emails/emails.test.ts`, `tests/*.test.ts`; fake
  DBs, no Postgres needed).
- Integration (`tests/integration/*`, skipped unless set): `TEST_DATABASE_URL=postgresql://...@localhost:5441/<throwaway db> npx vitest run`
  against a throwaway docker Postgres on port 5441 (`docs/agent/database.md`).
