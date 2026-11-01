# Feature parity verification: CreatorCrowdHub (TanStack/Hono) vs creator-crowd-hub-astro

Read-only audit (static: greps, diffs, route listing; no servers, no browser, tests not executed).
Source: `C:\Users\Appifylab\Projects\CreatorCrowdHub`. Target: this repo. Dates: 2026-10-30.

## Verdict

| Area | Parity | Note |
|---|---|---|
| Domain rules (`src/domain`) | 100% files identical; 11/12 used by server | `richText.ts` has no server or UI consumer |
| Email templates | 100% + 2 deliberate additions | `consentEmail`, join-link gating for "maybe" |
| Public RSVP / guest routes | ~85% | host JSON API, paid-claim email, invite `g` link missing |
| Admin events / tickets | ~75% | ticket reorder/currency, refund routes, polls-on-duplicate missing |
| Guests / contacts / CSV | ~90% | EzyCourse contact sync intentionally dropped |
| Invites / share kit | ~85% | QR PNG for share kit missing |
| Messages (rules, broadcast) | ~95% | |
| Polls | ~80% | CSV export, reorder, QR (voter and presenter) missing |
| Check-in / analytics | ~80% | revenue and poll-participation KPIs missing, ticket QR not a URL |
| Background jobs | ~90% | all sweeps present; retention added |
| Outbound webhooks | ~90% | no delivery log or name column (schema) |
| Privacy / consent | ~95% | |
| Payments (Stripe) | replaced by platform checkout | manual refunds (`refund_due`), no refund API |
| Roles | 90% | `owner/admin` via platform roles, `checkin_staff` custom role |
| Tests | ~60% of source case count; ~75% of behaviour areas | see section 4 |
| Overall functional parity | about 85% (about 95% counting intentional replacements as done) | |

## 1. Route map (source Hono route to new route)

Mounts in `src/server/app.ts`: `/auth /admin /site /jobs /events /memberships /admin-events /event-admin /event-settings /overview /checkin /analytics /polls /webhook-endpoints /rsvp /event-checkout /polls-public /privacy /pageviews /checkout`. All are served under `/site-api/*` (`src/pages/site-api/[...path].ts`).

### Public / guest

| Source | New | Status |
|---|---|---|
| GET `/public/events/:slug` | GET `/rsvp/events/:slug` (rsvp.ts:828); also GET `/events/:slug` (template-style, events.ts:77) | migrated |
| POST `/public/events/:slug/rsvps` | POST `/rsvp/events/:slug` | migrated (paid goes through `startTicketCheckout`) |
| POST `/public/events/:slug/manage-link` | POST `/rsvp/events/:slug/manage-link` | migrated |
| GET `/public/rsvps/:token` | GET `/rsvp/manage/:token` | migrated |
| PATCH `/public/rsvps/:token` | PATCH `/rsvp/manage/:token` | migrated |
| POST `/public/rsvps/:token/cancel` | POST `/rsvp/manage/:token/cancel` | migrated |
| POST `/public/rsvps/:token/claim` (paid waitlist claim) | `/event-checkout` (POST `{token}`) | changed (claim = resume payment) |
| GET `/public/rsvps/:token/calendar.ics` | GET `/rsvp/manage/:token/calendar.ics` | migrated |
| GET `/public/invites/:token` | GET `/rsvp/invite/:token` | migrated |
| GET `/public/host`, GET `/public/host/:workspaceId/events` | no JSON API; SSR `src/pages/host/index.astro` | changed (single-site, no workspace) |
| POST `/public/events/:slug/view` (beacon) | POST `/pageviews/:slug` | migrated (60/min IP, 500/min event limits) |
| GET `/public/consent/:token` | GET and POST `/privacy/consent/:token` | migrated (POST added) |
| (none) | GET/POST `/privacy/unsubscribe/:token`, GET `/privacy/guest/:token`, `/export`, POST `/erase` | added (PRD privacy section) |
| GET `/events/:id/rsvps/...` approve / decline (approvals.ts) | POST `/event-admin/events/:eventId/guests/bulk {approve\|decline\|promote\|remove\|erase}` and PATCH `/guests/:rsvpId` | changed (merged into bulk/patch) |

### Admin (owner/admin)

