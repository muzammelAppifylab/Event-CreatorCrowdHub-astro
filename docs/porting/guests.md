# Guests, invites, messages, contacts (organiser side)

Everything is behind `requirePermission(PERMISSIONS.EVENT_MANAGE)`. A malformed or unknown event/guest id is a 404.

## Files

| File | What |
| --- | --- |
| `src/server/routes/admin-guests.ts` (`adminGuestRoutes`) | guest list/filter/search, detail, edit, remove, bulk approve/decline/promote/remove/erase, CSV export, contacts + contacts CSV |
| `src/server/routes/admin-invites.ts` (`adminInviteRoutes`) | invites list/create (paste box), resend all / one, delete, share-kit data |
| `src/server/routes/admin-messages.ts` (`adminMessageRoutes`) | broadcast, segments, preview, message log, reminder rules CRUD |
| `src/server/csv.ts` | CSV writer/parser (formula-injection guard, BOM, CRLF) |
| `src/server/guest-mail.ts` | email glue (see "Mailer") |
| `src/portal/guests-queries.ts` | all reads for these screens + browser-safe helpers (own file: `queries.ts` untouched) |
| `src/portal/screens/{guests,invites,messages,contacts}.tsx` | screens |
| `tests/admin-guests.test.ts`, `tests/admin-guests-csv.test.ts` | unit tests (no database) |

## 1. `src/server/app.ts`

Import (next to the other route imports):

```ts
import {adminGuestRoutes} from './routes/admin-guests';
import {adminInviteRoutes} from './routes/admin-invites';
import {adminMessageRoutes} from './routes/admin-messages';
```

Mount, chained, before `.notFound`. All three share one prefix; the portal calls `/site-api/event-admin/...`
through `siteFetch` (`guests-queries.ts`), so the prefix must stay `/event-admin`:

```ts
  .route('/event-admin', adminGuestRoutes)
  .route('/event-admin', adminInviteRoutes)
  .route('/event-admin', adminMessageRoutes)
```

### Endpoints (all under `/site-api/event-admin`)

```
GET    /events/:eventId/guests?status&response&ticketTypeId&checkedIn=yes|no&q&before   {items, questions, ticketTypes, statusCounts, nextBefore}
GET    /events/:eventId/guests/export.csv?<same filters>
POST   /events/:eventId/guests/bulk            {action: approve|decline|promote|remove|erase, rsvpIds[1..100]} -> {action, succeeded[], failed[{rsvpId, reason}]}
GET    /events/:eventId/guests/:rsvpId         detail + answers + timeline
PATCH  /events/:eventId/guests/:rsvpId         {name?, email?, plusOnes?, marketingConsent?, attended?, checkedIn?}
DELETE /events/:eventId/guests/:rsvpId         409 has_order when the guest paid (erase instead)
GET    /contacts?q&consent=yes&before          {items, nextBefore}   (one row per email)
GET    /contacts/export.csv?q&consent=yes

GET    /events/:eventId/invites?before         POST /events/:eventId/invites {emails}
GET    /events/:eventId/invites/resend-preview POST /events/:eventId/invites/resend
POST   /events/:eventId/invites/:inviteId/resend   DELETE /events/:eventId/invites/:inviteId
GET    /events/:eventId/share-kit

GET    /events/:eventId/messages?before        (log)       GET  .../messages/segments
POST   /events/:eventId/messages/preview       POST .../messages/broadcast
GET/POST .../messages/rules   PATCH/DELETE .../messages/rules/:ruleId   POST .../messages/rules/:ruleId/toggle
```

Lists are keyset paged (`before` = last cursor, `nextBefore` null on the last page). Guests: 50/page by
`(createdAt, id)` desc; invites: 100/page by email; log: 50/page; contacts: 50/page by email.

## 2. `src/portal/routes.tsx`

