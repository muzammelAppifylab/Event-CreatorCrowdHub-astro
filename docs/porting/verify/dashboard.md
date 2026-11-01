# Dashboard parity: new `/dashboard` vs original TanStack admin

Read-only audit. No source file edited. Paths: SRC = `C:\Users\Appifylab\Projects\CreatorCrowdHub\src` (original), NEW = `creator-crowd-hub-astro\src\portal` (new). Status: **M** matched (same structure and copy), **R** reworded or restructured but the same capability, **X** missing in the new UI. "API?" says whether the new project's server already exposes an endpoint for the action.

## 1. Navigation, URLs, roles

| Area | Original | New | Status |
|---|---|---|---|
| Admin root | `/admin` = Dashboard (`features/admin/DashboardPage.tsx`) | `/dashboard/` = Overview (`routes.tsx:376`) | R |
| Events | `/admin/events`, `/new`, `/$id`, `/$id/edit` (`routes/_owner/admin/events/**`) | `/events`, `/events/new`, `/events/$id`, `/events/$id/edit` (`routes.tsx:442-466`) | M |
| Hub tab in URL | `?tab=` via router search (`EventHubPage.tsx:53`) | `?tab=` via `history.replaceState` + `useState` (`event-hub.tsx:29-104`); not a router search param | R |
| Events list tab in URL | `?tab=` (`EventsListPage.tsx:134`) | local `useState` only (`events.tsx:56`) | X |
| Settings tab in URL | `?tab=` (`SettingsPage.tsx:23`) | local state only (`event-settings.tsx:70`) | X |
| Contacts | `/admin/contacts`, sidebar label "Guests" (`AdminLayout.tsx:60`) | `/contacts`, label "Contacts" (`routes.tsx:138,467`) | R |
| Settings | single `/admin/settings` with 5 tabs: Branding, Defaults, Team, Integrations (Stripe), Webhooks (`SettingsPage.tsx`) | split: `/event-settings` (Branding, Defaults) and `/integrations` (webhooks + guests CSV link) (`routes.tsx:473-507`); no Team tab, no Stripe tab | R/X |
| Check-in | `/admin/checkin` (placeholder), `/admin/checkin/$eventId`, `/admin/checkin/code/$code` (`routes/_staff/admin/checkin/**`) | `/checkin` (event picker), `/checkin/$eventId` (`routes.tsx:480-493`); NO `/checkin/code/$code` | X (code landing) |
| Poll presenter | `/p/$code/present` under `_owner` | `/polls/$code/present` (`routes.tsx:494`) | M |
| Host public page `/host/$workspaceId` | public route `features/host-page/HostEventsPage.tsx` | `src/pages/host/` (public, outside dashboard) | out of scope |
| Role guard | `_owner` = owner+admin, `_staff` = owner+admin+checkin_staff, `RequireRole` redirect (`app/RequireRole.tsx:20-33`) | sidebar items hidden by `ability` (`routes.tsx:125-156,292`); NO route guard or `beforeLoad` (`routes.tsx` has none): a staff user typing `/dashboard/events` reaches the screen and gets the API 403 as an error note | R (nav only) |
| Abilities used | roles owner / admin / checkin_staff | `manageEvents` (Events, Contacts, Event settings, Integrations), `checkinGuests` (Check-in) (`routes.tsx:136-140`, `server/permissions.ts:34,43`) | M |
| Extra nav in new (not in original) | none | Account, Jobs, Users, Roles, Activity, Components (platform template) | n/a |
| Theme/account menu | Settings, Dark/Light toggle, account menu, workspace name (`AdminLayout.tsx`) | theme menu, account menu, sign out, back to site (`routes.tsx:317-365`) | M |

## 2. Dashboard / Overview

