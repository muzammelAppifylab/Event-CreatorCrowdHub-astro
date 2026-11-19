# CreatorCrowdHub — independent audit report

Date: 2026-11-13 · Scope: the working tree of branch `upgrade/template-0.10.22` (template 0.10.22 upgrade, not yet committed) ·
Method: an app map built by 3 mapping agents; 11 area auditors working from that map against the local dev server and a local Postgres;
every Critical/High claim re-checked by a separate verifier that was given only the claim and the code, not the auditor's reasoning;
baseline checks run by the lead. Read-only: no code was changed. Test data was created only in the local database
(prefixes `reqaud-`, `apiaud-`, `audapi-`, `dataaud-`, `privaud-`, `sec1-`, all `@example.com`).

## Fix status (2026-11-13)

Every finding below was worked on, in the uncommitted working tree. After the fixes, the build, type checking (`astro check`:
0 errors) and the full test suite (123 files, 1,454 tests, including integration tests on a local Postgres) all passed. A
security and performance review of the fixes is running. The findings text below is kept as it was, as the audit record;
the status of each finding is in the table in §7.

There is no formal PRD. Requirements were rebuilt from `README.md`, `docs/ARCHITECTURE.md`, `docs/PORTING.md` and
`docs/porting/**` (the user stories US-1…US-36 in `docs/porting/verify/features.md`).

## 1. Verdict: **ship with fixes** (not ready as it is)

Nothing found would let a stranger take over accounts or read other people's data. Authentication, CSRF, sessions, SQL
injection, XSS, secrets and dependency checks all came back clean or Low. The app is not ready to go live yet, for these reasons:

1. **The release gate is red.** `npm test` (and so `npm run check`) exits 1, because a test worker process dies after
   `ported-guests-routes.test.ts`. That happened on 4 of 4 runs here. Type checking also reports 7 errors. (H-4)
2. **Guests can silently miss what matters.** Each guest email is queued as its own background job, and the platform
   accepts only 10 jobs a minute. When an event is cancelled, or many tickets sell in a minute, most cancellation,
   confirmation and waitlist-offer emails are dropped with only a log line. (H-3)
3. **Event lifecycle holes.** An organiser can unpublish and then delete a live event that has guests and paid tickets. That
   skips the cancellation flow: no emails, no refunds queued, and the guests' links die. (H-1)
4. **Waitlist correctness under load.** On a waitlist of about 1,000 people, a guest's cancel fails with 500 and raising the
   capacity promotes nobody. Promotion also ignores per-ticket limits, so a limited ticket gets oversold. (H-2, M-2)
5. **Privacy promises not met.** Guests have no link anywhere to unsubscribe, export or erase their data. Host broadcasts
   ignore unsubscribes. An erased guest's email stays in the orders table. (M-4, M-23–M-26)

None of these needs a redesign. The fix plan in §6 is about 9 independent work streams, mostly S/M effort.

## 2. Baseline results

| Check | Command | Result |
|---|---|---|
| Install | `npm install` / `npm ls --depth=0` | ✅ OK. Warning: the `workerd` postinstall is blocked because `allowScripts` pins `workerd@1.20261006.1` and the lockfile has `1.20261110.1` (L-ops-1) |
| Dependency audit | `npm audit` | ✅ 0 vulnerabilities (0 low, 0 moderate, 0 high, 0 critical) |
| Lint | — | ⚠️ **Not run: the project has no linter or lint script** |
| Typecheck | `npx tsc --noEmit -p .` | ❌ 2 errors: `tests/integration/admin.test.ts:41` (TS2571), `tests/local-dev.test.ts:6` (unused `@ts-expect-error`) |
| Typecheck (Astro) | `npx astro check` | ❌ 5 errors (390 files): the same 2, plus `CspApi` type mismatches at `src/pages/checkout/index.astro:52,71` and `src/pages/dashboard/[...path].astro:23` (`allowFileUploads(Astro.csp, …)`). No script runs type checks, so `npm run check` never sees them |
| Tests (unit + integration, real Postgres) | `TEST_DATABASE_URL=… npx vitest run` | ❌ **exit 1**: 108 files, 0 assertions failed, but "Worker exited unexpectedly". 1,267–1,272 of 1,294 tests reported per run. Isolated: `tests/integration/ported-guests-routes.test.ts` passes 25/25, then its worker process dies; reproduced alone 2/2 times. A run before this audit passed fully (1,290). This is either flaky on Windows or a dangling async operation at teardown; see H-4 |
| Production build | `npm run build` | ✅ Builds (about 40 s). Warnings: `node:crypto` externalised for the browser via `src/platform/auth/password.ts` (managed file); `event-hub.tsx` is both statically and dynamically imported |
| Template / store checks | `npm run platform -- check`, `node store-check.mjs` | ✅ Managed files untouched (72); every store check passes (run earlier today on this same tree) |
| Coverage | — | ⚠️ **Not measured:** `@vitest/coverage-v8` is not installed, and the audit was not allowed to install packages. Coverage of critical paths was mapped by hand (code area, L-code-6): admin-events, guests, invites, messages, polls, RSVP and privacy have route-level integration tests. Paid checkout success and refunds, webhook delivery, the scheduler, and reminders have unit tests only. Integration suites **skip silently** without `TEST_DATABASE_URL` |

## 3. Findings

Severity is the verifier's when one ran ("V" column; "V↓" means the verifier confirmed the finding but lowered its severity). "Status" is
**confirmed** (reproduced, or shown from a concrete code trace) or **suspected** (plausible, not demonstrated). Duplicate reports
from several auditors are merged into one row. Effort: S < ½ day, M ≈ 1–3 days, L > 3 days.

### Critical
None.

### High

