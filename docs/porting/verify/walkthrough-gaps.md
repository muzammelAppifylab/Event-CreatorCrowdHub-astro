# Walkthrough gap report (original app vs new app)

Method: static read of the new code against `source-walkthrough.md`. Paths relative to repo root. Legend: P present, R reworded, M missing, X intentionally replaced by the template.
Note: the new portal lives under `/dashboard/*` (not `/admin/*`); public event page is `/events/<slug>/` and `/e/<slug>` 301-redirects to it (`src/pages/e/[slug].astro`).

## Coverage matrix

### Shell, auth, roles
| Original | New | Status |
|---|---|---|
| /login with seeded team, "Dev only" | template account pages `src/pages/account/*` | X |
| Roles owner/admin/checkin_staff, Forbidden screen | abilities + `needs()` guard `src/portal/routes.tsx:91-96` (redirects to `/`, no Forbidden screen) | X/R |
| Staff redirected to `/admin/checkin` on landing | `src/portal/screens/overview.tsx:68-79` shows "Welcome" + "Your account" for a user without `manageEvents`; no redirect to `/checkin` | **M** |
| Sidebar Dashboard/Events/Guests/Settings/Design system, CREATE EVENT button | `routes.tsx:135-163`: Overview, Events, Check-in, Contacts, Event settings, Integrations, Users, Roles, Activity. No sidebar "Create event" CTA (check `events.tsx` header only) | R |
| Workspaces, team members, Stripe Connect | users/roles screens, platform payments (`event-settings.tsx` PaymentsCard) | X |

### Dashboard (overview.tsx)
- "Upcoming events" table (EVENT/WHEN/GOING, "All events" link): P (`overview.tsx:99-117`, columns Event/When/Going/Manage).
- "Last 30 days" METRIC / LAST 30 / PREVIOUS 30 / CHANGE table (RSVPs, Page views, Net revenue): **M**. New shows "Recent RSVPs" (`overview.tsx:125`). API `src/server/routes/admin-overview.ts` has no 30-day comparison.

### Events list (events.tsx)
- Upcoming/Past/Drafts tabs, empty states, status/visibility/going columns: P. Header lead text and empty copy reworded (`events.tsx` EMPTY_TITLE).
- Sortable EVENT/DATE/GOING headers: M (cosmetic; search box instead, `events.tsx:224`).
- Row menu: original Open/Edit/Duplicate/Copy link/Cancel/Publish/Delete draft. New (`events.tsx:185-197`): Open event hub, Guests, Edit, Publish/Unpublish, Duplicate, View public page, Cancel event, Delete draft. "Copy link" M in list (exists in hub). Extra: Unpublish.
- Duplicate dialog: P (fields "Title of the copy", Starts, Ends; toast "Copy saved as a draft"). Hub duplicate (`event-hub-actions.tsx:46`) uses label "Title" and default "Copy of X" (R).
- Cancel dialog with counts (guests to email / refunds): P (`events.tsx:89-113`, cancel-preview). Delete draft: P.