| Element | Original | New | Status |
|---|---|---|---|
| Heading "Dashboard" | `DashboardPage.tsx:268` | `overview.tsx:117` | M |
| Setup checklist "Finish setting up", "n of m done", Done/Optional/To do, email-domain info row | `DashboardPage.tsx:42-85` | `overview.tsx:72-81`: same title, different steps (confirm email, two-step, add an admin, post a first job: site template items, not event-host items) | R |
| Empty state "Create your first event" + CTA | `DashboardPage.tsx:~215` | `overview.tsx:153` | M |
| Upcoming events table (Event / When / Going, "Full" badge, "x / no limit", "All events" link, "Nothing scheduled. Create an event") | `DashboardPage.tsx:99-165` | `overview.tsx:167-180,238-248` (Event / When / Going; same empty sentence) | M |
| "Last 30 days" table: RSVPs, Page views, Net revenue vs "Previous 30", Change | `DashboardPage.tsx:175-210` | absent; replaced by 4 stat tiles (Upcoming, Going, Waitlisted, Awaiting approval) `overview.tsx:186-189` and a "Recent RSVPs" list `:193` | X (API? no: `server/routes/admin-overview.ts` returns totals/perEvent only; page-view totals exist per event in `admin-analytics.ts`) |
| Error "Couldn't load your dashboard." + retry | `DashboardPage.tsx:~203` | ErrorNote per query | R |

## 3. Events list (`/events`)

| Element | Original | New | Status |
|---|---|---|---|
| Title "Events", lead "Everything you're running, have run, or are still drafting.", "Create event" | `copy.ts:94-97` | `events.tsx:201-208` | M |
| Tabs Upcoming / Past / Drafts | `copy.ts:98` | `events.tsx:35,213-217` | M |
| Columns Event, Date, Status, Visibility, Going, Actions | `copy.ts:99`, `EventsListPage.tsx:25-82` | `events.tsx:120-197` (same six) | M |
| Cover thumbnail and `/e/slug` under the title | `EventsListPage.tsx:38-45` | text only: "Format · /e/slug", no cover | X |
| Going = seats taken "x / No limit" | `EventsListPage.tsx:65-79` (seatsTaken) | `events.tsx:156-167` uses `counts.confirmed`, adds "n waiting" badge | R |
| Three empty states (title, text, action) | `copy.ts:104-122` | `events.tsx:39-45,227-243` (identical strings, but the "Upcoming" action opens the editor via button) | M |
| Load error "We couldn't load your events." + Try again | `copy.ts:102` | DataTable `error` prop (generic) | R |
| Row menu: Open, Edit, Duplicate, Copy link, Cancel event, Delete draft | `EventRowActions.tsx:49-86` | `events.tsx:177-194`: Open, Edit (BUG: goes to the hub `/events/${id}`, not `/edit`, line 182), Publish/Unpublish (extra), Duplicate, View public page (extra), Cancel event, Delete draft. NO "Copy link" | R/X (Copy link) |
| Cancel confirm with guests/refund counts | `copy.ts:150-157`, `LifecycleDialogs.tsx` | `events.tsx:97-110` (preview fetched first; message reworded; refund amount `toFixed(2)` instead of money format) | R |
| Cancel preview error fallback "We couldn't count the guests affected..." | `copy.ts:152` | `event-hub-actions.tsx:138` has it; list screen aborts silently (`events.tsx:99`) | R/X |
| Delete draft confirm / toast "Draft deleted" | `copy.ts:162-167` | `events.tsx:111-118` ("Deleted “x”.") | R |
| Duplicate dialog: Title of the copy, Starts, Ends, timezone note, "Create copy", toast "Copy saved as a draft" | `copy.ts:136-148` | `events.tsx:264-332` (same strings); defaults to +7 days | M |
| Duplicate dialog validation | "Add a title", "End must be after the start" (`LifecycleDialogs.tsx:98-102`) | "Enter a title.", "Enter a valid date and time.", "End must be after the start." (`events.tsx:292-295`) | R |

## 4. Event hub (`/events/$id`)