Guest-facing tabs are rendered by the event screen (`/dashboard/events/$id`, owned by another slice). Each tab
component takes `{eventId: string}` (the event's uuid, i.e. the `$id` param) and renders its own `PageHeader`:

```tsx
import {GuestsTab} from './screens/guests';     // lazy in practice: lazyRouteComponent(() => import('./screens/guests'), 'GuestsTab')
import {InvitesTab} from './screens/invites';
import {MessagesTab} from './screens/messages';

{tab === 'guests' && <GuestsTab eventId={id} />}
{tab === 'invites' && <InvitesTab eventId={id} />}
{tab === 'messages' && <MessagesTab eventId={id} />}
```

Contacts is a top-level screen (no props). Route:

```tsx
const contactsRoute = createRoute({
  getParentRoute: () => dashboardRoute, // same parent as jobsRoute
  path: '/contacts',
  staticData: {title: 'Contacts'},
  component: lazyRouteComponent(() => import('./screens/contacts'), 'Contacts'),
});
// add contactsRoute to the route tree next to jobsRoute
```

NAV item (same group as the events items, gated like the rest of the events slice):

```ts
{to: '/contacts', label: 'Contacts', icon: 'users', ability: 'manageEvents'},
```

Optional loader warm-ups: `queryClient.ensureInfiniteQueryData(guestsQuery(id, NO_GUEST_FILTER))`, `contactsQuery({q: '', consent: 'yes'})`
(both exported from `guests-queries.ts`).

All guest-data query keys start with `'guests'`, `'invites'`, `'messages'` or `'contacts'`.

## Mailer

`src/server/mailer.ts` (another slice) must export
`sendEventEmail({to, subject, html, text, replyTo?}): Promise<{ok: boolean}>`.
`guest-mail.ts#sendMail` loads it with `import.meta.glob('./mailer.ts')`, so nothing here fails to build or test
when it is missing; without it every send reports `{ok: false}` (invites stay `queued` and can be resent, broadcast
deliveries are `failed`). Not supported by that signature: attachments, so the calendar `.ics` that
`confirmationEmail` builds is not sent from the approve/promote paths. No call ever throws.

## Behaviour notes / assumptions

- Seat changes (approve, promote, remove, erase, lowering plus-ones) run in a transaction that locks the `events` row.
  Releasing a seat auto-promotes waitlisted guests (free events confirm, paid events get a claim offer with `waitlistClaimMinutes`).
  Emails (confirmation, declined, waitlist offer) go after the commit; removed/erased guests get none.
- Approve: capacity decided with `decideSeat`; full event + waitlist on -> waitlisted, full without waitlist -> `event_full`;
  a guest on a paid ticket becomes `awaiting_payment` (they pay through the checkout flow of the RSVP slice).
- Remove refuses a guest with a `ticket_orders` row (`has_order`): the schema cascades orders, so erase (anonymise in place,
  keep the order) is the safe path. Poll votes are detached (`rsvp_id` null) first.
- Contacts' "opted in" = `marketing_consent AND consent_confirmed_at IS NOT NULL` on the guest's latest RSVP (confirmed by the
  guest from the email link). The host can switch consent off but not on.
- The stored `manage_token` is a hash, so emails link "Manage RSVP" to the public event page `/e/<slug>`.
- Invite links are `<site>/i/<token>?e=<slug>`, `token = signToken('invite', {eventId, inviteId}, config.jwtSecret)`.
  The public `/i/<token>` handler (RSVP slice) must also look the invite row up, so deleting an invite revokes the link,
  and should set `invites.status = 'responded'` when the guest RSVPs (the list also derives it from the linked RSVP).
- Limits (a Worker request makes a bounded number of calls): 200 invites created or resent per request (`remaining` in the
  resend answer), 2000 invite emails per rolling 24 h, 500 recipients per broadcast (422 on `segment` beyond that).
- Broadcast: `expectedCount` must equal the segment size (409 otherwise); `idempotencyKey` (uuid) makes a retry return the first
  send (200). Goes to every guest in the segment regardless of marketing consent (event-operational mail).
- The email preview renders in a sandboxed `<iframe srcDoc>`. If the site's CSP forbids inline styles inside srcdoc frames, the
  frame shows unstyled; the plain-text version is under "Plain text version".
- Needs no migration. Sender name/reply-to/brand colour come from the `event_settings` row (id 1).