| Source | New | Status |
|---|---|---|
| events: GET/POST `/events`, GET/PATCH/DELETE `/events/:id` | `/admin-events` GET/POST `/`, GET/PATCH/DELETE `/:id` | migrated |
| POST `/events/:id/publish`, `/cancel`, GET `/cancel-preview`, POST `/duplicate` | same under `/admin-events` | migrated |
| (none) | POST `/admin-events/:id/unpublish` | added |
| tickets: GET/POST `/events/:id/ticket-types`, PATCH/DELETE `/:ticketId` | `/admin-events/:id/ticket-types` ... | migrated |
| POST `/events/:id/ticket-types/reorder` | none | missing |
| POST `/events/:id/ticket-types/currency` | none (currency fixed by platform checkout) | missing / intentional |
| POST `/events/:id/orders/:orderId/refund`, GET `/refunds`, POST `/refunds/:orderId/retry` | none (`refund_due` flagged, owner refunds in platform Payments tab) | replaced (manual, documented payments-jobs.md) |
| guests: GET `/events/:eventId/guests`, `/guests/:rsvpId`, `/guests/export.csv`, POST `/guests/bulk` | `/event-admin/events/:eventId/guests...` | migrated |
| (none) | PATCH, DELETE `/guests/:rsvpId` | added |
| POST `/events/:eventId/attendance`, `/attendance/import` | `/checkin/events/:eventId/attendance`, `/attendance/import`; GET `/attendees` added | migrated |
| contacts: GET `/contacts`, `/contacts/export.csv` | `/event-admin/contacts`, `/contacts/export.csv` | migrated |
| invites: GET/POST `/:eventId/invites`, GET `/resend-preview`, POST `/resend` | `/event-admin/events/:eventId/invites...` | migrated |
| (none) | POST `/invites/:inviteId/resend`, DELETE `/invites/:inviteId`, GET `/share-kit` | added |
| messages: GET/POST `/:id/messages/rules`, PATCH `/rules/:ruleId`, POST `/toggle`, POST `/preview`, GET `/segments`, GET `/messages`, POST `/broadcast` | `/event-admin/events/:eventId/messages/...` | migrated (+DELETE rule) |
| polls: POST `${base}` create, PATCH/DELETE `/:pollId`, POST `/open`, `/close`, GET `/results`, GET `/polls/by-code/:code` | `/polls/event/:eventId` GET/POST, `/polls/:pollId` PATCH/DELETE, `/open`, `/close`, `/results`, `/by-code/:code` | migrated |
| POST `${base}/reorder` | none (no sort column; order via uuid) | missing (documented polls.md) |
| GET `${base}/export.csv` (poll votes CSV) | none | missing |
| polls public: GET `/:code/active`, POST `/:code/votes`, GET `/:code/results` | `/polls-public/:code/...` | migrated |
| checkin: GET `/checkin/events/:eventId`, GET/POST `/checkin/codes/:code` | `/checkin/events/:eventId`, `/checkin/codes/:code` (+GET `/events`) | migrated |
| analytics: GET `/events/:id/analytics`, GET `/dashboard` | `/analytics/...` (admin-analytics.ts), `/overview` | migrated, KPIs partial |
| webhooks: GET/POST `/webhook-endpoints`, PATCH/DELETE `/:id` | same under `/webhook-endpoints` (+POST `/:id/test`) | migrated |
| jobs: POST `/webhooks/jobs/run-due` | `background.json` `event-scheduler` (`*/5 * * * *`), `rsvp-emails`, `guest-retention`; `src/server/background.ts` | replaced by platform cron |
| workspace: GET/PATCH `/workspace` | GET/PATCH `/event-settings` (+GET `/brand` public) | migrated (single-site settings) |
| team: GET/POST/PATCH/DELETE `/team` | platform `/dashboard/users`, `/roles` (no `/team` route) | replaced (intentional) |
| session: GET `/session`, POST `/session/logout`, dev login | platform `/auth/*`, GET `/me` | replaced |
| integrations GET `/integrations/stripe`, POST `/webhooks/stripe` | none (platform checkout + `payments-hooks.ts`) | replaced |

Route counts: source about 85 handlers; new about 120 incl. template (jobs board, checkout, memberships, auth). Source business routes: 55 migrated or changed, 9 intentionally replaced, 6 missing.