| Element | Original | New | Status |
|---|---|---|---|
| Header: back "All events", cover thumb, title, badges status / visibility / format | `EventHubPage.tsx:147-209` | `event-hub.tsx:108-158` (no cover thumb) | R |
| Actions: Copy link, Edit, Duplicate, Delete (draft), Publish (draft), Cancel event | `EventHubPage.tsx:159-201` | `event-hub.tsx:119-155` + `event-hub-actions.tsx:111-197` (adds Unpublish and View public page) | M |
| Publish error list (409) | toast | `event-hub-actions.tsx:21-39` Notice "This event can't be published yet" with field list | R (richer) |
| Draft note / Cancelled note | `copy.ts:~297` | `event-hub.tsx:161-162` (identical strings) | M |
| Tabs: Overview, Guests, Invites, Messages, Polls, Check-in, Analytics | `copy.ts:287-296` | `event-tabs.ts:9-17` | M |
| Overview stat tiles: Going, Maybe, Waitlisted, Pending approval, Seats taken | `EventHubPage.tsx:241-265` | `event-hub.tsx:56-62` (same labels; Going is confirmed guests, Seats taken "x of cap") | M |
| Overview "Details": When, Where, Public link, Join link, Poll join code | `EventHubPage.tsx:267-300` | `event-hub.tsx:47-52,72` (public link `/events/slug/` vs `/e/slug`) | M |
| Overview extra "Summary" (views, RSVPs, conversion, checked in) | n/a | `event-hub.tsx:63-71` | extra |
| "Refunds to finish" panel (FailedRefunds: guest, amount, Stripe error, Retry) | `EventHubPage.tsx:255`, `features/payments/FailedRefunds.tsx:1-82` | absent | X (API? NO: no `GET /events/:id/refunds` nor retry in `server/routes/*`; `ticket-checkout.ts` only marks orders `refund_due` on cancel) |
| Invites tab shows ShareKit beside list | `EventHubPage.tsx:101-111` | `invites.tsx:215` inside the tab | M |

## 5. Event editor (`/events/new`, `/events/$id/edit`)