### Editor (event-editor.tsx), the 8 sections
| Section / field | New | Status |
|---|---|---|
| Header: "Back to events", "New event"/"Edit event", status badge | `event-editor.tsx:366-398` | P |
| New: SAVE DRAFT + PUBLISH | only "Save draft" for new (`:392-396`); Publish/Unpublish only when `event` exists | **M (Publish on new)** |
| Edit: "Preview" toggle + SAVE CHANGES | Form/Preview toggle `:356`, "Save changes" | P |
| "Saving…/Saved", "Fix N fields before saving." | `Notice "Fix these first"` `:415`; no "Saved" indicator | R |
| Restored-changes note + "Discard changes" | none (`use-unsaved-guard.ts` only guards navigation) | M (low) |
| Leave guard "Leave without saving?" | `use-unsaved-guard.ts` | P |
| Cancelled "can't be edited" | `:412` | P |
| Section nav (8 anchors) | `EDITOR_SECTIONS`, `:398`; Cover is a 9th section | P |
| Live "GUEST PREVIEW" card | `event-editor-preview.tsx` | P |
| 1 Details: Title | `:426` (no placeholder "Pricing Q&A with Clara") | P |
| Link/slug: follows title until edited, "Changing it breaks links you've already shared." | `:429` hint "The public page is /e/<slug>. Leave it blank to make one from the title."; no live follow, no break-links warning | R/M |
| Description hint "Plain text for now..." | `:432` "Shown on the event page. Leave a blank line between paragraphs." | R |
| Cover: 6 poster radio cards + "Use your own image instead" | `:446` poster is a plain Select ("Automatic"+designs); `:442` "Cover image link" always shown | R (cosmetic/UX) |
| "Make it yours": 9 colour swatches | `:449` Select "Poster colours" | R |
| Headline / Top line / Bottom line | `:454-461` "Poster headline", "Poster eyebrow", "Poster footer"; hint "Blank uses the title." only; no "Defaults to the date and time" / venue hints | R |
| 2 Location: format toggle, venue name, address, map link, join link (+ hints) | `:468-497` (Venue address is a textarea; map link hint missing: "Optional. A Google or Apple Maps link.") | P/R |
| 3 Date & time: Starts/Ends date+time, timezone, RSVP deadline, "Remove deadline" | `:501-523` uses `datetime-local`; no "Remove deadline" button (clear field instead); hint "Guests can't RSVP after this. Blank means until the event starts." vs "Optional. RSVPs close at this time." | R |
| 4 Capacity & RSVP: capacity, plus-ones 0-5, 4 switches, visibility cards | `:527-555`: all present; plus-ones is a number input; labels "Approve guests"/"Show the guest list"/"Allow “Maybe”" vs "Approve each guest"/"Show guest list". Extra: "Thank-you link" | P/R |
| Visibility copy ("Private: ... This event is invite-only") | `VISIBILITY_INFO` | P (text not compared) |
| 5 Questions: add (limit 10), label, type (5 types), options list, required, move, remove | `:557-595`: types per `QUESTION_TYPES`; options as one-per-line textarea (hint "One per line, at least two.") instead of Option N inputs; drag handle M, MoveButtons P; question label "Question N" vs "Question" | R |
| 6 Tickets: currency per event, add inline form, Stripe banner | `Tickets` `:640-740`: modal (Name, Price, Currency locked after first, Seats, Sales end), reorder, delete; Stripe banner X | R |
| 7 Reminders (saved): full rules UI | `:606-611` only a muted sentence pointing at hub Messages | **M** |
| 8 Polls (saved): full polls UI | `:611-614` only a muted sentence | **M** |

### Hub (event-hub.tsx, event-tabs.ts)
- Header: title, Copy link, Edit, Duplicate, Cancel, badges (status, visibility, format), "All events", draft/cancelled notes: P (`event-hub.tsx:115-160`; extra "View public page"; no poster eyebrow line). Copy link copies `/events/<slug>/` (original `/e/<slug>`; both resolve).
- 7 tabs Overview/Guests/Invites/Messages/Polls/Check-in/Analytics, `?tab=` initial read: P (`event-tabs.ts:12-21`). Note: tab change uses `replaceState` and URL tab only read on first mount.
- Overview tiles Going/Maybe/Waitlisted/Pending/Seats taken: P (`event-hub.tsx:57-62`). Details: When shows ONE time string (no viewer-local + event-time two-line, `eventWhen` en-GB short) R; WHERE, PUBLIC LINK, JOIN LINK, POLL JOIN CODE: P. Extra Summary + RefundsCard.

### Guests tab (guests.tsx)
- Search, status filter (All/Confirmed/Pending/Waitlisted/Awaiting payment/Declined/Cancelled via `STATUS_LABELS`), "Checked in" toggle, EXPORT CSV, ticket-type filter (extra): P. Export uses fetch download + toast.
- Table: Guest, Status, Response, Seats, Ticket (type name, original showed TICKET CODE column + CHECKED IN), Code, Payment, per-question columns, Checked in: P (more columns than original).
- "#8 in line" under waitlisted badge: verify `guests.tsx:224-231` (assumed P).
- Pager "Page 1 of 2": R, replaced by `LoadMore` (`guests.tsx:383`). Column sort headers: M (cosmetic).
- Bulk bar APPROVE/DECLINE/PROMOTE/REMOVE/ERASE with confirms: P (`guests.tsx:79-110, 334-353`; Erase labelled "Erase personal data"). Select-all checkbox label "Select every guest shown" (R).
- Drawer: name/email/status; edit form (name, email, plus-ones, marketing consent - extra); Details: Response, Seats, Ticket, Payment, Source, Checked in, Waitlist position: P. **M: Ticket code with "Copy code" (toast "Ticket code copied")**; **M: Marketing consent Yes/No read-only line shown as checkbox only (R)**; **M: "Attended online" (Not recorded/Yes/No)** though `attended` is returned by `admin-guests.ts:215`. Answers, Timeline, Download data (JSON), Remove, Approve/Decline/Promote: P. Extra: Check in / Undo check-in.

