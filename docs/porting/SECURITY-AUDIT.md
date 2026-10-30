# Security audit: events port (src/server/*, guest pages, emails)

Read-only review, 2026-10-30. Scope: everything new under `src/server/` (routes, privacy, webhooks,
ticket-checkout, payments-hooks, jobs, mailer, guest-mail, csv), `src/pages/{events,e,r,i,p,privacy,host}`,
`src/lib/poll-client.ts`, `src/components/rsvp/*`, `src/emails/*`. Checked against `docs/agent/security.md`,
`site-api.md`, `auth.md`, `roles-and-permissions.md`. Only issues confirmed by reading the code are listed.
The tree was being edited while I read (for example `src/pages/e/` appeared mid-audit), so line numbers are as of the read.
H1 was traced by hand through `place()`; I could not execute it (the vitest harness only includes repo paths and I did not add files).

Severity: High = money, access control or data exposure with a simple exploit; Medium = abuse, compliance or
integrity gaps; Low = hardening.

---

## HIGH

### H1. A paid seat can be obtained without paying (Maybe, then Going)
`src/server/routes/rsvp.ts:311-315` (maybe branch), `:382` (paid guard), `:527` (ticket stored on create), `:565` (kept on edit).

`place()` returns early for `response: 'maybe'` with `status: 'confirmed'` before any ticket, payment or approval
logic, and `submitRsvp` stores the client-chosen `ticketTypeId` regardless (validated only as "belongs to the event").
The "awaiting payment" gate at line 382 is `paid && placement.status === 'confirmed' && current?.status !== 'confirmed'`.
A Maybe guest is already `confirmed`, so a later switch to Going slips through that guard.

Exploit (no account):
1. `POST /site-api/rsvp/events/:slug` with `{name, email, response:'maybe', ticketTypeId:<PAID ticket id>}` gives 201, `confirmed`.
2. Open the returned `/r/<token>/` and `PATCH /site-api/rsvp/manage/<token>` with `response:'going'` (the ticket is kept from the row).
   `holder` is false (response was maybe), `settled` is null, `decideSeat` says confirm, the guard at 382 is skipped.
   Result: `status: confirmed, response: going`, seats held, ticket code, QR and join link, with no `ticket_orders` row and no payment.

Fix: in `place()` gate on whether the guest really holds a seat: `if (paid && placement.status === 'confirmed' && !(holder && current?.status === 'confirmed')) return AWAITING;`.
Also refuse (store `null`) a `ticketTypeId` on a Maybe or not-going create, and add a unit test: confirmed maybe on a paid ticket -> going must be `awaiting_payment`.

### H2. The private join link is public: `GET /site-api/events/:slug`
`src/server/routes/events.ts:79` selects `joinUrl: true` and returns it to anonymous callers for any published public or unlisted event.
The page does not render it, but the API is open (`curl /site-api/events/<slug>`). `GET /rsvp/events/:slug` and the manage route gate it
correctly (`rsvp.ts:904`: confirmed and going), so only this route leaks.
Impact: online paid, approval-only or capped events can be joined for free. Related: `src/lib/seo.ts:165` falls back to `event.joinUrl` in the public
JSON-LD when `absoluteUrl()` returns null (no `siteUrl` configured), which would print it into indexable HTML.
Fix: drop `joinUrl` from the public select (and consider `venueAddress` for unlisted events); never pass `joinUrl` to `eventJsonLd`.

### H3. "Maybe" guests are treated as confirmed attendees (join link, door admission, approval and capacity bypass)
- `src/emails/context.ts:11` `canSeeJoinLink` is `status === 'confirmed'` only. A Maybe is `confirmed` (`rsvp.ts:314`), so the confirmation email,
  reminders, "live now" and the `{{event.join_url}}` merge tag deliver the join link even when the event needs approval, is full, or sells paid
  tickets (Maybe skips all of those checks, `rsvp.ts:311`).
- `rsvp.ts:914` returns `ticketCode` for every status on `GET /manage/:token`; `src/server/routes/admin-checkin.ts:206` accepts any `confirmed` guest
  (not only `going`) and the door list (`:176`) shows them without their response. A Maybe on a paid or approval-only in-person event can read the code
  from the JSON and be checked in. `doorCounts` counts only going as expected, so the mismatch is invisible.
Fix: `canSeeJoinLink` and `showsTicket` require `response === 'going'`; check-in requires `response === 'going'`; the manage API returns `ticketCode`
only for going and confirmed; or make Maybe respect approval (use `pending`, not `confirmed`, on approval events).