| Element | Original | New | Status |
|---|---|---|---|
| Header: "New event"/"Edit event", back, Save draft / Save changes, Publish + hint "Publishing saves your changes first..." | `copy.ts:170-180`, `EventEditorPage.tsx:221-262` | `event-editor.tsx:349-379` (hint identical, line 361) | M |
| Section nav (Details, Date & time, Location, Capacity & RSVP, Questions, Tickets, Reminders, Polls) with scroll-spy | `EventEditorPage.tsx:360-412` | `event-editor.tsx:75,381` (order Details, Location, Date & time...) | R |
| Cancelled event not editable | `copy.ts:190` | `event-editor.tsx:395` (reworded: "A cancelled event can't be edited or published again. Duplicate it...") | R |
| "Fix N fields before saving." toast and summary | `copy.ts:182` | `event-editor.tsx:398-402` "Fix these first" list | R |
| Live guest Preview (right column on xl, sheet on small) | `EventEditorPage.tsx:296-352`, `EventPreview.tsx` | absent | X (client-only, no API needed) |
| "We kept the changes you hadn't saved." restore + Discard | `EventEditorPage.tsx:128-157,270-277` | absent | X |
| Leave-without-saving dialog (`useBlocker`) | `EventEditorPage.tsx:159,306-312`; copy `:183-188` | absent | X |
| Details: Title (placeholder "Pricing Q&A with Clara"), Link/slug (auto-follows title, hints, "Guests open ..."), Description (hint), Cover URL | `sections.tsx:67-120`, `copy.ts:197-209` | `event-editor.tsx:407-422` Title, Link (single hint), Description hint reworded; link does not follow title | R |
| Cover/poster: image URL, poster design, palette, headline, eyebrow, footer | `CoverEditor.tsx`, `PosterPicker.tsx` | `event-editor.tsx:423-450` (fields, no visual picker or preview) | R |
| Date & time: Starts, Ends, Timezone (hint), RSVP deadline (hint, clear) | `copy.ts:210-221` | `event-editor.tsx:485-510` (hints reworded; no "Remove deadline" button) | R |
| Location: Format radio cards, Venue name, Address, Map link (hint), Join link (hint) | `copy.ts:222-231` | `event-editor.tsx:452-483` | M |
| Capacity & RSVP: Capacity, Waitlist, Approve guests, Allow Maybe, Plus-ones, Show guest list, Visibility cards (with hints) | `copy.ts:232-244` | `event-editor.tsx:511-540` (labels shortened: "Waitlist", "Approve guests"; visibility hints shorter) plus extra "Thank-you link" | R |
| Questions: add (max), types (5), options, required, remove; reorder up/down/drag | `QuestionBuilder.tsx:177`, `copy.ts:245-270` | `event-editor.tsx:542-575` add/remove/type/options/required; NO reorder | X reorder (client-only; order stored in event PATCH) |
| Tickets: list, add/edit/delete; reorder up/down; event-level currency select; "End sales now"; Sold out / Sales ended / Has orders badges; "Paid tickets need Stripe" notice | `TicketTypesEditor.tsx:110,116,130,270`, `tickets/copy.ts` | `event-editor.tsx:610-775`: table (Ticket, Price, Sold, Sales end), modal Edit/Add, delete confirm; per-ticket currency; NO reorder, NO end-sales-now, NO Stripe notice, NO event currency action | R/X (API? ticket CRUD yes `admin-events.ts:659-735`; reorder and currency NO) |
| Reminders section embeds RuleList | `sections.tsx:445-451` | text pointing to Messages tab (`event-editor.tsx:589-592`) | R |
| Polls section embeds PollsTab | `sections.tsx:461-467` | text pointing to hub (`event-editor.tsx:594-597`) | R |
| Validation messages (title, venue, join link, deadline, end) | zod: "Add a title", "Keep the title under 120 characters", "Add the venue name", "End must be after the start" (`lib/schemas/event.ts:66-116`) | `lib/event-schemas.ts` same wording plus trailing period ("Add the venue name.", "End must be after the start.", line 313-320) | R |

## 6. Guests tab and Contacts