### Invites tab (invites.tsx) and Share kit
- Invite form: modal "Invite people" with textarea "Emails" (hint "Up to 200 people at a time.") vs inline "Invite guests" + "Email addresses" + live "N valid / N invalid" counters: R, counters M (`invites.tsx:250-278`).
- "Invited · N", RESEND TO N NON-RESPONDERS (with confirm), per-row Copy link / Send again / Delete invite, empty state: P/R.
- Share kit (`invites.tsx:286-336`): Event link + COPY LINK, Share to X/LinkedIn/WhatsApp/Facebook (`SHARE_LABELS`), QR + "Download QR (PNG)", embed textarea + "Copy embed code": P. Card title "Share kit" vs "Share"; embed hint reworded.

### Messages tab (messages.tsx)
- Broadcast: card "Send a message" (orig "Email your guests"); "Send to" 7 segments with counts via `SEGMENT_LABELS`: P (labels identical); Subject, Message: P; merge-tag insert buttons (`:65-73`) as a button row, not an "INSERT TAG" menu; tag token set must be checked in `MERGE_TAGS` (guest.first_name, guest.name, event.title, event.start_local, event.join_url, event.venue, rsvp.manage_url, poll.join_url): assumed P. Preview opens a modal "Email preview" (orig inline toggle "Hide preview") R. Confirm dialog before send: P (`:168`). No-show hint "counted once the event has ended": P (`:179`). Sent log: "Message log" with Message/Delivered/Sent (orig SUBJECT/SENT TO/DELIVERED/SENT; "To <segment>" under subject) R; empty "Nothing sent yet" vs "No messages sent yet".
- Automatic emails: card "Automatic emails", same description P. Columns Email/When/Status/Actions. Kinds: Confirmation, Reminder, We’re live, Thank you (`REMINDER_KIND_LABELS`) P. Orig dropdown "Add an automatic email" with 3 types P (confirmation also, disabled when exists). Offset editor: "Amount" + "Unit" (Minutes/Hours/Days) with summary (`describeOffset`), live_now has Before/After; orig "When" number+unit "before the start" R. Subject/Message, Preview, Save: P. On/Off switch P. **M: "Delete" exists; orig had none (extra)**. Sample guest preview "Shown with a sample guest" P. Thank-you offset default 120 min vs orig 4 hours after end (data difference, `event-schemas.ts DEFAULT_RULE_COPY`); default seeded rule set is `[]` in `DEFAULT_EVENT_SETTINGS` (event-schemas.ts) so new events start with NO automatic emails unless settings saved - verify server seeds.

### Polls tab (polls.tsx, poll-presenter.tsx)
- Question, 4 types (Single/Multiple/Rating/Short text via `POLL_TYPE_LABELS`), options 2-10 with remove, Anonymous (desc "Votes are never linked to a guest." vs "Off: the CSV export includes guest emails"), Show results to voters (desc reworded): P/R (`polls.tsx:248-338`). Add/Save labels "Add poll"/"Save changes" (orig "Save poll").
- List: Order (move buttons), Question, Status, Answers; row Menu: Open/Close/Reopen, Edit+Delete for drafts only (orig: unopened), Export CSV per poll: R. Orig had "N votes · Anonymous|Named" subtitle: R.
- **M: "Join code CZ2-BXC" display with hyphen + "COPY VOTE LINK"** (new shows `host/p/<code>` text only, `polls.tsx:192-200`).
- **M: event-level "EXPORT CSV"** (`/events/:id/polls/export.csv`); new has only per-poll `/polls/:pollId/results.csv` (`admin-polls.ts:294`) in closed/open row menu.
- **M: "Open this poll?" confirm when another is live** (`polls.tsx:170` calls `act.mutate` directly; server auto-closes the other, `admin-polls.ts:31`).
- Presenter (`poll-presenter.tsx`): keys O/C/F/ArrowRight, QR, code, "How to join": P. Route `/polls/$code/present` (orig `/p/:code/present`).
- Public vote page `/p/:code` (`src/pages/p/[code].astro`, `src/lib/poll-client.ts`): P with reworded copy ("Send answer", "Change answer", "This poll is closed.").