| ID | Area | Title | Location | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| H-1 | API / lifecycle | A published event with guests and paid tickets can be **unpublished, then deleted**, skipping cancellation | `src/server/routes/admin-events.ts:584-596` (unpublish only refuses `cancelled`), `:708-719` (DELETE only checks `status==='draft'`) | Live: publish → anonymous RSVP confirmed → `POST /unpublish` 200 → `DELETE` 200 → the guest's contact detail returns 404. Verifier confirmed from code (High) | No cancellation email. Paid `ticket_orders` stay `paid`, so they never reach `/dashboard/refunds`. Manage, privacy and erase links return 404 (also breaks privacy promises, M-23) | Refuse unpublish/DELETE (409) when the event has any held RSVP or a paid order, and point to `/cancel`; or run the cancel path first | S |
| H-2 | Data | Waitlist renumbering runs **one UPDATE per row inside a 5 s interactive transaction** | `src/server/routes/rsvp.ts:540-542` (promote), `src/server/jobs/waitlist.ts:45-50` (renumber, used by promoteWaitlist / holds / refunds / expireEventClaims) | Live: capacity 1 + 1,000 waitlisted. Guest cancel → **500 after 5,097 ms** ("expired transaction"), rolled back. `PATCH capacity:2` → 200, but the log says "waitlist promotion failed" and nobody was promoted. Verifier confirmed (High) | On a popular free event a guest can't cancel, and freed seats are never filled. On paid events, claim expiry fails on every scheduler tick | Use the single `UPDATE … FROM (row_number() OVER …)` statement already in `admin-guests.ts:291`; move all three promote implementations into one module; add a >500-row regression test | S |
| H-3 | Ops | **Guest emails are one platform job each**, and the platform allows 10 jobs a minute, so the rest are dropped with only a log line | `src/server/jobs/guest-emails.ts:15-22` (catch → `console.error`), `admin-events.ts:843-858` (cancel fan-out), `jobs/run.ts:53-58`, `jobs/holds.ts:51-61`, `ticket-checkout.ts:286` | Code + `docs/agent/background-jobs.md:65,143` (10/min, `E_JOBS_RATE_LIMITED`, "never in a loop"). Can't be reproduced locally (jobs run inline without a Site Key). Verifier confirmed (High) | Cancelling an event with 60 guests tells about 10 of them. Paid-ticket confirmations and waitlist offers are lost while the claim clock keeps running | Use a guest-email outbox table drained by the scheduler with batched `sendJobs`, leaving rows in place on 429; or one job per event that pages through its guests | M |
| H-4 | Code / tests | **The release gate fails**: `npm test` exits 1 (a worker process crashes after `ported-guests-routes.test.ts`), and type checking has 7 errors that no script runs | `tests/integration/ported-guests-routes.test.ts` (all 25 assertions pass, then the process dies); tsc/astro check errors listed in §2; `package.json:16` (`check` has no typecheck) | Lead-run: 4/4 full or folder runs and 2/2 isolated runs crash; owner.test.ts passes alone (17/17). Type errors reproduced with `tsc` and `astro check` | Store submission requires `npm run check` to pass. A red suite also hides real regressions | Find the dangling handle at teardown (likely an un-awaited fire-and-forget promise, see L-ops-4, or a pool left open); fix the 2 test type errors and the `CspApi` mismatch (types from different `astro` copies, or cast at the call site); add `astro check` to `check` | M |

### Medium