### H4. Invite links cannot work, and invite tokens are stored in clear text
- `src/server/routes/rsvp.ts:105`: `INVITE_RE = /^[w.-]{8,600}$/` is missing the backslash, so `[w.-]` matches only `w`, `.` and `-`.
  A real signed invite (`<b64url>.<b64url>`, 203 chars; checked with node, regex returns false) is rejected by `inviteParam` (`GET /invite/:token` is always 404),
  by `liveInvite` (private events can never be unlocked) and so by the `/i/<token>` page. `inviteQuery` (`:747`) also truncates `?invite=` to 128 chars, shorter than a token.
  This fails closed (no exposure) but the whole invite and private-event flow is dead.
- `src/server/routes/admin-invites.ts:287-291` stores the raw token in `invites.token` (unique, clear text). `docs/agent/security.md` A04 says share-link
  tokens are random, hashed at rest and revocable. A database or backup leak hands out working RSVP links (and private-event access); the admin list and
  `/rsvp/invite/:token` echo it back. The token is an HMAC over ids, never expires, and is keyed with the raw `jwtSecret` (see L5).
Fix: `INVITE_RE = /^[\w.-]{8,600}$/` and raise the query slice to 600. Better: `newToken()` (32 random bytes) stored as sha256 and looked up by hash,
raw token only in the email link.

---

## MEDIUM

### M1. Public mutation endpoints are rate limited only per Worker isolate (and they hold seats / send email)
`src/server/routes/rsvp.ts:114-129` (in-memory `hits` Map) guards `POST /events/:slug`, `POST /events/:slug/manage-link` and `PATCH /manage/:token`;
`src/server/routes/pageviews.ts:62-63` is the same idea. Isolates are many and short lived, so 10/min/IP is advisory. `POST /manage/:token/cancel`
and the GET routes have none (`event-checkout` is token gated and capped per RSVP in the database, which is good).
Exploits: (a) bots fill capacity with fake confirmed RSVPs (no email verification, only a honeypot); (b) on paid events each fake RSVP holds seats as
`awaiting_payment` for `checkoutHoldMinutes` (30) and calls the platform (`createPrice`/`createCheckout`) per request, enough to lock out an event;
(c) confirmation emails to arbitrary addresses (mail bombing, sender reputation); `EMAIL_CAP` is also per isolate (`rsvp.ts:129,700`).
Fix: use the database-backed limiter that the privacy and poll routes already use (`attempt(ctx, kind, keysFor(...))`), per IP and per (event, email); cap
concurrent holds per IP/email; add Turnstile or an email-confirm step before seating (at least for capped and paid events).

### M2. RSVP existence oracle, victim-address side effects, and manage-token rotation by strangers
`rsvp.ts:806-808,844` (202 `check_email` for an existing email, 201 with `managePath` for a new one), `:698-704` and `src/server/claim-mail.ts:248-252` (rotation).
- Anyone can learn whether an email RSVP'd to an event (202 vs 201); when it has not, an RSVP is created in the victim's name and the victim is emailed.
- `mailManageLink` rotates the stored token on every re-submit or "lost link" request for that email (3 per hour per isolate). A stranger who knows an address
  can kill the guest's current link, which also kills the unsubscribe and erase links in their earlier emails (they use the manage token). Waitlist-offer
  job retries rotate again (`claim-mail.ts`), so a failed send can leave a guest with no working link.
Fix: answer the same 202 for new and existing emails (email the link in both cases; seat a new guest only after the email click), and stop rotating on
resend: derive the token as `HMAC(secret, rsvpId || tokenVersion)` so the same link can be re-sent; bump `tokenVersion` only on erase.

### M3. In-process page calls share one IP bucket: privacy and unsubscribe pages can be locked out for everyone
`src/pages/privacy/{consent,guest,unsubscribe}/[token].astro:17` call `app.request(...)` without `cf-connecting-ip`; `clientIp()` (`platform/auth/kit.ts:43`)
then returns `'local'` for every visitor. `routes/privacy.ts:52-56` takes an attempt on every GET first (120 per 10 min per IP, then 10 s doubling to 10 min).
A script requesting `/privacy/unsubscribe/<anything>` 120 times locks the SSR pages for all guests (they see "not valid" with HTTP 503), and the form
that does the real POST never renders.
Fix: forward `cf-connecting-ip` into the in-process request, or call the domain functions directly in the page, or skip the limiter for the page's read.