## 2. PRD requirements (US-1 to US-36 and sections 6, 12, 13, 16)

| Req | Status | Evidence |
|---|---|---|
| US-1 create event (slug unique, Draft, validation) | implemented | admin-events.ts POST `/`, `uniqueSlug` |
| US-2 join link reveal | implemented | rsvp.ts:951 only confirmed + going; context.ts gating |
| US-3 capacity/deadline/atomic | implemented | `domain/capacity`, `lockEvent`, rsvp.ts |
| US-4 waitlist promotion (free auto, paid 24h claim) | implemented (claim email via `claim-mail.ts`, `waitlistClaimMinutes`) | jobs/waitlist.ts |
| US-5 approval mode | implemented | admin-guests.ts approve/decline |
| US-6 visibility, noindex | implemented | events.ts, Base.astro noindex |
| US-7 questions max 10, 5 types | implemented (reorder via editor save); no drag-reorder route needed | admin-events.ts |
| US-8 plus-ones | implemented | rsvp.ts, maxPlusOnes |
| US-9 tickets: Stripe Checkout, 30 min hold, refund | partial | platform checkout, hold sweep (jobs/holds.ts); refunds manual |
| US-10 duplicate (settings, questions, tickets, rules, polls) | partial | admin-events.ts:592 copies questions, tickets, rules; polls NOT copied |
| US-11 lifecycle, cancel preview, emails | implemented | cancel-preview, `eventCancelledEmail`, `markEventOrdersRefundDue` |
| US-12 invites paste/tag | partial | paste yes; EzyCourse tag picker dropped (intentional) |
| US-13 share kit, QR PNG 1024px | partial | share-kit route and copy link; QR PNG download missing |
| US-14 resend 48h | implemented | admin-invites.ts |
| US-15 event page, countdown, local time | implemented (SSR `e/[slug].astro`, EventView.astro) | |
| US-16 RSVP no account, consent unticked | implemented | rsvp.ts |
| US-17 confirmation .ics, Google link, ticket QR | implemented | `r/[token].astro` (uqr SVG, googleUrl) |
| US-18 manage magic link | implemented | `/rsvp/manage/:token` |
| US-19 host page | partial | `host/index.astro` SSR, no `/public/host` API |
| US-20 automatic emails, merge tags, idempotent | implemented | jobs/reminders.ts, `claimDelivery`, mergeTags |
| US-21 broadcast, count before send | implemented | admin-messages.ts `expectedCount` |
| US-22 poll builder | implemented | admin-polls.ts |
| US-23 open/close, one open | implemented | admin-polls.ts open closes others |
| US-24 vote by code, 3s polling, device token | implemented | polls-public.ts, poll-client.ts (visibility pause) |
| US-25 presenter: bars, 2s, keys, QR | partial | poll-presenter.tsx keys (arrow, O, C, F); join QR not found |
| US-26 poll CSV export | missing | no route |
| US-27 door check-in, search, QR to URL | partial | admin-checkin.ts; ticket QR encodes the code, not `/admin/checkin/code/CODE` URL |
| US-28 online attendance + CSV | implemented | `/checkin/.../attendance/import` |
| US-29 guest list filters, bulk | implemented | admin-guests.ts |
| US-30 guest CSV (formula-safe) | implemented | csv.ts FORMULA_START guard |
| US-31 EzyCourse contact sync | dropped (intentional; local contacts view remains) | |
| US-32 dashboard (views, RSVPs, conversion, revenue, show rate, poll participation) | partial | revenue and poll participation not ported (checkin-analytics.md) |
| US-33 branding (WCAG warning) | implemented | event-settings.ts, `lib/event-brand` |
| US-34 team (Admin / Check-in Staff, server-enforced) | implemented via platform roles | permissions.ts, `site:event:checkin` |
| US-35 Stripe test + webhooks 6 events, HMAC, 3 retries | partial | 6 events emitted; HMAC and retries done; no Stripe (replaced); webhooks screen CSV link placeholder |
| US-36 workspace defaults | implemented (event-settings) | |
| 13 Integrations: scheduler, outbound webhooks, embed `?embed=1`, calendar | implemented | background.json, Base.astro:85 embed, guests-queries.ts embed iframe snippet |
| 16 NFR: rate limits (RSVP 10/min), sanitised rich text, CSRF, noindex, sitemap, JSON-LD | partial | RSVP limit per isolate only; richText.ts unused; sitemap + seo present |
| 16 Privacy: salted visitor hash, export, delete, consent | implemented | pageviews.ts, privacy.ts |