### Check-in
- Event list `/checkin` (new: pick event table "Open door list") vs orig empty "No event selected": X/P.
- Door list `/checkin/$eventId`: search by name or ticket code, ticket-code field with Check in, guest rows with Check in / Undo, counts, export (`checkin-event.tsx`): P (more than orig). Toasts "<name> checked in." / "Check-in undone for <name>." P. "Back to event" for non-staff: verify (not found in grep, likely P).
- By code `/checkin/code/$code`: P; message "That guest isn't confirmed, so they can't be checked in." (orig "<name> isn't confirmed ... Ask the host before letting them in."), "Ticket not found" P, "Door list" link P.
- Door-staff view (names + codes only): enforced by `canManage` in `admin-checkin.ts`; P.
- Hub Check-in tab: counts, "Open door screen", Online attendance (CSV match + mark by hand): P (`checkin-tab.tsx`, `checkin-event.tsx:320-409`). Orig had pager for by-hand list: unknown.

### Analytics (event-analytics.tsx)
- KPI tiles Views, RSVPs, Conversion, Show rate, Revenue, Poll participation: P (orig "Net revenue", help "What does X mean?" buttons M; hint copy differs). Views chart: Sparkline + BarChart "Page views per day" P. Top sources table (Source/Views/RSVPs; **M: Conversion column**; "Direct or shared link" vs "Direct or no tag"): R. **M: "RSVPs by status" breakdown** (Going/Maybe/Waitlisted % table) on the analytics tab. Footer "Updated .. Days counted in UTC" M.