### M4. Marketing-consent and retention promises are not implemented
- `sendConsentEmail` (`src/server/consent-mail.ts`) has no caller and `rsvp.ts:683` sets `consentUrl: null`: a ticked consent box can never be confirmed (safe for
  sending, but the double opt-in does nothing).
- `unsubscribeUrl` and `guestPrivacyUrl` (`src/server/privacy.ts`) have no caller; no email template has an unsubscribe or privacy link, although `/privacy/`
  says "Every update has an unsubscribe link". Guests also have no path to `/privacy/guest/<token>` (the manage page `/r/<token>/` does not link to it).
- `expiredGuestIds` / `eraseRsvp` retention (`privacy.ts:269-285`) is never scheduled (`src/server/background.ts`, `background.json`): data is kept forever,
  contrary to the two-year text.
- `admin-messages.ts:35-37,417-506`: broadcasts go to every active guest regardless of `marketingConsent` or unsubscribe, with no opt-out link.
Fix: send the consent email after create/update when the box is ticked; add unsubscribe and "your data" links to every guest email footer; add a daily
retention job; decide and document the broadcast rule (at minimum an opt-out link, and honour unsubscribe).

### M5. Sensitive admin actions are not audited
Only event publish/unpublish/cancel/delete and settings changes call `audit()` (`admin-events.ts:536-645`, `event-settings.ts:97`). Missing (`security.md` A09:
"personal-data exports need an audit event"): guest CSV export (`admin-guests.ts:630`), contacts CSV export (`:784`), bulk remove/erase and single delete
(`:661`, `:740`), invite create/resend/delete (`admin-invites.ts`), broadcasts (only `messages.sent_by`), webhook endpoint create/update/delete/test
(`admin-webhooks.ts`), attendance import. Add `audit(db, {actorUserId, action, target, meta: {count}})`.

### M6. Event cancellation and guest cancel/erase do not flag paid orders for refund
`eventCancelHooks` (`admin-events.ts:67,580`) has no registered hook and `markEventOrdersRefundDue` (`ticket-checkout.ts:236`) is never called: `cancel-preview`
promises refunds, guests are not emailed, paid orders stay `paid`. Likewise guest `POST /manage/:token/cancel` (`rsvp.ts:960`), a PATCH to `not_going` and a
privacy erase free a paid seat and leave the order `paid` with no `refund_due` signal. Money is kept silently (business and consumer-law risk more than an exploit).
Fix: register the hook (mark `refund_due`, queue guest emails); decide the policy for guest cancel and mark `refund_due` accordingly.

### M7. Polls: unthrottled code lookups, draft/cancelled events, weak vote integrity
`polls-public.ts:231,315` (`/active`, `/results`) have no rate limit. Join codes are 6 chars (about 31^6 = 887M) and `eventByCode` (`:216-220`) ignores event status,
so polls of draft, unpublished or cancelled events (title, question, options, and free-text answers when results are shown) are reachable by anyone with or guessing
the code. Votes are keyed by a client cookie (`:196-208`), so clearing cookies gives unlimited votes within 600 per 10 min per IP (`:36-38`): fine for a room poll,
not for anything that matters.
Fix: rate-limit reads per IP (database limiter), require `event.status = 'published'` in `eventByCode`, and say clearly that polls are not tamper-proof (or bind votes to a ticket code).

### M8. The manage token is sent to the payment platform
`src/server/app.ts:39`: `cancelPath: /r/${manageToken}/` is passed to `createCheckout` (`ticket-checkout.ts:115`); the raw credential then sits in the platform's checkout
record and in the cancel redirect URL (and browser history). Use a cancel path without the token (for example `/events/<slug>/`) and let the guest return via the emailed link.
(The default `cancelPath` `/e/<slug>/` works through the new redirect page.)

---

## LOW / hardening

- **L1. Broken `</script>` escape on the poll page.** `src/pages/p/[code].astro:36` uses `.replace(/</g, '<')`; in JS source that is the character `<` itself, a no-op
  (verified with node: the output still contains `</script>`). `src/lib/seo.ts:39` does it correctly (`'\\u003c'`). `initial` holds host text (event title, question, options) plus the
  visitor's own vote, and CSP blocks an injected script, so the impact is HTML injection by a host or insider. Fix: `'\\u003c'`, plus `>`, `&`, U+2028/9.