Counts: 36 user stories: 25 implemented, 9 partial, 1 missing (US-26), 1 dropped (US-31).

## 3. Domain rules and emails

`diff -r src/domain`: no differences (12 modules plus 12 test files identical).

`diff src/emails` (CRLF aside): only intentional additions.
- `context.ts`: `canSeeJoinLink` requires `response === "going"` (join link withheld from "maybe" guests; PRD US-2 hardening).
- `index.ts`, `transactional.ts`: new `consentEmail` (double opt-in).
- `layout.ts`: import path `@/lib/brand` changed to `@/lib/event-brand` (relocation only).
- `emails.test.ts`: +2 tests for the two additions.

Use by new server code (grep of non-test imports):

| Module | Used by |
|---|---|
| capacity | jobs/waitlist.ts, admin-guests.ts, rsvp.ts, ticket-checkout.ts |
| waitlist | jobs/holds.ts, jobs/run.ts, jobs/waitlist.ts, privacy.ts, admin-guests.ts, rsvp.ts |
| reminders | jobs/reminders.ts, jobs/run.ts, emails/types.ts |
| polls | admin-polls.ts, polls-public.ts, poll-client.ts, poll-presenter.tsx |
| codes | admin-events.ts, polls-public.ts, rsvp.ts |
| tokens / secureToken | privacy.ts, admin-invites.ts, claim-mail.ts, admin-guests.ts, rsvp.ts |
| ics | rsvp.ts, emails |
| mergeTags | emails, admin-messages.ts, messages.tsx |
| slug | admin-events.ts |
| time | many (jobs, guest-mail, routes, editor) |
| **richText** | **no consumer (neither server, pages nor portal)**: event description is not sanitised through the domain function. Source used it in DetailsSection/adapters/seo repo. Verify description rendering is escaped or sanitised elsewhere (security gap candidate). |

## 4. Tests

Counts are `it(`/`test(` occurrences, not executed.

| Area | Source cases (files) | New cases (files) |
|---|---|---|
| Domain | 144 (12) | 144 (12), identical |
| Emails | 12 (1) | 14 (1) |
| Server routes (events, public, guests, invites, messages, polls, tickets, checkin, analytics, team, workspace, webhooks, etc.) | 253 (20) | about 190 (spread over tests/admin-*, rsvp, polls, checkin, analytics, webhooks, privacy) |
| Payments/holds/signature/security | 70 (4) | about 41 (payments, ticket-checkout, checkout-session, event-jobs) |
| Jobs runDueJobs | 18 (1) | 26 (background*, event-jobs) |
| Privacy | 21 (2) | 12 |
| Security / authz / hardening | 41 (3) | 8 (admin-events-auth, permissions) plus template auth tests |
| Repo integration (prisma.int) | 66 (10) | 8 (integration/events-*, admin) |
| Frontend libs (schemas, posters, adapters, notify, money, share) | 107 (10) | 0 |
| Analytics metrics, visitor-hash | 26 (2) | 11 |
| App/config/auth/entry/mailer/csv/seed/errors | 77 | about 20 (csv 5, template tests) |
| Total | about 875 (78 files) | about 535 (57 files), of which about 200 are template auth, JWT, 2FA, rate-limit, file tests |

Source behaviours with tests and no clear new counterpart:
1. Poll results cache (`results-cache.test.ts`, 7) and poll route tests for open/close/one-open and vote rules (partial in tests/polls.test.ts).
2. Invite routes (18) and messages routes (16): no `tests/*invite*`, `*messages*` file in new project.
3. Public PII (`public-pii.test.ts`, 8): no check that anonymous responses exclude emails/joinUrl beyond SECURITY-AUDIT fixes.
4. Authz walk (`authz-walk.test.ts`): iterates every route for a guard; none in new.
5. Stripe signature/security (35): n/a, replaced.
6. Frontend: `schemas.test.ts` (39), `adapters.test.ts` (22), `posters.test.ts` (10), `money.test.ts` (6): none.
7. Prisma integration suites (guests, invites, rsvp, polls, team, seo): local DB was unreachable per porting notes.
8. Source rsvp rate-limit test (5), hardening (12): new rate limit untested.
9. Webhook dispatch (10) vs new (14 + 3 + 2): covered.