### Settings (event-settings.tsx, integrations.tsx)
Single page `/event-settings` with tabs `branding | defaults | payments` (`event-settings.tsx:75`), plus separate `/integrations` (webhooks).
- Branding: Brand colour = hex input only (orig: 6 presets, native picker, "Reset to ink", contrast pass/fail lines, invalid msg "Use a 6-digit hex code, like #4F46E5"); Font: 3 RadioCards (`FONT_PRESETS`, default 'inter'; orig Grotesk/Serif/Rounded); default cover PosterPicker (orig lived under Defaults); Logo: upload card `event-settings.tsx:411` (orig Logo URL field); live BrandPreview P. Buttons "Save branding" (orig global SAVE CHANGES + Undo changes; new has "Reset to default"). Missing: contrast ratio lines, presets, colour picker (**M, medium**).
- Defaults: Timezone P; sender name P ("Email sender name"/ hint "Guests see this as the sender." vs "Sender name"); Reply-to P; Allow Maybe / Show guest list P; "Default emails" editor: per-rule block with Kind, **raw "Minutes from the start" number input**, Subject, Message, "Send this email" checkbox, Add dropdown, max `MAX_DEFAULT_REMINDER_RULES` (orig: toggle chips 1 week / 3 days / 24 hours / 3 hours / 1 hour / 15 min + 3 switches Confirmation / We're live / Thank you) - R, functionally richer but much less friendly (**gap: minutes input**).
- Team tab: X (users/roles screens `users.tsx`, `roles.tsx`; invite, role select, remove).
- Integrations tab Stripe card, env vars, webhook URL, TEST CONNECTION: X (payments are platform's; `PaymentsCard` lists tickets/orders).
- Webhooks (`integrations.tsx`): endpoint add form (Receiver URL; hint "A public https:// address..."; orig "Endpoint URL / Must start with https://"), 7 events with identical labels (`webhooks-queries.ts:12-18`), signing secret shown once, list with status/actions: P. Signature header text (X-Ezy-Signature) should be documented in the card description - not verified.

### Contacts (contacts.tsx)
- Search, table Contact / Events / Last event (link to hub) / Marketing (Opted in/No consent), Export CSV: P. Title "Contacts" P. **R/gap: default filter is `consent: 'yes'` ("Opted in", `contacts.tsx:32`) so by default only consenting contacts show; orig shows all (95)**. Segmented "Everyone/Opted in" control present. Sortable headers and pager M (LoadMore).

### Public pages (src/pages, src/components)
- Event page: poster hero, chips, title, "Hosted by", date/time blocks, countdown phases, location with maps button, about, "More events by <host>" link, cancelled banner, invite-only: P (`EventView.astro`). Shared with `/i/<token>/`.
- **M: "Who's going" block** (initials, "+N more going", "N going"): no code in `EventView.astro`/server exposes first names; the editor's "Show the guest list" switch (`event-editor.tsx:350`) and RSVP-form first-name consent (`RsvpForm.astro`) have no public effect. User-visible dead setting.
- RSVP form: honeypot (`website`, labelled "Leave this empty"), going/maybe/not going (maybe gated by `allowMaybe`), plus-ones select, tickets, questions, marketing consent: P. **M: "I'm happy for my first name to appear on the guest list" checkbox** (grep: no match in `RsvpForm.astro`).
- `/r/[token]` confirmation + manage (`src/pages/r/[token].astro`): state headlines via `statusCopy`, ticket card + QR (QR encodes `/dashboard/checkin/code/<code>`), .ics + Google Calendar, join link card, summary, answers, cancel: P.
- `/host` (`src/pages/host/index.astro`): single-site host page, upcoming + past details, "load more" : P (orig `/host/:workspaceId`: X).
- `/i/[token]` invite landing P; `/sitemap.xml`, `/robots.txt` P; error screens 404/500 P (`ErrorScreen.astro`).
- Skip link / "Powered by" footer: not checked.

## (1) Ranked REAL gaps, grouped by owning file

### Block A: `src/portal/screens/event-editor.tsx` (+ new small component)
1. **Editor Reminders section is a stub for saved events** (`:606-611`): embed the automatic-emails card. Fix: extract the rules card from `messages.tsx` into an exported `AutomaticEmails({eventId})` (coordinate with Block C) and render it in `sec-reminders` when `event` exists.
2. **Editor Polls section is a stub** (`:611-614`): render `<Polls eventId={event.id} />` (already exported from `polls.tsx:57`).
3. **New-event "Publish" button missing** (`:384-396`): add a second submit that saves then publishes (use existing `setStatus` after `save`).
4. Slug field lacks "follows the title until edited" behaviour and the "Changing it breaks links you've already shared." warning on published events (`:429`).
5. Cover picker is two selects: replace poster Select (`:446`) with radio cards (reuse `PosterPicker` from `branding-preview.tsx:40`) and the palette Select with swatches. Cosmetic-leaning but user-visible.
6. Add helper texts missing on poster headline/eyebrow/footer, map link hint, "Remove deadline" button, "Saved" indicator, restored-draft "Discard changes".

### Block B: `src/components/EventView.astro`, `src/components/rsvp/RsvpForm.astro`, `src/server/routes/events.ts` (+ `src/lib/rsvp-types.ts`)
7. **"Who's going" public block and first-name guest-list consent are missing**; the editor's "Show the guest list" flag does nothing. Fix: expose first names of consenting confirmed guests (only when `showGuestList`) from `events.ts`, render the block in `EventView.astro` ("N going" + initials + "+N more"), add the consent checkbox and field to `RsvpForm.astro`/`rsvp-types.ts`/`rsvp.ts`.

### Block C: `src/portal/screens/polls.tsx` (+ `src/server/routes/admin-polls.ts`, `src/portal/polls-queries.ts`)
8. No COPY VOTE LINK / hyphenated join code display (`polls.tsx:188-200`): add button copying `${origin}/p/<code>` and show `CZ2-BXC` formatting.
9. No event-level poll results CSV export: add `GET /event/:eventId/export.csv` in `admin-polls.ts` and an "Export CSV" link in the toolbar.
10. Opening a poll while another is live gives no confirm (`polls.tsx:170`): wrap `act.mutate({action:'open'})` in `confirm()` when another poll has `status==='open'`.

### Block D: `src/portal/screens/overview.tsx` + `src/server/routes/admin-overview.ts` + `src/portal/routes.tsx`
11. **Role landing**: check-in-only users land on a "Welcome / Your account" page (`overview.tsx:68-79`). Fix: in `overviewRoute` add `beforeLoad` redirect to `/checkin` when `abilities.checkinGuests && !abilities.manageEvents` (`routes.tsx:385`).
12. **"Last 30 days" metrics card missing** (RSVPs, Page views, Net revenue vs previous 30 days with change): add to `admin-overview.ts` (use the pageview and RSVP/orders tables) and a card in `overview.tsx`.

### Block E: `src/portal/screens/guests.tsx` (+ `src/server/routes/admin-guests.ts` if needed)
13. Guest drawer lacks Ticket code with "Copy code", read-only "Marketing consent: Yes/No" and "Attended online" lines (`guests.tsx:498-507`): add rows (`guest.ticketCode`, `guest.attended` already returned by `admin-guests.ts:215`).

### Block F: `src/portal/screens/event-settings.tsx`
14. Default-emails editor takes raw minutes (`:263`): replace with the original's toggle chips (1 week/3 days/24 h/3 h/1 h/15 min) for reminders plus on/off switches for Confirmation / We're live / Thank you, mapping to `defaultReminderRules`.
15. Brand colour: add presets, native colour picker, "Reset to ink", and WCAG contrast pass/fail lines (`:147`); show validation text "Use a 6-digit hex code, like #4F46E5".

### Block G: `src/portal/screens/contacts.tsx`
16. Default filter hides non-consenting contacts (`:32`): default to `consent: ''` (Everyone), keep Opted-in as a filter.

### Block H: `src/portal/screens/event-analytics.tsx` (+ `admin-analytics.ts`)
17. Add "RSVPs by status" breakdown (Going/Maybe/Waitlisted with %), source Conversion column, KPI help text, "Updated at" footer.

### Block I: `src/portal/screens/invites.tsx`
18. Add live "N valid / N invalid" counters to the invite textarea (`:277`), and "Invited · N" heading (low).

### Not verified (could not confirm statically)
- Merge-tag list content/labels in `messages.tsx` (`MERGE_TAGS` source), waitlist "#N in line" text in guest table, "Back to event" on door screen for managers, thank-you default offset (120 min vs original 4 h after end), whether new events are seeded with the default reminder rules (`DEFAULT_EVENT_SETTINGS.defaultReminderRules` is `[]`).

## (2) Cosmetic differences
- Route prefix `/dashboard` (not `/admin`); presenter at `/polls/$code/present` (not `/p/:code/present`); public event at `/events/<slug>/`.
- Labels: "Contacts" (orig nav "Guests"), "Event settings"/"Payments" tab, "Send a message" vs "Email your guests", "Message log" vs "Sent messages", "Share kit" vs "Share", "Save draft"/"Save changes" case, "Approve guests" vs "Approve each guest", "Show the guest list" vs "Show guest list", "Poster eyebrow/footer" vs "Top line/Bottom line", "Receiver URL" vs "Endpoint URL", "Email sender name" vs "Sender name", "Erase personal data" vs "ERASE", "Open door screen" same, "Presenter view" vs "OPEN PRESENTER VIEW", "Save changes" vs "Save poll".
- Pagination replaced by LoadMore across guests/contacts/invites; no sortable column headers.
- Dialogs/sheets: modal vs inline (invites form, ticket form, email preview modal vs inline preview, Option N inputs vs one-per-line textarea for question options, no drag handles).
- Date inputs use `datetime-local` instead of date picker + time input; plus-ones is a number input not select.
- Overview "Recent RSVPs" instead of 30-day table; Hub details shows single time (no viewer-local + event-time pair).
- Door-screen wording and event picker list (`/checkin`) instead of "No event selected" empty state.
- Forbidden screen replaced by redirect to overview.
- Extra (new-only): Unpublish, ticket-type filter, Payment column, Refunds cards, Activity log, Components page, thank-you link field.

## Fixed (parity pass)
- Item 17 (analytics): "RSVPs by status" card (Going/Maybe/Waitlisted with %), source Conversion column, `waitlisted` added to the analytics API. "Updated at" footer already existed. KPI help buttons skipped (cosmetic).
- Item 18 (invites): live "N valid / N invalid" counters in the paste box; card title "Share kit" now "Share".
- Skipped: integrations.tsx ("Endpoint URL" label; another session owns it), check-in wording (already equivalent), messages.tsx label renames (intentional rewording).

## Needs schema
- None found in this pass.

## Needs schema
- Per-guest "Show my first name on the guest list" consent: the original has NO such column or checkbox (only a seed custom question); the host's `showGuestList` switch is the consent and the public list shows first names of confirmed, going guests. Ported that way (`src/lib/guest-list.ts`, `buildView` in `rsvp.ts`). For per-guest opt-in: add `Rsvp.showFirstName Boolean @default(false) @map("show_first_name")` (+ migration), a checkbox in `RsvpForm.astro`, and filter on it in `buildView`.