- **L2. `http:` URLs are accepted** for `mapUrl`, `joinUrl`, `thankYouLink`, `coverImageUrl` (`src/lib/event-schemas.ts:164-171`) and rendered as links in pages and emails.
  `security.md` A04/A05 say https only. `javascript:` and `data:` are correctly rejected.
- **L3. Webhook SSRF relies on platform egress filtering.** `webhook-delivery.ts:447-467` blocks IP literals, single-label and private-suffix names, requires https on 443, and never
  follows redirects (good), but a public DNS name that resolves to a private address (nip.io style) passes and there is no DNS pinning. The platform answers 403 for internal egress per the
  docs, so this is defence in depth. Payloads are ids only (`webhook-emit.ts`). Secrets are stored in clear (needed for HMAC); only the last 4 characters are returned.
- **L4. Small oracles and indexing.** `pageviews.ts:70-79` answers 204 for any non-draft slug (including `private` events) and 404 for unknown ones: private event slug enumeration.
  `rsvp.ts:126` `clientIp` falls back to `x-forwarded-for` (spoofable off Cloudflare; `pageviews.ts` refuses it). `/events/[slug].astro` sets no `noindex` for `unlisted` events (only the API sets `X-Robots-Tag`).
- **L5. Signing key reuse.** Invites, consent tokens and the page-view salt use the raw `config.jwtSecret` as the HMAC key (`admin-invites.ts:287`, `privacy.ts consentToken`, `pageviews.ts:36`).
  The purpose is inside the signed body (good), but derive per-purpose keys (HKDF) so a bug in one use does not affect auth. Consent and invite tokens are neither single-use nor rotating
  (consent only confirms an already ticked box and is idempotent, so that is safe).
- **L6. PII in logs.** `app.ts:129` logs `err.message`; Prisma validation errors can embed the query arguments (names, emails). `jobs/shared.ts errorText` stores up to 500 chars of such a message in
  `message_deliveries.error`; `payments-hooks` and `routes/checkout.ts:572` log messages too. Log a fixed string or the Prisma `code`.
- **L7. Guard-order notes.** `admin-events.ts:410` and `admin-webhooks.ts:328` use `.use('*', withViewer, requireAuth, requirePermission, withDb)` before per-route validators (the reverse of the documented
  order). It is safe (auth first) but inconsistent; the other admin files use validator-first per route. `poll-client.ts:196,205` uses plain `fetch` for same-origin GETs (docs prefer `siteFetch`; matters only in the editor Preview).
- **L8. Heavy reads (all capped):** broadcast and segments read up to 20,000 RSVPs (`admin-messages.ts:390,442`); the contacts export aggregates every RSVP (`admin-guests.ts:594`); poll results read up to
  20,000 votes per isolate per second (`polls-public.ts:27,154`); `waitlistOf` stops at 1000, so deeper waitlist entries are never promoted or renumbered (`rsvp.ts:412`, `jobs/waitlist.ts:318`).
- **L9. Paid downgrade without refund.** `place()` lets a seated, paid guest switch to a free ticket (`changes && paid` only blocks a change TO a paid ticket, `rsvp.ts:338-339`): the seat moves, the paid order stays.
- **L10. Erase does not promote the waitlist or emit `rsvp.removed`** (`privacy.ts eraseRsvp`): a freed seat sits unused until something else triggers promotion.
- **L11. Door staff scope.** `GET /checkin/codes/:code` is global (any published event) for `site:event:checkin` holders (`admin-checkin.ts:185`). Single tenant, so by design; note for multi-organiser use.

---

## Checked and found sound

- **Guard chain and permissions.** Every admin route (`admin-*`, `event-settings` GET/PATCH, `overview`, `checkin`, `analytics`, `polls`, `webhook-endpoints`) has `withViewer -> requireAuth -> requirePermission(EVENT_MANAGE | EVENT_CHECKIN)`
  (door routes accept checkin or manage; attendee, attendance and import routes manage only). Public routes are exactly: rsvp, privacy, polls-public, pageviews, events, event-settings/brand, event-checkout (token) and the template checkout.
  No client-supplied role or user id anywhere.
- **IDOR.** Guest access is only by secret: manage token (32 random bytes via `newToken`, stored as sha256 via `hashToken`, `findUnique` by hash so the app never compares secrets itself), the same 404 for bad, rotated, expired or draft.
  A guest cannot reach another RSVP; `findEvent` excludes deleted and draft events and private events need a live invite (once H4 is fixed). Admin by-id access always adds `eventId` / `deletedAt` (`findFirst({id, eventId})`,
  `updateMany`/`deleteMany` with both). Payment ids come from the database, never the body (`startTicketCheckout` recomputes price x seats; `confirmPaidTicket` checks amount, currency and metadata rsvpId against the order).