## 5. Background behaviours

| Behaviour | Status | File |
|---|---|---|
| Confirmation email | yes | jobs/guest-emails.ts, `rsvp-emails` list |
| Reminders (24h / 1h), skip past, once per guest | yes | jobs/reminders.ts |
| "We're live" | yes | jobs/reminders.ts (liveNowEmail) |
| Thank-you | yes | jobs/reminders.ts |
| Waitlist claim expiry (paid, 24h) | yes | jobs/waitlist.ts |
| Hold expiry (30 min) + hold-expired mail | yes | jobs/holds.ts |
| Waitlist promotion (free, on cancel) | yes | admin-guests.ts, jobs/waitlist.ts |
| Retention sweep | yes, added | jobs/retention.ts, `guest-retention` list |
| Outbound webhooks (HMAC, retries) | yes | webhook-emit.ts, webhook-delivery.ts, webhooks.ts |
| CSV exports (guests, contacts) | yes; poll votes CSV missing | csv.ts, admin-guests.ts |
| ICS + Google link | yes | domain/ics, rsvp.ts |
| QR / ticket codes | partial (ticket SVG yes, code only; no share-kit or poll QR) | r/[token].astro |
| Embed `?embed=1` | yes | Base.astro:85 |
| Host page | yes (SSR) | pages/host/index.astro |
| Polls presenter | yes (no QR) | poll-presenter.tsx |
| Check-in by code | yes | admin-checkin.ts `/codes/:code` |
| Mailer | Resend only when keys set, else logs (reminders retried) | mailer.ts |

## 6. Roles and intentional drops

| Item | Source | New | Class |
|---|---|---|---|
| owner / admin | `requireRole` | platform roles + `permissions.ts` (`site:event:manage`) | intentional mapping |
| checkin_staff | role | custom role with only `site:event:checkin`; migration `20261030100000_checkin_role` | intentional mapping; staff list shows no emails (matches PRD) |
| Workspaces, `/workspace` | multi-workspace | single site settings | intentional |
| Team members + invite email | `/team` | platform users/roles | intentional |
| Stripe Connect / keys / integrations tab | Stripe | platform checkout | intentional |
| Refund API | Stripe | manual (`refund_due`) | intentional but PRD US-9 AC lost |
| Audit log | `auditTrail` middleware | `audit()` only on event publish/cancel/delete and settings; SECURITY-AUDIT lists missing audit points | partial gap |
| EzyCourse contact sync, tag picker | integration | none | intentional (no EzyCourse API) |
| DB-backed rate limits | source in-memory per isolate | in-memory per isolate | same as source |

## Ranked real gaps

1. Poll results CSV export (US-26) and poll reorder: add to `src/server/routes/admin-polls.ts` (CSV via `csv.ts`); reorder needs a `sort_order` column.
2. `domain/richText.ts` unused: sanitise event description in `src/server/routes/admin-events.ts` (on write) and `EventView.astro` (render).
3. Ticket QR encodes only the code; PRD requires check-in URL: `src/pages/r/[token].astro` and `admin-checkin.ts`. Also add join-code QR to `src/pages/p/[code].astro` and `poll-presenter.tsx`, and 1024px share-kit QR PNG to `admin-invites.ts` and `screens/invites.tsx`.
4. Duplicate event does not copy polls (US-10): `admin-events.ts:592`.
5. Revenue and poll-participation KPIs (US-32): `admin-analytics.ts`.
6. Missing tests: invites, messages, public PII, route authz walk, rate limit, poll results cache, frontend schemas: `tests/`.
7. Audit log coverage for guest actions, refunds, webhooks, role changes: `src/server/routes/admin-guests.ts` and others.
8. Ticket type reorder (and currency) routes: `admin-events.ts`.
9. Poll guest-link linking (`g` token): `polls-public.ts` (documented as not ported).
10. Webhook endpoint name and delivery log (schema): `admin-webhooks.ts`.