| ID | Area | Title | Location | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|---|
| M-1 | API / payments | A failed paid-checkout start leaves a **cancelled RSVP that blocks that email for good**, and "RSVP again" loops (V↓ from High) | `src/server/routes/rsvp.ts:924-930`, `:563-564`; `src/pages/r/[token].astro:46,363` | Live on a paid event: 409 `payments_unavailable` → the row is `cancelled`; the second POST gives 202 with `checkoutUrl:null`, nothing started | One platform blip means the guest can never buy | Delete the new row in the release transaction, or re-place cancelled/declined rows as fresh submissions | M |
| M-2 | Data | Waitlist promotion **ignores ticket-type quantity**, so a limited ticket gets oversold (V↓ from High) | `rsvp.ts:507-544` promote(); `jobs/waitlist.ts:61-71`; `src/domain/waitlist.ts` (no `ticketTypeId`) | Live script: ticket with quantity 1 ended with **3 confirmed** after a capacity raise | Oversold ticket tiers; paid claimants pay for sold-out tickets | Carry `ticketTypeId` on waitlist entries; track remaining quantity per ticket under the event lock | M |
| M-3 | Performance | Live-poll votes from **one shared IP** (venue Wi-Fi) mostly get **429** when sent at the same moment (V↓ from High) | `src/server/routes/polls-public.ts:353-354` → `src/platform/auth/store.ts:91-121` (try-lock, 4 tries); `src/lib/poll-client.ts:101-114` (no retry) | Scratch test with the real app: 40 concurrent votes from one IP → **9 accepted, 31 refused**; from 40 IPs → 40 accepted | A room voting at once mostly sees "Your answer was not sent" | Drop the exclusive per-IP lock for votes (rely on the per-device limit plus the unique index); retry 429 in the client with jitter | S |
| M-4 | Privacy | Guests have **no link to unsubscribe, export or erase** their data (V↓ from High) | `src/server/privacy.ts:57-65` (`unsubscribeUrl`/`guestPrivacyUrl` never called); `src/pages/r/[token].astro`; `src/emails/layout.ts:124-125` | grep finds no callers; live: manage page and dev-email links contain neither | The `/privacy/` page promises self-service that nobody can reach; consent law requires an easy way to unsubscribe | Add "Your data" and "Unsubscribe" links on `/r/<token>` and in every guest email, plus a `List-Unsubscribe` header | M |
| M-5 | API / data | **One private-event invite link lets any number of different emails RSVP** | `rsvp.ts:217-225` (liveInvite), `:891-913`; `rsvps.invite_id` is not unique | Live (3 auditors independently) | A forwarded invite opens a private event to anyone | Bind the RSVP email to `invite.email` (or consume the invite), or make that behaviour explicit and documented | S |
| M-6 | API | **Malformed input gives 500** instead of 400/422: bad JSON, a NUL byte in any text or search field, a 36-character non-UUID cursor (500 on the API, **503 + Retry-After on `/events/` and `/host/`**) | `src/server/app.ts:124-128` (onError maps `HTTPException` to 500); text validators in `src/lib/event-schemas.ts`, `rsvp-types.ts`, admin search `q`; `src/server/routes/events.ts:37-41,51-55,124` | Live: dev log `Malformed JSON … [500]`; `?before=<36 chars>` → 500/503; NUL → Postgres 22021 | Error noise logged at error level; public listing shows "unavailable" for a crafted URL; monitoring can't separate client errors from server errors | In onError, pass `HTTPException` through with its status; strip or refuse `\u0000` in a shared text validator; validate cursors as real UUIDs | S |
| M-7 | Requirements | A **cancelled event's page returns 404** instead of the "Cancelled" banner (US-11) | `src/server/routes/events.ts:124-128` (`status:'published'` only); banner code unused at `src/components/EventView.astro:78-95` | Live: cancel → `/events/<slug>/` 404 | Guests clicking old links think the link is broken | Serve cancelled events read-only with the banner | S |
| M-8 | Requirements | A **promoted waitlist guest loses their manage link**: the token is rotated even when no email can carry the new one | `rsvp.ts:526-534`, `:779-799` | Live: B promoted → B's old `/r/<token>` 404 (no mail provider) | Guests are locked out of their RSVP after good news | Rotate only when the email is actually sent (as `mailManageLink:804` already does) | S |
| M-9 | API / data | A guest's **self-erase frees a seat but never promotes the waitlist**, so a newcomer jumps the line | `src/server/privacy.ts:277-302` (no lock, no promote) | Code trace (2 auditors) + `place()` ignores the waitlist when seats are free | Unfair queue; waitlisted guests skipped | Lock the event and run the shared promote after erase | S |
| M-10 | Data | **Seats under an open paid-waitlist claim are not held**, so a new RSVP takes them | `rsvp.ts:432-438` (seatsTakenExcept), `:452-492` | Code trace (2 auditors); `ticket-checkout.ts:272-276` does count claims | A claimant pays for a seat that's gone | Count open claims as taken in `seatsTakenExcept` | S |
| M-11 | Requirements | Guests who answered **Not going, or cancelled, can never RSVP again** through the UI | `src/pages/r/[token].astro:46,363-367`; `rsvp.ts:563-564,917-919` | Live | Lost attendees | Let the manage page re-open a declined/cancelled RSVP | S |
| M-12 | Roles | **`checkin_staff` cannot be assigned**: the managed admin API's slug pattern refuses the underscore, and admins lack `site:event:checkin` | `src/platform/auth/admin.ts:45,272-279` (managed); `prisma/migrations/20261030100000_checkin_role`; `src/server/permissions.ts:33-40` | Live: `PUT /admin/users/:id/roles` with `checkin_staff` → 422 | US-34 door-staff role is unusable | Rename the role to a slug the platform accepts (e.g. `checkin-staff`) in a new migration; add `admin` to the permission's default roles. Never edit the managed file | S |
| M-13 | API | An event slugged **`past`** (or titled "Past") publishes to a page that always returns 503 | `src/lib/event-schemas.ts:251`; `events.ts:99` vs `:124` | Live | Broken page | Add `past` (and other route words) to `RESERVED_SLUGS` | S |
| M-14 | API | **Invites can be created and emailed for a draft event**; their links return 404 | `src/server/routes/admin-invites.ts:260-308`; `rsvp.ts:215` | Live | Invitees get dead links | Refuse unless published | S |
| M-15 | API | The **daily invite limit (2,000) is easy to get around** (single resend skips it; delete-and-recreate) | `admin-invites.ts:226-229,348-382,276-289` | Suspected (code). Can't be shown live without a mail provider | Spam/abuse risk on the sender reputation | Count every send, including resend, in one conditional statement | S |
| M-16 | Security | **Open redirect** via the checkout page's "Go back" link (`/\evil.example` is not caught) | `src/pages/checkout/index.astro:60,119` | Live (2 auditors) | Phishing redirect on the site's own domain | Accept only paths matching `^/(?![/\\])` after decoding, or a fixed allow-list | S |
| M-17 | Security | **Local admin email and password were committed** to README and pushed to `origin/main` (commit `70111de`) | `git show 70111de:README.md` ("Admin login" section). The working-tree README no longer has it | git history scan (value not reproduced here) | Anyone with repo access sees a working credential for any copy that still has that account | Treat it as burned: never reuse that password; delete that local account; if the repo is or will be public, rewrite history or rotate | S |
| M-18 | Product / security | **"Embed on your site" can't work**: every page sends `X-Frame-Options: DENY` | `src/platform/headers.ts:24` (managed), `public/_headers`; `src/portal/guests-queries.ts:404-409`; `src/layouts/Base.astro:100` | `curl -I` | A shipped feature that fails for every user | Remove the embed UI, or ask the platform for a per-path `frame-ancestors` option (managed headers can't be edited) | S |
| M-19 | Ops | Failed reminder deliveries are **retried every 5 minutes with no attempt cap** | `src/server/jobs/deliveries.ts:12-36`, `reminders.ts:66-140` | Code trace | Billed DB operations grow without bound when mail is down or misconfigured | Add an attempts counter and give up after N with backoff | S |
| M-20 | Ops | `/site-api/health` **never checks the database** and says `ok:true` during an outage | `src/server/app.ts:80-88` | Code + live response | Uptime checks can't detect the main failure mode | Add a `SELECT 1` with a short timeout (or a separate `/health/deep`) | S |
| M-21 | Ops | **Broadcasts send up to 500 emails and invites up to 200 inside one HTTP request**; no 429 handling, no recovery if the request dies | `src/server/routes/admin-messages.ts:491-599`, `admin-invites.ts:195-224`, `src/server/mailer.ts:43-81` | Suspected (code; can't load-test Workers limits locally) | Partial sends, Workers CPU/subrequest limits, double sends on retry | Move sending to a background job with an outbox (same mechanism as H-3) | M |
| M-22 | Ops | **20,000-row guest/contact CSV and 10,000-row poll CSV are built in the request** | `admin-guests.ts:43,726-761,923-938`; `admin-polls.ts:41,206-233` | Suspected (code) | Worker memory/CPU limits on large events | Stream the CSV with keyset paging, or build it in a job | M |
| M-23 | Privacy | Unpublish-then-delete **locks guests out of export, erase and unsubscribe**, though `/privacy/` says those "always work" | `src/server/privacy.ts:99-104`; `admin-events.ts:591,714` | Code trace (follows from H-1) | Broken legal promise | Fixed by H-1; also let privacy routes find deleted events | S |
| M-24 | Privacy | "Payment records stay, **without your name**" is untrue: the guest's email stays in `orders.email` (and the `rsvpId` link) after erase and after the 2-year retention | `src/server/payments-hooks.ts:31-52`; `privacy.ts:277-301`; `jobs/retention.ts`; `src/pages/privacy/index.astro:33-38` | Code trace (2 auditors). No paid orders exist locally | Kept personal data contradicts the policy | Null or hash `orders.email` and strip `rsvpId` on erase and retention, or change the policy text | S |
| M-25 | Privacy | **Host broadcasts ignore unsubscribe** and carry no unsubscribe link | `admin-messages.ts:36-38,110,146`; `privacy.ts` route `:110`; `/privacy/` text | Code trace | Messages after opt-out (anti-spam law risk) | Exclude unsubscribed guests from marketing segments; add the link to every email | S |
| M-26 | Privacy | Retention covers RSVPs only: **invite rows (name + email) of people who never RSVP'd are kept forever**; contacts show "Opted in" after an unsubscribe | `jobs/retention.ts:15-33`; `privacy.ts:305-323`; `admin-guests.ts:667,676` | Code trace | Data kept beyond the stated 2 years; wrong consent shown to the host | Add invites to retention; compute contact consent as "any RSVP unsubscribed → out" | S |
| M-27 | Data | After a backup restore, **erasures can't be re-applied** (self-erase leaves no record outside the RSVP row) | `privacy.ts:305-314`; `admin-guests.ts:717-718` | Code trace | A restore silently brings erased people back | Keep an erasure log (hashed email + time) that survives the erase | S |
| M-28 | Performance | **Poll results are rebuilt from every vote row**: the presenter re-reads all votes of all polls every 2 s, and each vote re-reads the poll | `admin-polls.ts:145-157,188-189,235-245`; `src/portal/polls-queries.ts:59-67`; `polls-public.ts:177-196,434-438` | Code + query shapes | DB cost grows with votes × viewers during live sessions | Aggregate with one `GROUP BY` query, or keep counters | M |
| M-29 | Performance | **Public event pages and reads are uncacheable** (`private, no-store` on SSR; no Cache-Control on API reads; the Site Cache is never used) | `src/server/page.ts:16-22`; `events.ts:58,99,124`; `src/platform/cache.ts` has no importers | `curl -I` + grep | Every view costs a Worker render plus billed DB queries | Use `cache.getOrSet` for public event reads, cleared on edit; split viewer-specific parts out of `pageContext` | M |
| M-30 | Performance | Every public page with a poster ships the **whole `event-schemas` chunk (date-fns, date-fns-tz, locale) to test one hex regex** | `src/lib/posters.ts:6` ← `src/components/Poster.astro` | Build-output analysis | Extra JS on every public page | Move the colour constants into a tiny module | S |
| M-31 | Frontend | **Dashboard Events list is clipped at laptop/tablet widths**: "Create event" and right-hand columns can't be reached | `src/styles/app.css:409-413,1684`; `.app-main overflow-x:clip` | Browser pane at 1024 px | Main screen unusable on common widths | Give `.app-page` a `minmax(0,1fr)` column; let the table scroll | S |
| M-32 | Frontend / a11y | Account change-email, 2FA and delete-account inputs have **no accessible label** (label `for=` ids don't match) | `src/portal/screens/account.tsx:181-186,352,430,576-580`; `src/portal/ui/form.tsx:152` | Accessibility tree | Screen-reader users can't use security settings | Use the id from `form.field()` in each label | S |
| M-33 | Frontend | Event hub says **"14 of 12 going"** (counts confirmed "Maybe") while Analytics says 12 | `src/portal/screens/event-hub.tsx:70-80` | Browser | Wrong capacity read-out for hosts | Count going only, like Analytics | S |
| M-34 | Frontend | On phones the **account pages' H1 is hidden under the sticky header** | `src/styles/auth.css:8-12,196-199` | Browser at 375 px | Confusing sign-in/sign-up on mobile | Keep the top padding in the mobile media query | S |
| M-35 | Frontend / a11y | Mobile dashboard drawer: **focus isn't moved into the drawer**, and Tab reaches the dimmed content behind it | `src/portal/routes.tsx:268-330` | Keyboard test | Keyboard and screen-reader users get lost | Focus the drawer on open, make `.app-main` inert, return focus on close | S |
| M-36 | Frontend | The event page shows the **event-time line without its date**, so overnight or cross-date events read a day wrong | `src/components/EventView.astro:382-392`; `src/lib/guest-format.ts:198-205` | Browser | Guests show up on the wrong day | Include the date when it differs from the viewer's date | S |

### Low (summary; full evidence for each is in the audit run, and none is a blocker)

| ID | Area | Title | Location |
|---|---|---|---|
| L-1 | Requirements | Private event links in confirmation emails and `.ics` go to a 404 page | `rsvp.ts:745`; `events.ts:127` |
| L-2 | API | A JSON body sent with a non-JSON content type is ignored, and PATCH answers 200 | admin routes using `validator('json')` |
| L-3 | API | Sender name can't be cleared; a comma in it goes unquoted into `From:` | `event-schemas.ts:563-565`; `mailer.ts:56-60` |
| L-4 | API | Several admin routers validate before checking auth (anonymous callers get 422/500, not 401) | `admin-guests.ts`, `admin-invites.ts` |
| L-5 | API | Door ticket-code lookup works for any past event, not just the door window | `admin-checkin.ts:187-223` vs `:147` |
| L-6 | API | Response headers reveal whether an email has already RSVP'd | `rsvp.ts:917-919` vs `:942-944` |
| L-7 | API | `?invite=` is cut to 128 characters but tokens are 203 | `rsvp.ts:856-858` vs `:118` |
| L-8 | API | Pageview beacon reveals private/cancelled event slugs and counts views for them | `pageviews.ts:89-93` |
| L-9 | API | One device can cast hundreds of votes by dropping its cookie (per-IP cap 600/10 min) | `polls-public.ts:40-48,357-362` |
| L-10 | API | `GET /site-api/events/:slug` sends no Cache-Control for unlisted events | `events.ts:130-132` |
| L-11 | Security | An admin can turn off their own 2FA through the admin route without re-entering the password (managed code: report upstream) | `src/platform/auth/admin.ts:362-393` |
| L-12 | Security | Error log lines include the request path, which holds manage/privacy tokens | `src/server/app.ts:124-127` |
| L-13 | Security | Guest names reach Worker logs through email subjects when no mail provider is set | `mailer.ts:47` |
| L-14 | Security | Webhook URL guard checks hostname text only; DNS names resolving to private IPs pass (suspected; the platform egress block may cover it) | `webhook-delivery.ts:94-114` |
| L-15 | Data | Ticket-type delete is check-then-act without the event lock (FK 500 or orphaned guest) | `admin-events.ts:822-839` |
| L-16 | Data | Reminder loop checks its 45 s deadline once per 500-guest page (suspected) | `jobs/reminders.ts:67-68,103-145` |
| L-17 | Data | Index gaps: contacts `GROUP BY lower(email)` full scan; hold sweep on `ticket_orders(status, created_at)`; daily invite count | `admin-guests.ts:643-688`; `holds.ts:71-76`; `admin-invites.ts:228` |
| L-18 | Ops | `allowScripts` pins an older `workerd` than the lockfile, so its postinstall is blocked | `package.json` allowScripts |
| L-19 | Ops | Webhook emits from background paths are fire-and-forget without `waitUntil` (suspected; possible H-4 cause) | `webhook-emit.ts:36-70`; `holds.ts:44-45`; `ticket-checkout.ts:287-288` |
| L-20 | Ops | rsvp-emails jobs with no mail provider retry 5× and add a delivery row each time | `background.ts:52-60`; `guest-emails.ts:84-87` |
| L-21 | Ops | Resend calls send no Idempotency-Key, so a retry after a timeout duplicates the email | `mailer.ts:54-76` |
| L-22 | Ops | Demo seeder runs against a non-local DB when `SITE_PREVIEW=1` and hard-deletes events by slug | `scripts/seed-demo.mjs:26-32,344-346` |
| L-23 | Performance | Hover-prefetch on links to no-store SSR pages, against the project's own rule | `EventCard.astro:38`; `EventView.astro:285` |
| L-24 | Performance | Event page SSR runs its two reads in series and re-reads the event row | `src/pages/events/[slug].astro:22-35` |
| L-25 | Performance | Dashboard first load ≈ 166 KB gzip / 509 KB raw JS; `EventHub` imported eagerly pulls date-fns | `src/portal/routes.tsx:18` |
| L-26 | Performance | No font preload; 20 `@font-face` rules; largest font file 77 KB (suspected impact) | `src/styles/global.css:14-19` |
| L-27 | Performance | Host cover images loaded at full size with `fetchpriority=high` (suspected impact) | `EventView.astro:108`; `EventCard.astro:42` |
| L-28 | Frontend | Admins don't see "Check-in" in the sidebar though the route lets them in | `routes.tsx:141` vs `:498` |
| L-29 | Frontend | Check-in-by-code ignores RSVP status (waitlisted/cancelled get a "Check in" button) | `checkin-code.tsx:53-75` |
| L-30 | Frontend | Event hub for a missing event keeps rendering with "Loading…" forever | `event-hub.tsx:125-190` |
| L-31 | Frontend | Dark-mode danger buttons 4.34:1 (below AA at 12 px); field borders below 3:1 | `src/styles/theme.css:46,137,211` |
| L-32 | Frontend | Dashboard has no skip link; live poll page has no h1 and drops focus after a vote | `routes.tsx:281-365`; `poll-client.ts:125` |
| L-33 | Frontend | `aria-describedby` points at hint ids that don't exist | `src/portal/ui/form.tsx:163` |
| L-34 | Frontend | Inconsistent time format and host copy across guest pages; inline style + hex in the QR component | `posters.ts:150-162` vs `guest-format.ts:172`; `src/portal/qr.tsx:7` |
| L-35 | Frontend | Waitlisted guest's cancel copy says "your seat"; the confirm step focuses the destructive button | `src/pages/r/[token].astro:345-356,401-405` |
| L-36 | Code | Leftovers from the removed job board (list-page helper, CSS, comments) | `src/lib/list-page.ts`; `global.css:1368-1440`; `index.astro:10` |
| L-37 | Code | Copy-pasted helpers have drifted: UUID regex ×11, cursor parser ×5, notFound ×5, two limiters, two `escapeHtml` | see the code-area evidence |
| L-38 | Code | Event-hub tabs resolved by file-name heuristics (suspected fragility) | `src/portal/event-tabs.ts:21-46` |
| L-39 | Code | Failures to undo a paid edit or release a hold are swallowed without a log | `rsvp.ts:928,1052-1056` |
| L-40 | Code | Type holes: `c as unknown as Ctx`, mutation of the managed `RATE_LIMITS`, `data as never` | `privacy.ts:42-141`; `polls-public.ts:40-51,261,348`; `background.ts:32` |
| L-41 | Privacy | Opting in from the manage page sends no double-opt-in email; re-ticking skips it | `rsvp.ts:610,936` |
| L-42 | Privacy | Self-export refused after 180 days though data is kept 730; export omits the invite and order rows | `privacy.ts:25,67-69,192-257` |
| L-43 | Privacy | The page-view "daily salted hash" is reproducible from `JWT_SECRET` ("cannot be tied to you" is overstated) | `pageviews.ts:38-47` |
| L-44 | Privacy | The privacy page doesn't name processors (mail provider, payment platform, webhook receivers, cover-image hosts) | `src/pages/privacy/index.astro:15-45` |

**Checked and clean (no finding):** CSRF double-submit on every state-changing route; `__Host-` HttpOnly/Secure/SameSite
cookies (code); JWT algorithm pinned; refresh rotation; no `$queryRawUnsafe`/string-built SQL in app code; no
`set:html`/`innerHTML` with data; CSV formula guard; manage tokens hashed and compared in constant time with uniform 404s;
no secrets in the current tree or the client bundle (only the README credential in history, M-17); `npm audit` 0; production
dependencies have no GPL/AGPL licences (the template itself is proprietary, EzyStudio-only); idempotent broadcast replay;
ticket-checkout start race (10 parallel starts → 1 order).

## 4. PRD coverage (US-1…US-36 from `docs/porting/verify/features.md`, plus privacy/invites/SEO)

| Feature | Status | Note |
|---|---|---|
| US-1 Create event | ✅ complete | 201 draft, unique slug, 422 fields |
| US-2 Join link hidden until confirmed | ✅ complete | |
| US-3 Capacity, deadline, atomic seats | ✅ complete | Deadline not tested live |
| US-4 Waitlist promotion | ❌ broken | Manage link dies on promotion (M-8); long waitlists fail (H-2); ticket quantity ignored (M-2) |
| US-5 Approval mode | ✅ complete | |
| US-6 Visibility public/unlisted/private | 🟡 partial | Invite link reusable by any email (M-5); private links 404 (L-1) |
| US-7 Custom questions | ✅ complete | |
| US-8 Plus-ones | ✅ complete | |
| US-9 Paid tickets, 30-min hold, refunds | 🟡 partial | Refunds manual by design; not runnable locally; M-1, M-10 |
| US-10 Duplicate event | ✅ complete | |
| US-11 Lifecycle: cancel preview, emails, Cancelled banner | ❌ broken | Page 404s instead of the banner (M-7); unpublish/delete bypass (H-1); emails dropped at scale (H-3) |
| US-12 Invites by paste | ✅ complete | EzyCourse tag picker dropped on purpose |
| US-13 Share kit + QR PNG | ✅ complete | |
| US-14 Invite resend with 48 h cooldown | 🟡 partial | Single resend skips cooldown and daily limit (M-15) |
| US-15 Event page (local time, countdown) | ✅ complete | Date missing on cross-date events (M-36) |
| US-16 RSVP without account, consent unticked | ✅ complete | |
| US-17 .ics, Google link, ticket QR | ✅ complete | |
| US-18 Manage magic link | 🟡 partial | Dies after promotion (M-8); no re-RSVP (M-11) |
| US-19 Host page | ✅ complete | |
| US-20 Automatic emails with merge tags | 🟡 partial | Scheduler not runnable locally; delivery loss (H-3); retry cap (M-19) |
| US-21 Broadcast with count | ✅ complete | In-request sending (M-21); ignores unsubscribe (M-25) |
| US-22 Poll builder | ✅ complete | |
| US-23 Open/close polls | ✅ complete | |
| US-24 Vote by code with device token | ✅ complete | Shared-IP 429s (M-3) |
| US-25 Presenter view with QR | ✅ complete | Cost grows with votes (M-28) |
| US-26 Poll CSV | ✅ complete | |
| US-27 Door check-in | ✅ complete | L-5, L-29 |
| US-28 Online attendance + CSV import | ✅ complete | Code only |
| US-29 Guest list filters + bulk | ✅ complete | |
| US-30 Guest CSV (formula-safe) | ✅ complete | |
| US-31 EzyCourse contact sync | ⛔ missing | Dropped on purpose; local contacts + CSV work instead |
| US-32 Analytics | ✅ complete | |
| US-33 Branding | ✅ complete | Logo upload needs the platform (not tested) |
| US-34 Team roles (admin, check-in staff) | 🟡 partial | `checkin_staff` can't be assigned (M-12) |
| US-35 Outbound webhooks | 🟡 partial | Owner-only; unit tests only |
| US-36 Workspace defaults | ✅ complete | |
| Privacy: export, erase, consent, unsubscribe, retention | 🟡 partial | Works by URL, but no guest can reach it (M-4); M-23–M-27 |
| Invite landing `/i/<token>` | ✅ complete | |
| Embed, sitemap, robots, noindex | 🟡 partial | Embed blocked by X-Frame-Options (M-18); the rest is by code only |

Totals (39 rows): 27 complete · 9 partial · 2 broken · 1 missing (on purpose).

## 5. What was not checked, and why

- **Anything that needs the EzyStudio platform** (no `SITE_KEY` locally): paid checkout success and refunds, the payment and jobs
  webhooks' HMAC/replay checks, "View as admin" owner sign-in, the owner-only integrations/webhooks screens, file uploads (logo),
  the platform job rate limit (H-3 is from code plus the platform docs), and real email delivery (no Resend key; emails were
  checked through the dev log's link lines and the templates).
- **Scheduled jobs** (reminders, claim expiry, hold sweep, retention) never fire locally; reviewed in code and unit tests only.
- **Production runtime**: Workers CPU, subrequest and memory limits; real Prisma Postgres latency and billing; production
  cookie flags on a real host; CSP on SSR pages (dev doesn't emit it); deployment and rollback (owned by the platform; only
  `docs/agent/publishing.md` describes them); backups (platform-owned).
- **Lighthouse / real Web Vitals**: not installed and not installed for this audit. Performance numbers come from the
  build output and dev-server timings (dev overhead included).
- **Test coverage percentage**: no coverage tool installed (§2).
- **Lint**: no linter configured.
- **Screen-reader output** (NVDA/VoiceOver) was inferred from the accessibility tree only.
- **Brute-force limits pushed to exhaustion**: about 10 auditors shared one local IP, so the limits were read from code.
- **Interruptions**: the dev server exited once mid-audit (exit 127; restarted by the lead within minutes). The requirements
  and frontend auditors switched to code reading for the steps they couldn't finish.

## 6. Prioritised fix plan (carried out on 2026-11-13; see §7)

Streams are grouped by the files they touch, so the ones marked **parallel** can run at the same time without editing the
same files. Inside each stream, items are in order.

**Wave 1: before going live (parallel)**

| Stream | Items | Files (owned by this stream) | Effort |
|---|---|---|---|
| A. Waitlist & capacity core | H-2, M-2, M-8, M-10, M-11, M-1 (one shared promote module; set-based renumber; ticket quantity; held claims; rotate token only when mailed; failed checkout row; re-RSVP) | `src/server/routes/rsvp.ts`, `src/server/jobs/waitlist.ts`, `src/domain/waitlist.ts`, `src/domain/capacity.ts`, `admin-guests.ts` promote section, `src/pages/r/[token].astro` | M–L |
| B. Event lifecycle | H-1, M-7, M-13, M-14, L-15 | `src/server/routes/admin-events.ts`, `admin-invites.ts` (draft check only), `src/pages/events/[slug].astro`, `src/components/EventView.astro`, `src/lib/event-schemas.ts` (reserved slugs) | S–M |
| C. Email delivery | H-3, M-19, M-21, L-20, L-21 (guest-email outbox drained by the scheduler, attempt caps, broadcast/invite sends moved to jobs) | `src/server/jobs/*` (not waitlist.ts), `src/server/background.ts`, `background.json`, `admin-messages.ts`, `src/server/mailer.ts`, new migration | M |
| D. Release gate | H-4: fix the worker crash at teardown (check L-19 first), fix the 7 type errors, add `astro check` to `npm run check` | `tests/**`, `package.json` scripts, `src/pages/checkout/index.astro` + `dashboard/[...path].astro` (type cast only) | S–M |
| E. API input hygiene | M-6, L-2, L-4, L-12 (onError passes through `HTTPException` and redacts token paths; shared text validator refuses NUL; strict UUID cursors) | `src/server/app.ts`, a new shared validator module, `src/server/routes/events.ts` (cursor and `q` only) | S |
| F. Security quick wins | M-16, M-17 (treat the credential as burned), M-12 (new migration for the role slug), M-5 | `src/pages/checkout/index.astro` (after D, or merge the two), new migration, `rsvp.ts` invite check (**do after A**: same file) | S |

**Wave 2: privacy, then the rest (parallel once wave 1 lands)**

| Stream | Items | Files | Effort |
|---|---|---|---|
| G. Privacy | M-4, M-9 (calls A's promote), M-23, M-24, M-25, M-26, M-27, L-41–L-44 | `src/server/privacy.ts`, `src/server/routes/privacy.ts`, `src/emails/layout.ts`, `jobs/retention.ts`, `src/pages/privacy/**`, `admin-guests.ts` contacts consent | M |
| H. Performance | M-3, M-28, M-29, M-30, L-23–L-27 | `polls-public.ts`, `admin-polls.ts`, `src/lib/poll-client.ts`, `src/portal/polls-queries.ts`, `src/lib/posters.ts`, `src/server/page.ts`, `src/portal/routes.tsx` (lazy EventHub) | M |
| I. Frontend & accessibility | M-31–M-36, L-28–L-35 | `src/styles/*.css`, `src/portal/screens/*` (account, event-hub, checkin-code), `src/portal/ui/form.tsx`, `src/portal/routes.tsx` (**coordinate with H**: same file) | M |
| J. Ops & cleanup | M-20, M-22, L-16–L-18, L-22, L-36–L-40, M-18 (decide: remove embed or ask the platform) | `src/server/app.ts` health (**after E**), `admin-guests.ts`/`admin-polls.ts` exports (**after G/H**), `package.json` allowScripts, dead code | M |

Suggested order if you run them one at a time instead: D → B → A → C → E → F → G → H → I → J.

## 7. Fix status by finding

| ID | Status | What changed |
|---|---|---|
| H-1 | Fixed | Unpublish and delete refuse with 409 when the event has held RSVPs or paid orders (atomic check); the dashboard hides Delete and Unpublish using a `hasHeld` flag from the same query; Cancel is offered for drafts with guests and for ended events |
| H-2 | Fixed | One shared promote module (`src/server/waitlist-promote.ts`) with a set-based renumber; a 1,000-row waitlist test passes in under 5 s |
| H-3 | Fixed | Guest emails go through a new `guest_email_outbox` table, drained in batches within the platform job limit, with backoff and give-up after 8 tries (cancellations, confirmations, waitlist offers, broadcasts, invites, host notices) |
| H-4 | Partly fixed | All type errors fixed; `npm run check` runs `astro check` first. The random "Worker exited unexpectedly" is a native Node 24 crash on Windows (0xC0000409), not caused by app code and not fixable in the repo: run tests on Linux/Docker or Node 22 |
| M-1 | Fixed | A failed checkout start deletes the new row |
| M-2 | Fixed | Promotion respects ticket-type quantity |
| M-3 | Fixed | No per-IP lock; 40 votes at once from one IP all succeed; limits kept in the `poll_attempts` table |
| M-4 | Fixed | Every guest email has "Your data" and "Unsubscribe" links plus `List-Unsubscribe`; the manage page links to both |
| M-5 | Fixed | A private invite is bound to `invite.email`; the email field is locked on private invites |
| M-6 | Fixed | 400 or 422 instead of 500 for bad JSON, NUL characters and bad cursors |
| M-7 | Fixed | A cancelled event shows the banner, with no RSVP form and noindex |
| M-8 | Fixed | The manage token is rotated only after the email is accepted (`rsvp.ts`, `claim-mail.ts`) |
| M-9 | Fixed | Erasing a guest promotes the waitlist |
| M-10 | Fixed | Open claims count as taken, for bookings and the public seats-left figure |
| M-11 | Fixed | Declined or cancelled guests can RSVP again |
| M-12 | Fixed | A migration renames the role to `checkin-staff`; admins get check-in |
| M-13 | Fixed | `past` and other route words are reserved slugs |
| M-14 | Fixed | Invites for a draft event are refused |
| M-15 | Fixed | The daily limit counts outbox rows, covers resends and recreations, and is atomic under an advisory lock; bulk-resend race fixed |
| M-16 | Fixed | `sameSitePath` blocks open redirects, with tests |
| M-17 | Owner decision | The credential is still in git history; treat it as burned. Rewriting history needs a force-push, on request only |
| M-18 | Fixed | Removed on the owner's decision (see §10) |
| M-19 | Fixed | Reminder retries capped at 5, with backoff |
| M-20 | Fixed | New `/site-api/health/deep` checks the database (3 s timeout, cached 10 s) |
| M-21 | Fixed | Broadcasts, invites and host notices only queue inside the request |
| M-22 | Fixed | Guest, contacts and vote CSVs are built page by page inside the request (1,000 rows a page, capped at 20,000 rows, `X-Export-Truncated` header when cut); the audit row is written after the read. Streaming was dropped: nothing guarantees the request's database connection after the handler returns |
| M-23 | Fixed | Guests keep access to their data after an unpublish |
| M-24 | Fixed | Erase scrubs `orders.email` (guest and host erase) |
| M-25 | Fixed | Unsubscribe is per person; broadcasts and segments exclude unsubscribed guests |
| M-26 | Fixed | Old invites deleted at retention; contacts consent is correct |
| M-27 | Fixed | A hashed erasure log is re-applied after a restore |
| M-28 | Fixed | Poll results aggregated in SQL; the presenter polls adaptively |
| M-29 | Fixed | Public event detail in the Site Cache (1 day, cleared on every event write); public event pages are the same HTML for everyone with `public, max-age=60`; visitor parts and live seats load in the browser |
| M-30 | Fixed | Public pages no longer ship date-fns (poster constants split out) |
| M-31 | Fixed | The events list is no longer clipped |
| M-32 | Fixed | Account inputs have matching labels and ids |
| M-33 | Fixed | The going count no longer reads "14 of 12" |
| M-34 | Fixed | The H1 is no longer under the header on phones |
| M-35 | Fixed | The drawer takes focus and makes the content behind it inert |
| M-36 | Fixed | The event date is shown on late and cross-date events |
| L-1 | Fixed | Private-event links point to `/r/<token>/` |
| L-2 | Fixed | 415 for a non-JSON body |
| L-3 | Fixed | The sender name can be cleared and is RFC 5322 quoted |
| L-4 | Fixed | 401 before validation |
| L-5 | Fixed | Staff code lookup only in the door window |
| L-6 | Fixed | Identical headers |
| L-7 | Fixed | The invite token limit is 600 |
| L-8 | Fixed | The beacon answers the same for any slug and counts only public ones |
| L-9 | Fixed | Signed voter cookie and a per-IP new-device limit |
| L-10 | Fixed | Unlisted events are `private, no-store` |
| L-11 | Upstream | Managed `src/platform/auth/admin.ts`; to be reported to the template makers |
| L-12 | Fixed | Tokens are redacted in logs |
| L-13 | Fixed | No subject or address in logs |
| L-14 | Fixed | Stricter webhook host checks, redirects refused; DNS-to-private-IP relies on the platform egress block |
| L-15 | Fixed | Ticket-type delete is safe |
| L-16 | Fixed | The deadline is checked per item |
| L-17 | Fixed | New indexes on `rsvps.email` and pending ticket orders |
| L-18 | Fixed | The workerd `allowScripts` pin matches the lockfile |
| L-19 | Fixed | Webhook emits return promises that never reject; background callers await them |
| L-20 | Fixed | No retry storm without a mail provider |
| L-21 | Fixed | Resend calls send an Idempotency-Key |
| L-22 | Fixed | The seeder refuses a non-local database unless explicitly allowed, and never deletes rows it didn't create |
| L-23 | Fixed | No prefetch on SSR pages |
| L-24 | Fixed | The event page reads in parallel |
| L-25 | Fixed | EventHub is lazy |
| L-26 | Fixed | There were no per-weight font faces to cut; the body font is now preloaded |
| L-27 | Fixed | Cover images are lazy |
| L-28 | Fixed | Check-in in the nav for admins |
| L-29 | Fixed | Check-in by code warns on the RSVP status |
| L-30 | Fixed | A missing event shows "Event not found" |
| L-31 | Fixed | Contrast tokens raised |
| L-32 | Fixed | Skip link added; the poll page has an h1 and keeps focus |
| L-33 | Fixed | Hint ids exist |
| L-34 | Partly fixed | QR has no inline style; posters use 24 h time. The "inconsistent host copy" part is unclear in the finding |
| L-35 | Fixed | Waitlist cancel wording and focus |
| L-36 | Fixed | Dead job-board code and CSS removed |
| L-37 | Fixed | Shared `isUuid`, `parsePageCursor` and `notFound`; the two limiters are kept on purpose because they count differently |
| L-38 | Fixed | Explicit typed tab imports |
| L-39 | Fixed | Swallowed failures are logged by id |
| L-40 | Fixed | No runtime edits of the managed `RATE_LIMITS`; job data is validated |
| L-41 | Fixed | Unticking consent clears it; re-ticking sends the confirmation; a reverted edit restores consent |
| L-42 | Fixed | Export works until retention, including invites and payments |
| L-43 | Fixed | A random daily salt in `page_view_salts`, deleted after 2 days; the privacy page is updated |
| L-44 | Fixed | The privacy page names the processors |

**New migrations to apply on publish:** `20261113090000_capacity_backstops`, `20261113150000_guest_email_outbox`,
`20261113160000_checkin_role_slug`, `20261113170000_index_gaps`, `20261113171000_guest_privacy`,
`20261113180000_poll_attempts`, `20261113190000_pageview_salt`.

**Behaviour notes:**
- Existing poll voter cookies count as new devices once after deploy.
- The `rsvp-emails` job list stays only to move old jobs into the outbox; remove it after one deploy.
- The host's "Promote" now sends the scheduler's claim-link offer email.
- Point the uptime monitor at `/site-api/health/deep`.

## 8. Post-fix review (2026-11-13)

A second pass after the fixes: 10 area reviewers, then 7 follow-up fixers.

| Issue | Severity | Fixed |
|---|---|---|
| Manage token leaked to Google Calendar (manage page and emailed calendar links) for private events | Medium (security) | Fixed: no token link ever goes into an outside URL |
| Vote CSV export repeated rows and could loop forever when many votes share a timestamp | Medium | Fixed |
| Retention re-apply erased a guest's fresh RSVP made after their erasure | Medium | Fixed: only rows created before the erasure |
| Bulk invite resend could email an invite twice while its first send was pending, or on a double click | Medium | Fixed |
| The public event page could be CDN-cached for 60 s without its RSVP form after a failed read | Medium-low | Fixed |
| The email drain could overrun its 60 s job limit, and provider 429s used up confirmation tries | Medium | Fixed |
| Broadcast unsubscribe filter: an extra query and a NOT IN of up to 20,000 ids | Medium (performance) | Fixed: one query |
| Contact detail showed the wrong consent after an unsubscribe | Low-medium | Fixed |
| Host erase kept poll free-text answers | Low | Fixed |
| Phone drawer navigation lost focus, and the presenter screen could stop refreshing | Medium / Low-medium | Fixed |
| `privacy_attempts` pruning was capped at 5,000 a day | Low | Fixed |
| Host notices were dropped for unsubscribed guests, against the privacy page | Low-medium | Fixed: notices always go, and broadcasts honour unsubscribe |
| Expired-hold sweep ignored the scheduler deadline | Low | Fixed |
| Discarded RSVP left its invite as "responded" | Low | Fixed |
| Inline guest and consent emails had no idempotency key | Low | Fixed |
| Keyset cursors lost sub-millisecond precision and could skip or repeat rows | Low-medium | Fixed in the public events list and the admin events, refunds, messages and guests lists |
| NUL in a search or slug showed 503 | Low | Fixed: 400 or 404 |
| "Cancel event" could open twice on a double click | Low | Fixed |
| Private-event emails linked to a 404 | Low | Fixed: they link to the home page |
| A restored erasure didn't promote the waitlist | Low | Fixed |
| A retried waitlist-offer email reused its Idempotency-Key with a new link, so the guest could keep a dead link | Low | Fixed: the key includes a fingerprint of the link |

## 9. Integration tests on real Postgres (2026-11-13)

Ten new files, `tests/integration/it-*.test.ts` (about 150 tests: outbox, lifecycle, invites, privacy, polls, misc, rsvp,
guests, checkout, http), cover the new code against real Postgres, including concurrency: an RSVP racing an unpublish, the last
paid seat, 60 voters on one IP, parallel invite sends at the daily limit, and two outbox drains at once. A read-only compliance
check passed every store rule (`npm run platform -- check`, `node store-check.mjs`: 16 PASS). The tests found these bugs, all
now fixed:

| Issue | Severity | Fixed |
|---|---|---|
| A single invite resend ignored the 48 h cooldown, could re-send while the first send was pending, and accepted bounced invites | Medium | Fixed: one conditional update in the daily-limit transaction (409 `resend_cooldown` / `invite_pending` / `invite_bounced`) |
| The resend preview counted invites whose first send was still pending | Low | Fixed |
| Creating invites checked the body before sign-in (422, not 401) | Low | Fixed: guard order |
| Contact detail missed an unsubscribe older than the newest 200 RSVPs; list and detail broke ties differently | Low | Fixed |
| Poll results in SQL counted a two-option single-choice row twice and trimmed only spaces | Low | Fixed: matches the app's counting |
| The privacy rate limit allowed max + 1 tries | Low | Fixed |
| A key repeated inside one outbox batch would drop the whole batch | Low (latent) | Fixed: deduplicated |
| An anonymous non-JSON write to organiser routes got 415 instead of 401 | Low | Fixed: sign-in gate before the input guard |
| The test harness dropped owner notifications (no `to`) | Test only | Fixed |

## 10. Final round (2026-11-16)

| Item | Status |
|---|---|
| M-18 embed snippet | Removed on the owner's decision. Share link, share buttons and QR code kept. |
| Unpublished or deleted event, guest link | The owner decided guests don't need to see it. `/r/<token>/` and `/i/<token>/` now show a friendly "No longer available" page (410, noindex, no-store) with only the event title; the manage page keeps the "Your data" and "Unsubscribe" links. An unknown token is still a plain 404. Checked in the Preview. |
| Invite screen | Refused resends show the server's reason (cooldown, still being sent, bounced, daily limit). |
| Email drain reads | One or two queries per round instead of 3-4 per email. |
| Optional review items | Index for pending invite sends; waitlist promotion skipped when nobody waits; poll admin routes 404 for a deleted event; refunds badge capped at "25+"; event page not cached when branding failed to load. |
| Last review findings | Indexes for refunds due and polls by event (`20261116090000_query_indexes`); bulk resend picks its targets by the preview's rule; guest export pages by value, so a removed guest can't cut it short; sign-in gates run before the input guard on every organiser-only mount; seed timestamps are whole milliseconds. |
| H-4 worker crash | Confirmed Windows-only: 3 Linux runs (Node 22 twice, Node 24 once) had no worker crash. |
| M-17 credential | A history scan found it is the only real secret in the history: `README.md` in 70111de, eebdda6 (origin/main) and 8602987. The repo is public and origin/main's README still shows it. Removed from the working copy; publishing that, or rewriting history, waits on the owner. |
| L-11 | Upstream (managed code). The suggested report for EzyStudio is in §7. |

**Known limits**
- **M-27:** `guest_erasures` lives in the same database, so a full backup restore rolls it back too. Export it before a restore and re-import it after (the note is in `docs/ARCHITECTURE.md`).
- **Keyset cursors:** rows from separate transactions less than 1 ms apart can still, rarely, repeat or skip once at a page edge.
- **H-4:** the native Windows Node 24 test-worker crash remains on this computer; Linux runs don't have it.
