# Porting map: CreatorCrowdHub (TanStack Start) to this Astro app

Source: `../CreatorCrowdHub`. Per-area notes live in `docs/porting/*.md`.

| Source area | New location |
| --- | --- |
| `src/features/events-admin`, `tickets` | `src/portal/screens/events.tsx`, `event-editor.tsx`; `src/server/routes/admin-events.ts`; `src/lib/event-schemas.ts` |
| `src/features/event-page`, `rsvp`, `confirmation`, `guest-routes` | `src/pages/events/`, `r/`, `i/`, `thanks/`; `src/components/rsvp/`; `src/server/routes/rsvp.ts`, `events.ts` |
| `src/features/guests`, `invites` | `src/portal/screens/guests.tsx`, `invites.tsx`, `contacts.tsx`; `routes/admin-guests.ts`, `admin-invites.ts`; `src/server/csv.ts` |
| `src/features/messages`, `src/server/email`, `jobs` | `screens/messages.tsx`; `routes/admin-messages.ts`; `src/server/mailer.ts`, `guest-mail.ts`, `jobs/*`, `background.ts`; `src/emails/` |
| `src/features/checkin` | `screens/checkin.tsx`, `checkin-event.tsx`, `checkin-tab.tsx`; `routes/admin-checkin.ts` |
| `src/features/analytics`, `admin` | `screens/event-analytics.tsx`, `overview.tsx`, `event-hub.tsx`; `routes/admin-analytics.ts`, `admin-overview.ts`, `pageviews.ts` |
| `src/features/polls`, `src/server/polls` | `screens/polls.tsx`, `poll-presenter.tsx`; `src/pages/p/[code].astro`; `routes/admin-polls.ts`, `polls-public.ts`; `src/domain/polls.ts` |
| `src/features/settings`, `team`, `auth` | `screens/event-settings.tsx`, `users.tsx`, `roles.tsx`; `routes/event-settings.ts`; template auth in `src/platform/auth/` |
| `src/features/payments`, `src/server/payments` | `src/server/ticket-checkout.ts`, `payments-hooks.ts`, `routes/event-checkout.ts`; platform `/checkout/` |
| `src/server/privacy` | `src/pages/privacy/`; `routes/privacy.ts`; `src/server/privacy.ts` |
| `src/server/webhooks` | `screens/integrations.tsx`; `routes/admin-webhooks.ts`; `src/server/webhooks.ts`, `webhook-delivery.ts`, `webhook-emit.ts` |
| `src/features/host-page` | `src/pages/host/index.astro` |
| `src/features/design-system`, `errors` | template UI kit `src/portal/ui/`; `src/pages/404.astro`, `500.astro` |
| `src/server/{repos,db,security,lib,rsvp,guests,analytics,csv}` | `src/domain/*` (pure rules), `src/server/*`, Prisma via `src/platform/db.ts` |
| Workspaces / memberships | removed: one site, `event_settings` row id 1, roles via permissions |

## Known gaps (from `docs/porting/*.md` and the code)

- Ticket types, questions, polls and poll options have a `sort_order` column and can be reordered (`PATCH .../order`, `src/server/sort-order.ts`).
- Analytics (`admin-analytics.ts`) shows views, RSVPs, conversion, show rate, paid revenue per currency and poll participation (unique voter devices / confirmed guests).
- Public RSVP and privacy rate limits are per Worker isolate (in memory). Poll votes use the DB limiter
  with `vote` (per IP) and `vote_device` (30/min per voter cookie) kinds registered locally in `polls-public.ts`.
- Stripe Connect / the Integrations Stripe tab is not ported: payments use the platform checkout. Ticket
  prices need a catalogue price (creatable only in editor/Preview), prices are immutable, refunds are
  manual (`refund_due`), and paid prices are not gated on a payments connection.
- No workspace/team concept. Marketing-consent confirmation link and the paid waitlist-claim email/checkout
  are deferred.
- New events start with `STARTER_REMINDER_RULES` (`src/domain/reminders.ts`: confirmation, 24h and 1h reminders, live, thank-you) when the saved event defaults list is empty.
- Webhook secrets are stored in clear (needed to sign); final delivery failures live in the platform
  Jobs tab. Webhook sends are lossless under the platform job rate limit: one job per emit (batched events,
  fan-out in the handler) plus the `webhook_outbox` table drained by the `event-scheduler` tick; every delivery also
  carries `X-Ezy-Timestamp` + `X-Ezy-Signature-V2` (replay protection). See `docs/porting/webhooks.md`.
- Poll votes link to RSVPs only via `?g=<manage token>` on the poll link shown on the guest's manage page (non-anonymous polls); poll links in emails carry a stateless signed `?g=pg_<token>` (HMAC over rsvp + event id, 180 days, `src/domain/tokens.ts`), accepted by `guestRsvpId` alongside the raw manage token, so email-arrivals link too (without `JWT_SECRET` the link has no `g`). The poll-results cache is per isolate.
- Unlisted events render `noindex` (meta tag); Integrations/webhooks are owner only (`EVENT_INTEGRATIONS`, no default role); deployed admins lose access to them, an owner can grant the permission to a role in the Roles screen.
- `/e/<slug>` (source app address, used by emails and the admin `publicPath`) 301-redirects to `/events/<slug>/` (`src/pages/e/[slug].astro`).
- Cancelling an event queues one `event_cancelled` email per guest still expecting it (`queueCancelEmails` in `admin-events.ts`, sent by the `rsvp-emails` job; paid guests are told a refund follows). Raising or removing the capacity of a published event promotes the waitlist at once. The host page lists past public events in a collapsed section (`GET /site-api/events/past`, last 12).
- The check-in screen (managers) now exports the guest list through `guests/export.csv`; the QR share kit has a 1024 px PNG download; door search is debounced 200 ms. Deferred: tagging EzyCourse contacts (`event:{slug}` tags) — the platform exposes no contacts API, so audiences are RSVP contacts only (`contacts.tsx`).
- Schedules do not tick locally; without `RESEND_API_KEY` emails are recorded as failed and retried.

## Event logo (PRD Branding)
- `event_settings.logo_file_id` / `logo_name` (migration `20261101120000_event_logo`): a PUBLIC platform file (PNG/JPEG/WebP/GIF/AVIF, max 2 MB; checked in `parseLogoUpload` in `src/lib/event-brand.ts`, client and server, and again on the stored file at complete).
- Routes (`site:event:manage`): `POST /site-api/event-settings/logo` (step 1), `POST .../logo/complete` (step 3; replaces and deletes the old file), `DELETE .../logo`. `GET /brand` and the settings DTO carry `logoUrl` (`/__platform/files/<id>/<name>`).
- Public guest header (`Base.astro`, `.g-brand`) shows the logo, falling back to the site logo. The email masthead (`emails/layout.ts`) uses `brand.logoUrl` only when it is an absolute https URL (alt = sender name, max 200x32 px), else shows the sender name.
- `loadBrand(db, requestUrl?)` in `src/server/guest-mail.ts` resolves the event logo against the site URL (`config.siteUrl`, else the request origin), falling back to the platform site logo (`/api/public/site/v1/initial-data`, same source as `GET /site`); non-https or unresolvable gives `null`. Callers should pass `c.req.url` where no `siteUrl` is configured.
- Gap: `src/server/jobs/shared.ts` (reminder/job mail) builds its own `brand` without `logoUrl`, so job emails show only the sender name; it should reuse `loadBrand`.
