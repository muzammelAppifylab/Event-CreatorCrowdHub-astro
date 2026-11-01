# E2E test of the new app (Astro port), browser, localhost:4322

Tester account: a freshly registered throwaway user. Registration at /account/register/ produced a plain `member` (roles: ["member"], manageEvents=false), NOT an owner, because owner/admin already exist in the local DB. The only owner login on disk (DEV-LOGIN.local.txt) was off limits to the tester (the tool permission layer denied reading it), so every owner-only flow is BLOCKED, not failed. Credentials for the throwaway user are in `.e2e-credentials.txt` (git-ignored; entry added to .gitignore).

To finish the owner pass: give the user in `.e2e-credentials.txt` the owner role (or provide an owner login the tester may use) and rerun.

## Defects (ranked)

### S1 - Environment instability (not a product bug, but it blocked testing)
- Dev server went down / returned 500 / 503 several times in ~30 min while src was being edited by someone else (jobs removal: `Failed to load url /src/server/routes/jobs.ts ... Does the file exist?`, then Prisma errors on every `/site-api` call, `internal_error`, because the schema (Job model dropped) and the DB / generated client were out of step). Recovered by itself after ~5 min. Errors surfaced to users as "NOT LOADING - We couldn't load this page" (fine) and, on login, "The site did not answer. Check your connection" (ERR_CONNECTION_REFUSED).
- Session was silently dropped between two page loads (viewer became `guest`, /dashboard/events/new/ showed "Sign in to continue") after one of those outages. Probably restart-related; worth checking that sessions survive a dev restart.

### S2 - Member sees "Create event" but it is a dead end
- Page: /dashboard/ as a member. Steps: click CREATE EVENT. Expected: either hidden for users without manageEvents, or a clear "you need permission" page. Actual: link to /dashboard/events/new silently bounces back to /dashboard/; no message. Same for /dashboard/events (redirect to /dashboard/). Sidebar correctly hides Events.
- Overview widgets: `GET /site-api/overview` -> 403, UI shows a red "You do not have access to this." under the page header (console: 403). Acceptable, but combined with the dead Create event button reads as broken. Expected: a friendly empty state for members.

### S3 - Components gallery reachable by any member
- /dashboard/components says "Only you see this page, and only in the Preview", but a plain member can open it and it is in the sidebar. Expected: gated to owners/preview. (All 6 tabs render; no console errors from the gallery itself.)

### S4 - Login page quirks
- "Use a password instead" stays visible after switching to password mode (the sign-in view then shows "Email me a code instead" AND the old toggle in the accessibility tree).
- Hidden forms (code form, 2FA form) are in the accessibility tree, so screen readers / automation can target a hidden email field. Low severity.

### S5 - Copy/consistency on the public side
- Event page says "Hosted by Your host" / "More events by Your host"; the RSVP manage page (/r/<token>/) says "Hosted by The host" and "news and offers from The host". Use one fallback name.
- Event page for a free online event shows the tag "Online" twice (poster and chip) and the ticket dropdown label reads "Free . Free" (duplicate name and price).
- RSVP dialog: Name is not prefilled for a signed-in user (name/email empty while signed in).
- Paid event (demo-pricing-workshop, $49): dialog button reads "CONTINUE TO PAYMENT", then fails with "Paid tickets cannot be bought on this site yet. Try again later." only after filling the whole form. Expected: disable/explain up front when payments are not configured.
- RSVP submit took ~6-7 s the first time (dev compile; not re-measured).

### S6 - Screenshot/automation note
- After the Maybe radio was chosen, the screenshot of the dialog still showed "Going" highlighted, while the DOM radio was `maybe` and the saved RSVP was correct. Probably screenshot lag in the hidden pane; recheck visually.

## Pass/fail table

Legend: PASS, FAIL, BLOCKED (needs owner), PARTIAL.

| Flow | Result | Notes |
|---|---|---|
| Register throwaway user, land on /dashboard | PASS | gets `member`, not owner |
| Sign in with password | PASS | after clicking toggle; plain button click did not always register in the hidden pane (JS submit worked) |
| Dashboard overview | PARTIAL | member: 403 widgets message (S2) |
| Overview at 375 | PASS | layout fine, no horizontal scroll |
| Events list /dashboard/events | BLOCKED | silent redirect for member |
| Create event (details, date/tz, format, venue, capacity, visibility, poster, tickets, questions, reminders, live preview) | BLOCKED | |
| Save / publish / unpublish / duplicate / edit / cancel preview / delete draft | BLOCKED | |
| Public event page, free + online (demo-the-monthly-mastermind) | PASS | S5 copy nits |
| Public page hybrid (pricing-workshop) incl. local vs event timezone lines | PASS | |
| Public page at 375 (demo-pricing-workshop) | PASS | sticky price + CTA bar, no overflow |
| RSVP Going until capacity then Waitlist | PASS | event already full: "Join waitlist", RSVP with required extra question validated, accepted (202), "You're #7 on the waitlist" |
| RSVP required-question validation | PASS | "This question needs an answer" |
| RSVP Maybe | PASS | saved, manage link emailed (dev log) |
| RSVP plus-ones (Me + 1, "4 left") | PARTIAL | field and seat note render; submit blocked by payments |
| Paid ticket checkout | PARTIAL | "Paid tickets cannot be bought on this site yet" (S5) |
| Manage RSVP page /r/<token>/ | PASS | summary, answers, change, cancel controls |
| Dev email log | PASS | `[dev email]` lines readable in dev.log |
| Guests tab (filters, search, drawer, approve/decline/promote, CSV, data JSON) | BLOCKED | |
| Invites (create, share kit QR, resend) | BLOCKED | |
| Messages (broadcast, preview, reminder rules) | BLOCKED | |
| Polls (create, open, vote on /p/<code>/, presenter, close, CSV) | BLOCKED | |
| Check-in (code, undo, door list) | BLOCKED | |
| Analytics | BLOCKED | |
| Settings (branding, defaults, payments, webhooks create/test) | BLOCKED | `/site-api/event-settings` 403 for member |
| Refunds page | BLOCKED | 403 |
| Contacts | BLOCKED | |
| Components gallery /dashboard/components | PASS | all tabs render; access gating S3 |
| Sign out | PASS | |
| Public /site-api/events listing | PASS | 5+ published events incl. demo-* |

Console errors seen: 403 on /site-api/overview, 403 on event-settings/refunds probes (expected for member), ERR_CONNECTION_REFUSED/RESET + 500/503 during the S1 outage, "AbortError: Transition was skipped" (Astro view transition, benign, twice).