| Element | Original | New | Status |
|---|---|---|---|
| Search "Search guests" + placeholder, Status filter (all statuses + 6), Ticket filter (only if >1 type), Checked in toggle, Export CSV | `GuestsTab.tsx:108-161`, `lib.ts` copy | `guests.tsx:278-321` (search by Enter, Ticket filter if any type) | M |
| Guest total "n guests" | `GuestsTab.tsx:170` | stat tiles Confirmed/Pending/Waitlisted instead (`guests.tsx:272-276`) | R |
| Columns: Guest(+plus-ones), Status(+#waitlist), Response, Seats, Ticket code, Checked in (timestamp), Ticket, Payment, one per RSVP question | `GuestsTab.tsx:259-327` | `guests.tsx:186-266`: select, Guest, Status(+#n), Response, Seats, Ticket, Checked in (relative). MISSING Ticket code, Payment, question-answer columns, "+ n" plus-ones | X (data in API list response: questions, ticketTypes) |
| Pagination "Page n of m" | `GuestsTab.tsx:196-214` | "Load more" | R |
| Bulk actions: Approve, Decline, Promote, Remove, Erase with eligible counts "(n)" | `GuestsTab.tsx:176-195` | `guests.tsx:323-350` (Approve/Decline/Promote buttons, Remove/Erase in menu; no eligibility counts) | R |
| Bulk confirm copy | `guests/lib.ts:66-87` | `guests.tsx:78-109` reworded (no "invite", poll-vote anonymisation text dropped; adds "They are emailed") | R |
| Bulk result toast (partial success summary with skip reasons) | `lib.ts:90-104` | `summarizeBulk` in `guests-queries.ts` | M |
| Empty states "No guests yet" / "No guests match" + Clear filters | `copy.ts` guestCopy | `guests.tsx:361-371` | M |
| Per-row actions menu | none (row click opens drawer) | `guests.tsx:246-263` View details, Approve, Decline, Promote, Remove, Erase | extra |
| Drawer facts: Response, Seats (1 + n), Ticket code + copy, Ticket, Payment, Waitlist, Marketing consent, Attended online, Source | `GuestDrawer.tsx:66-79` | `guests.tsx:476-487`: Response, Seats, Ticket, Payment, Source, Checked in, Waitlist. MISSING ticket code (and copy), Marketing consent as fact (only a checkbox), Attended online | R/X |
| Drawer Answers, Timeline | `GuestDrawer.tsx:104-135` | `guests.tsx:489-497` | M |
| Drawer actions: Approve, Decline, Promote, Download data (JSON), Remove | `GuestDrawer.tsx:137-171` | `guests.tsx:499-523` Approve, Decline, Promote, Check in / Undo check-in (extra), Remove. MISSING "Download data (JSON)" (GDPR export) | X (API? yes `server/routes/privacy.ts` guest export is token-based; no admin `export.json` route in `admin-guests.ts`) |
| Drawer edit form (name, email, plus-ones, marketing consent off-only) with validation | read-only | `guests.tsx:459-474,384-388` ("Enter a name.", "Enter an email address.", "Plus-ones are a whole number from 0 to 10.") | extra |
| Contacts: title, lead, search, Export CSV, columns Contact / Events / Last event / Marketing, empty states | `ContactsPage.tsx` | `contacts.tsx:30-139` identical columns and header copy; adds consent segmented filter defaulting to "Opted in" (original shows everyone) | R |

## 7. Invites tab and Share kit

| Element | Original | New | Status |
|---|---|---|---|
| Compose: heading "Invite guests", textarea "Email addresses", hints, live counts valid / invalid / repeats removed, "Invite up to N at a time", button "Send n invites" | `InvitesTab.tsx` InviteComposer | `invites.tsx:218-251` modal "Invite people", textarea "Emails", hint "Up to 200 people at a time.", no live counts, button "Send invites" | R |
| Result alert (sent, skipped duplicates, skipped invalid) | `InviteResult` | `invites.tsx:240-246` | M |
| List columns Guest, Status (+ response), Last sent, Copy link | `InvitesTab.tsx:columns` | `invites.tsx:130-170` Invitee, Status, Last sent, Actions menu: Copy link, Send again (single), Delete invite (both extra) | M+extra |
| "Resend to n non-responders" confirm, 48h rule | `InvitesTab.tsx:216-236` | `invites.tsx:111-119,178-189` | M |
| Empty state "No invites yet" | `InvitesTab.tsx` | `invites.tsx:206-208` | M |
| Share kit: event link + copy, X/LinkedIn/WhatsApp/Facebook, embed code + copy | `ShareKit.tsx` | `invites.tsx:257-299` (unpublished warning is extra) | M |
| Share kit QR image + "Download QR (PNG)" | `ShareKit.tsx:108` | absent | X (client-only) |

## 8. Messages tab

| Element | Original | New | Status |
|---|---|---|---|
| "Automatic emails" list: On/Off toggle, kind, "when" in words, edit, delete; empty "No automatic emails yet" | `RuleList.tsx`, `lib.ts describeOffset` | `messages.tsx:358-402,313-345` | M |
| Rule sheet: kind, amount + unit, before/after for "we're live", subject, message, merge-tag menu, email preview frame | `RuleSheet.tsx`, `CopyFields.tsx`, `EmailPreviewFrame.tsx` | `messages.tsx:56-110,390-440` (merge-tag chips, preview modal with unknown-tag warning) | M |
| Validation: subject/message required | "Add a subject"-style | `messages.tsx:56-59` "Add a subject." / "Add a message." / "Enter a whole number, 0 or more." | R |
| Broadcast: segment select with counts, subject, message, preview, "Send to n guests" confirm "Emails can't be unsent." | `BroadcastComposer.tsx` | `messages.tsx:136-206` | M |
| Message log: Subject, Sent to, Delivered, date; empty "No messages sent yet" | `MessageLog.tsx` | `messages.tsx:456-488` (empty "Nothing sent yet") | R |
| Message "resend" / retry failed deliveries | none in the original | none | n/a |
| Default-reminders editor (Settings > Defaults) | `DefaultRemindersEditor.tsx` | `event-settings.tsx:188-248` ("Default emails": add by kind, minutes-from-start numeric) | R |

## 9. Polls tab and presenter

| Element | Original | New | Status |
|---|---|---|---|
| Heading "Live polls" + description, "Add poll" | `polls/copy.ts:tab` | `polls.tsx:173-210` ("New poll", lead "Guests vote at host/p/CODE. One poll is open at a time.") | R |
| Join code display + "Copy vote link" | `PollsTab.tsx:124-128` | text only, no copy button | X (client-only) |
| "Open presenter view" | `PollsTab.tsx:139` | `polls.tsx:193` "Presenter view" | M |
| "Export CSV" | `PollsTab.tsx:145` (`GET .../polls/export.csv`) | absent | X (API? NO export route in `admin-polls.ts`) |
| Poll reorder (up/down, live-region "Poll moved from n to m") | `PollsTab.tsx:166`, `api/polls.ts:165` (`POST .../polls/reorder`) | absent | X (API? NO) |
| Row: status badge (Draft/Live/Closed), type, anonymous/named, "results hidden", votes | `PollsTab.tsx:190-200` | `polls.tsx:119-128` (Question + type, Status, Answers; "Open" not "Live") | R |
| Open / Close / Edit / Delete; open-while-another-open confirm "Open and close the other" | `PollsTab.tsx:205-275` | `polls.tsx:137-150` Close / Reopen / Open for voting, Edit and Delete only for drafts; no confirm when another poll is open | R/X (confirm) |
| Delete confirm "It hasn't been opened, so no votes are lost." | `copy tab.deleteBody` | `polls.tsx:109` "Only draft polls can be deleted." | R |
| Editor: Question, Answer type (4), Options 2-10 with reorder (move up/down), add/remove, Anonymous, Show results | `PollEditor.tsx` | `polls.tsx:220-310`: question, type radio cards, options add/remove (NO move up/down), Anonymous, Show results | R/X option reorder |
| Validation | "Write the question" style | `polls.tsx:47,226` "Write the question.", "Write option n, or remove it.", "Each option must be different." | M |
| Presenter: status, question, live results, voters count, join panel with code and URL, keys → / O / C / F, Next poll, Open, Close, Full screen | `PresenterPage.tsx` | `poll-presenter.tsx:95-185` (no QR code, no Full screen button, no keyboard hint row visible) | R/X (QR) |

## 10. Check-in and Analytics

| Element | Original | New | Status |
|---|---|---|---|
| Hub Check-in tab: "Door check-in", n of m seats (RSVPs), "Works on a phone...", "Open door screen", Online attendance for non-in-person | `CheckinTab.tsx` | `checkin-tab.tsx:9-29` (identical copy) | M |
| Door screen: back, event title, time, search "Name, email or ticket code", guest rows with code, status badge, "In at hh:mm", big Check in / Checked in toggle, empty states | `CheckinPage.tsx:44-155` | `checkin-event.tsx:50-264` (adds ticket-code entry card, "Not in yet" badge, "Showing first 200" note) | M |
| Toggle error copy ("isn't confirmed", "ticket wasn't found") | `checkin/lib.ts:19-22` | `checkin-event.tsx:45-47` reworded | R |
| Scan landing `/admin/checkin/code/$code` (QR link: shows guest, check in / undo) | `CheckinByCodePage.tsx` | absent | X (API? YES: `GET/POST /checkin/codes/:code`, `admin-checkin.ts:185,194`) |
| Check-in event picker `/checkin` | placeholder only | `checkin.tsx:10-55` | extra |
| Online attendance: CSV import (email column, 500 KB), unmatched list, mark by hand | `OnlineAttendance.tsx` | `checkin-event.tsx:297-373` | M |
| Analytics KPIs: Views, RSVPs, Conversion, Net revenue, Show rate, Poll participation, with "what does this mean" definitions | `EventAnalyticsTab.tsx:30-80`, `Kpi.tsx` | `event-analytics.tsx:32-39`: Views (+sparkline), RSVPs, Conversion, Show rate. MISSING Net revenue, Poll participation, definitions | X (API? no revenue or poll participation in `admin-analytics.ts`) |
| Page views over time chart, Top sources table, "RSVPs by status" bars, "Updated hh:mm. Days are counted in UTC." | `EventAnalyticsTab.tsx:117-135` | `event-analytics.tsx:41-73` (views chart, sources table, updated note; no RSVPs-by-status) | R/X |

## 11. Settings, Team, Integrations

| Element | Original | New | Status |
|---|---|---|---|
| Settings title "Settings" + lead | `copy.ts:320-321` | `event-settings.tsx:73` (identical) | M |
| Branding: Logo URL, Brand colour (presets, hex, picker, reset), AA contrast report, Display font (3), live Preview | `BrandingTab.tsx`, `copy.ts:329-358` | `event-settings.tsx:100-129`: Brand colour (hex text), Font (3 cards). No logo, no picker, no AA report, no preview; font labels "Sans/Serif/Rounded" vs "Grotesk/Serif/Rounded"; hex error "Use a hex colour like #4f46e5." vs "Use a 6-digit hex code, like #4F46E5" | R/X |
| Defaults: timezone, allow Maybe, show guest list, sender name, reply-to, default poster, default emails | `copy.ts:359-372`, `DefaultsTab.tsx` | `event-settings.tsx:131-246` (labels reworded: "Timezone", "Email sender name", "Allow “Maybe”"; hint strings reworded) | R |
| Defaults validation "Add a sender name", "Enter a valid email address" | `copy.ts:370-371` | server messages: "Enter a valid email address." (`event-schemas.ts:558`) | R |
| Save feedback "Settings saved" / per-card save + "Undo changes" | `copy.ts:323-326` | toast "Settings saved." per card; no "Undo changes" | R |
| Team tab: list members (role, Active/Invited), invite by email + role (admin / check-in staff), change role, remove member (owner only) | `TeamTab.tsx:41-292`, `api/team.ts` (`/team`) | absent. `/users` + `/roles` (platform, `routes.tsx:414-428`) manages roles of site users; no invite-by-email team flow | X (API? NO `/team`; `admin/users` role patch exists in platform) |
| Stripe tab: connected badge, env-var checklist, webhook URL + copy, Test connection (owner only) | `IntegrationsTab.tsx`, `api/integrations.ts` | absent; no `/integrations/stripe` route (`platform/payments.ts` only) | X (API? NO) |
| Webhooks tab: list, Add endpoint (URL, events checklist), signing secret once, pause/resume, test, delete | `WebhooksTab.tsx` | `integrations.tsx:43-259` (Receiver / Events / Status / Actions; add drawer; copy-once secret; test toast with status and ms) | M |
| Webhook URL validation "Enter the receiver URL." / "The URL must start with https://" | `WebhooksTab.tsx` zod | `integrations.tsx:40` | R |
| Guests CSV link on Integrations page | none | `integrations.tsx:38,164` points at `/site-api/guests/export.csv` which is NOT a route (real: `/site-api/event-admin/events/:id/guests/export.csv`, `admin-guests.ts:634`) | defect |

## 12. Source user actions with NO UI in the new dashboard

Ranked by impact for a host. "API?" = endpoint already in `src/server/routes`.

| # | Action (original citation) | API? |
|---|---|---|
| 1 | Team management: invite co-host / door staff by email, change role, remove (`TeamTab.tsx`, `api/team.ts`) | NO |
| 2 | Stripe connect status, env checklist, webhook URL, Test connection (`IntegrationsTab.tsx`) | NO |
| 3 | Refunds to finish: list pending refunds + Retry (`FailedRefunds.tsx`, `api/tickets.ts:110-118`); refund order (`api/tickets.ts:99`, unused in UI) | NO (cancel only sets `refund_due`, `admin-events.ts:580`) |
| 4 | Check-in by scanned code landing page (`CheckinByCodePage.tsx`) | YES `admin-checkin.ts:185,194` |
| 5 | Guest drawer: Download data (JSON) for access requests (`GuestDrawer.tsx:157`) | partial: only token-based `privacy.ts:123`; no admin route |
| 6 | Guests table columns Ticket code, Payment, per-question answers, plus-ones "+n"; copy ticket code (`GuestsTab.tsx:271,295,316,319`) | YES (list returns questions, ticketTypes, answers) |
| 7 | Poll results CSV export (`PollsTab.tsx:145`) | NO |
| 8 | Poll reorder, poll option reorder (`PollsTab.tsx:166`, `PollEditor.tsx`) | poll reorder NO; option reorder client-side |
| 9 | Ticket-type reorder, event-level currency set, "End sales now", Stripe notice (`TicketTypesEditor.tsx:110,116,130,270`) | reorder/currency NO; end-sales via PATCH YES (`admin-events.ts:700`) |
| 10 | Question reorder in editor (`QuestionBuilder.tsx:177`) | YES (part of event PATCH) |
| 11 | Editor: live guest Preview, unsaved-changes restore, leave-without-saving guard (`EventEditorPage.tsx:128,159,299`) | client-only |
| 12 | Branding: logo URL, colour picker + presets, AA contrast report, live preview (`BrandingTab.tsx`) | settings API has brandColor and fontPreset only (`event-settings.ts`); no logo |
| 13 | Analytics: Net revenue and Poll participation KPIs, RSVPs-by-status bars, KPI definitions (`EventAnalyticsTab.tsx:46,66,117`) | NO (not in `admin-analytics.ts`) |
| 14 | Dashboard "Last 30 days vs previous" table (`DashboardPage.tsx:175`) | NO |
| 15 | Share kit QR code + Download QR PNG; presenter QR; poll "Copy vote link" (`ShareKit.tsx:108`, `PresenterPage.tsx:161`, `PollsTab.tsx:128`) | client-only |
| 16 | Events list: cover thumbnail, "Copy link" row action, `?tab=` deep link (`EventRowActions.tsx:34`) | client-only |
| 17 | Invite composer live valid/invalid counts and "Invite up to N" cap message | client-only |
| 18 | "Open this poll? ... closes the other" confirmation; presenter Full screen button | client-only |
| 19 | Route-level role guard (redirect for non-owner/admin) (`RequireRole.tsx`) | server enforces; client lacks guard |

Message resend, reminder-rule editing and guest bulk actions DO have UI (see sections 6 and 8); invite single resend and delete exist in the new UI only.

## 13. Verdict

Counts of comparable rows (sections 1-11, "extra" and out-of-scope rows excluded): see the totals line below (computed from the Status column).

**Matched 39 / Reworded 40 / Partly reworded, partly missing 10 / Missing 20** (109 comparable rows; plus 4 extras that exist only in the new UI, 1 defect row, 3 n/a). Roughly 36% matched, 37% reworded, 27% with something missing.

Top gaps: team management, Stripe integration, refunds-to-finish, scan-code check-in, guest columns and GDPR download, poll export/reorder, ticket reorder/currency, editor preview and unsaved guard, analytics revenue, branding logo/preview. Defect to fix on sight: events list "Edit" opens the hub (`events.tsx:182`); Integrations CSV link 404s (`integrations.tsx:38`); no client route guard.
