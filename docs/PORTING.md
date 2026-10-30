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

- No sort columns: ticket types, questions, polls and poll options are ordered by UUIDv7 id (creation
  order); there is no reordering.
- Revenue and poll-participation KPIs are not ported (analytics shows views, RSVPs, UTM breakdown).
- Public RSVP and privacy rate limits are per Worker isolate (in memory). Poll votes use the DB limiter
  with a `vote` kind registered locally in `polls-public.ts`.
- Stripe Connect / the Integrations Stripe tab is not ported: payments use the platform checkout. Ticket
  prices need a catalogue price (creatable only in editor/Preview), prices are immutable, refunds are
  manual (`refund_due`), and paid prices are not gated on a payments connection.
- No workspace/team concept. Marketing-consent confirmation link and the paid waitlist-claim email/checkout
  are deferred.
- Webhook secrets are stored in clear (needed to sign); delivery failure history lives in the platform
  Jobs tab.
- Poll votes are not linked to RSVPs (`PollVote.rsvpId` stays null); the poll-results cache is per isolate.
- Guest emails link to `/e/<slug>/` (`src/server/guest-mail.ts`, `jobs/shared.ts`) and the admin
  `publicPath` is `/e/<slug>`, but the public page is `/events/<slug>/` and no `/e/` route exists.
- The check-in screen's CSV export link is a placeholder (`EXPORT_CSV_HREF`).
- Schedules do not tick locally; without `RESEND_API_KEY` emails are recorded as failed and retried.