- **Mass assignment.** No `data: body` or `...body`. `validateRsvp` builds the value field by field; `columnsOf`, `ruleData`, `questionData`, `parseEndpointInput`, `checkGuestPatch`, `parseSettingsPatch` produce explicit keys;
  the only spreads are of validated or constructed objects (`reminderRule.create({...input})`, `...placement`).
- **SQL injection.** All `$queryRaw` are tagged templates with `${}` values (`lockEvent`, `doorCounts`, analytics, `queryContacts` with `Prisma.sql`/`Prisma.join` and an escaped `likePattern`); no `$queryRawUnsafe` or `Prisma.raw`.
- **CSV formula injection.** `csv.ts` prefixes a quote when a string starts with `= + - @ \t \r`; all exports go through `toCsv`; filenames via `attachmentHeader` (strict charset); exports are capped at 20,000 rows and `no-store`.
- **Email, HTML and header injection.** `renderLayout` escapes every interpolation; creator copy is escaped before merge and merged values are escaped; `linkify` only matches `https?://` on already escaped text; subject newlines are stripped
  (`renderCreatorCopy`); brand colour is `normalizeHex` validated before reaching `style`; Resend gets a JSON body (no header splicing) and the display name is stripped of `<>"\r\n`; `.ics` escapes TEXT, strips CR/LF from URI fields, quotes CN.
- **Open redirects.** `/e/<slug>` encodes the slug (relative target); page links use `encodeURIComponent`; `checkoutUrl` comes from the platform through the server hook; `thankYouLink`, `mapUrl`, `joinUrl` are saved as absolute http(s) only and
  rendered with `rel="noopener noreferrer"`; `successPath`/`cancelPath` on `/site-api/checkout` pass `isSitePath`.
- **XSS and CSP.** No `innerHTML` with data (`poll-client.ts` uses `textContent`, bar width via CSSOM). The only `set:html` uses are the QR SVG from `uqr` over an 8-char server code, JSON-LD (escaped) and the poll JSON (see L1).
  No inline handlers or `style=` in the new `.astro` files; scripts are bundled modules; the host page sets brand colour via CSSOM after a hex regex. The CSP in `astro.config.mjs` is strict.
- **Caching and PII on public responses.** Guest-specific responses set `Cache-Control: private, no-store` plus `Referrer-Policy: no-referrer` and `X-Robots-Tag`; `pageContext` sets it for every SSR page; polls are `no-store`. The only `public` caches
  are `/events/sitemap` (slugs) and `/event-settings/brand` (colour, font). No public route returns a guest list, emails or tokens; door staff never get emails (`guestSelect`); emails are visible only to managers; the invite page echoes only the invitee's own details to the token holder.
- **Privacy routes.** Tokens never echoed, uniform 404, token plus IP rate limit through the platform limiter (apart from M3), writes are POST behind buttons (scanner-safe), consent is idempotent and cannot re-enable after unsubscribe,
  the export is built field by field (no token, no checkout ids), erase needs a typed confirmation and is refused mid-checkout.
- **Concurrency.** RSVP create/update/cancel, payment confirm, hold release, waitlist and admin seat changes all run in a transaction that first takes `SELECT ... FOR UPDATE` on the event row; confirmations and releases are conditional
  `updateMany` on status; `confirmPaidTicket` re-reads the order inside the lock, so the platform event and the thanks-page confirm cannot double-confirm, double-email or double-promote; `refundedTicket` closes the order only when it flips;
  delivery claims use unique (rsvp, rule) with stale-claim recovery; broadcasts are idempotent by key and `expectedCount`; poll open is protected by the partial unique index; check-in is a conditional write.
- **Outbound webhooks.** HMAC-SHA256 over the exact body, stable `X-Ezy-Delivery` id across retries, no redirects, 5 s timeout, URL re-validated at send time, errors not retained (secret-bearing URLs), max 10 endpoints, secret shown once,
  constant-time `verifySignature` helper, ids-only payloads. Inbound webhooks: none (platform payment and job deliveries are signature-checked in the managed core).
- **Jobs.** Handlers re-validate their data (`rsvp-emails` checks kind and UUID, `DontRetry` on junk), are bounded (500 reminders per run, 100 events, 200 holds, 50 events of lapsed claims, 45 s deadline) and idempotent.
- **Input bounds.** Body limit 64 KB app-wide (8 KB on `/checkout`); strings and arrays are length capped in validators (names 120, answers 200/2000, 20 multi-choice values, invites 200 per request and 2,000 per day, bulk 100, attendance 200, emails 1,000, polls 10 options).

## Follow-ups

- **Invite tokens still stored in clear text (H4).** Not changed here: `invites.token` is read by `src/server/routes/rsvp.ts` (`liveInvite`: `where: {token}`) and `src/pages/i/[token].astro`, which belong to another owner, and `admin-invites.ts` re-sends links from the stored token. Required change: store `hashToken(token)` (`src/domain/secureToken`, same sha256 helper as manage tokens) in `invites.token`; in `liveInvite` look up `where: {token: await hashToken(token)}` after the `INVITE_RE` check and use the raw token from the URL (not `row.token`) wherever the link is rebuilt; in `admin-invites.ts` `create` store the hash and email the raw one, and make single/bulk resend re-sign a fresh token (`signToken('invite', {eventId, inviteId})`) because the raw one is no longer recoverable; the admin invite list/share-kit must stop returning `row.token`. Existing rows need a one-off `UPDATE invites SET token = encode(sha256(token::bytea),'hex')`.
- Done in `admin-*` / `event-schemas`: audit entries for CSV exports, bulk remove/erase, invite sends/resends, broadcasts, webhook create/update/test/delete; cancel marks paid orders `refund_due`; event links are https-only (DB CHECK still allows http); webhook delivery already re-validates the URL and uses `redirect: 'manual'` (tests added); `csv.ts` already neutralises `= + - @ \t \r`.
- **Privacy/polls slice (M3, M4, M7, L1, pageviews).** M3 fixed: SSR pages forward `cf-connecting-ip` via `inProcessHeaders` (`server/privacy.ts`). L1 fixed: `jsonForScript` (`polls-public.ts`) in a `type="application/json"` block. M7: codes resolve only for published events (same 404 as missing), misses are throttled per IP (`poll_lookup` kind); audit entries added for poll open/close/delete. M4: daily `guest-retention` job (`background.json`, `jobs/retention.ts`, max 500 guests per run).
  Still open: (a) every marketing/broadcast email needs an unsubscribe link: build it with `unsubscribeUrl(origin, rawManageToken)` in the sender that holds the raw token (the DB keeps only the hash) and pass it through the layout's `manageUrl`; `src/emails/layout.ts` is not changed here. (b) `/pageviews` limits stay per isolate, best effort (a DB limiter would cost a write per beacon); the unique index bounds rows per visitor per day. (c) Poll vote and lookup limiters add one rate-limit write per miss/vote, not per hit.
- **RSVP slice (H1, H3 rsvp part, existence oracle, cancelPath, limits).** H1 fixed: `place()` now sends every move to a seat on a paid ticket through `awaiting_payment` unless the guest already holds a settled seat (it was keyed on `status === 'confirmed'`, which a Maybe also has). The PATCH route starts the same checkout hook as a fresh RSVP and returns `checkoutUrl` (the form redirects to it); if checkout cannot start the edit is reverted. A Maybe stores no ticket type, so Going must choose and pay. H3: the manage API and the emails' `guest.ticketCode` are null unless `confirmed` + `going`. Oracle: `POST /events/:slug` answers 202 `check_email` with the same body for new and existing emails (the manage link is only emailed; a paid RSVP adds `checkoutUrl`). `cancelPath` sent to the payment platform no longer carries the manage token (`ticket-checkout.ts` drops `/r/…` paths; default `/events/<slug>/`).
  Still open: (a) a full or closed event still answers 409 to a NEW email only (the repeat check runs first), and a paid new RSVP returns `checkoutUrl`, so those two cases remain an oracle. (b) Manage-link requests still rotate the token (one hashed column: the old link cannot be re-sent), so a stranger can invalidate a guest's links, capped at 3 per (event, email) per hour; the fix is a second column (`manage_token_next`, promoted when used) or a mailed one-time re-issue link. (c) `src/server/app.ts` still passes `cancelPath: /r/<token>/` to `startTicketCheckout`; it is ignored now, the hook should drop it. (d) RSVP limits stay per isolate: `AttemptKind` in managed `platform/auth/rate-limit.ts` is a closed union with no RSVP kind.
