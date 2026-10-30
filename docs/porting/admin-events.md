# Admin events (slice: event CRUD, tickets, questions, settings)

Everything is gated by `PERMISSIONS.EVENT_MANAGE` (`site:event:manage`, ability `manageEvents`).
Nothing in `app.ts`, `routes.tsx`, `queries.ts`, `prisma/*` or `permissions.ts` was touched: paste the snippets below.

## 1. `src/server/app.ts`

Imports (next to `eventRoutes`):

```ts
import {adminEventRoutes} from './routes/admin-events';
import {eventSettingsRoutes} from './routes/event-settings';
```

Mounts (chained, after `.route('/events', eventRoutes)`, before `.notFound`):

```ts
  .route('/admin-events', adminEventRoutes)
  .route('/event-settings', eventSettingsRoutes)
```

The typed client then exposes `api['admin-events']` and `api['event-settings']` (the portal files already use them).

## 2. `src/portal/routes.tsx`

Imports (with the other `queries` imports; keep the screens lazy):

```ts
import {eventQuery, eventSettingsQuery, eventTicketsQuery, eventsListQuery} from './events-queries';
```

Routes (before `routeTree`). `$id` is a event uuid, or the word `new` to create:

```ts
const eventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events',
  staticData: {title: 'Events'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(eventsListQuery('upcoming'))),
  component: lazyRouteComponent(() => import('./screens/events'), 'Events'),
});
const eventEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events/$id',
  staticData: {title: 'Event'},
  loader: ({context: {queryClient}, params}) =>
    params.id === 'new'
      ? warm(queryClient.ensureQueryData(eventSettingsQuery))
      : warm(queryClient.ensureQueryData(eventQuery(params.id)), queryClient.ensureQueryData(eventTicketsQuery(params.id))),
  component: lazyRouteComponent(() => import('./screens/event-editor'), 'EventEditor'),
});
const eventSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/event-settings',
  staticData: {title: 'Event settings'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureQueryData(eventSettingsQuery)),
  component: lazyRouteComponent(() => import('./screens/event-settings'), 'EventSettings'),
});
```

`routeTree` (add to `addChildren([...])`): `eventsRoute, eventEditorRoute, eventSettingsRoute,`

`NAV_GROUPS` ("Manage" group; the kit has no calendar icon, `clock` is the closest):

```ts
      {to: '/events', label: 'Events', icon: 'clock', ability: 'manageEvents'},
      {to: '/event-settings', label: 'Event settings', icon: 'bell', ability: 'manageEvents'},
```

The sidebar highlights by path prefix, so `/events/<id>` keeps "Events" active.

## 3. Route contract for other screens

| Link | Opens |
| --- | --- |
| `/dashboard/events` | the list (tabs upcoming / past and cancelled / drafts) |
| `/dashboard/events/$id` | the editor of event `id` (the event's uuid): details, cover, questions, tickets |
| `/dashboard/events/new` | the editor creating a draft |
| `/dashboard/event-settings` | branding, defaults, default emails |

Inside the portal use `<Link to="/events/$id" params={{id}}>` (router paths are relative to the `/dashboard` basepath) once the routes above are pasted;
`useEventsNav()` from `src/portal/events-queries.ts` navigates by plain path string (`go('/events/' + id)`) and works before they are registered in the router types.
Guest, invite, message, poll and check-in screens of an event should be sub-links FROM this editor or be separate routes; this slice adds no tabs for them.
After a write elsewhere that changes an event's list-visible data (title, status), invalidate `['events']` (prefix of list, detail and tickets keys).

## 4. Site API (all `401`/`403` without `site:event:manage`, except `/event-settings/brand`)

Mounted at `/site-api/admin-events`:

| Call | Body / query | Answer |
| --- | --- | --- |
| `GET /?tab=upcoming\|past\|drafts&before=` | `before` is `<ISO>_<id>` from `nextBefore` | `{events: AdminEventSummary[], nextBefore}` (20 a page, no counts of total) |
| `POST /` | event body (below) | `201 {event: AdminEventDetail}` (a draft; inherits event settings defaults for keys not sent; copies default email rules) |
| `GET /:id` | | `{event}` incl. `questions`, `joinUrl`, `pollJoinCode`, `publicPath` |
| `PATCH /:id` | any subset of the event body | `{event}`; `questions` (when sent) REPLACES the list, ids kept update in place |
| `POST /:id/publish` `/unpublish` `/cancel` | | `{event}`; `409` for cancelled/ended/incomplete |
| `GET /:id/cancel-preview` | | `{guestsToEmail, ordersToRefund, refundTotalCents, currency}` |
| `POST /:id/duplicate` | `{startAt, endAt, title?}` | `201 {event}`: draft copy with questions, tickets (sales end shifted), email rules |
| `DELETE /:id` | | soft delete, drafts only (`409` otherwise) |
| `GET /:id/ticket-types` | | `{ticketTypes: AdminTicketType[], currency}` |
| `POST /:id/ticket-types` | `{name, priceCents, currency, quantity?, salesEndAt?}` | `201 {ticketType}` |
| `PATCH /:id/ticket-types/:ticketId` | subset | `{ticketType}` |
| `DELETE /:id/ticket-types/:ticketId` | | `409` once any RSVP chose it |

Event body keys: `title, slug?, description, coverImageUrl, coverPoster, coverStyle{palette,headline,eyebrow,footer}, startAt, endAt (ISO with Z/offset), timezone (IANA), format, venueName, venueAddress, mapUrl, joinUrl, visibility, capacity, rsvpDeadline, waitlistEnabled, approvalRequired, allowMaybe, maxPlusOnes, showGuestList, thankYouLink, questions[{id?,label,type,options,required}]`.
Errors: `422 {error: 'invalid_input', message, fields}` (question errors are keyed `questions.N.label|type|options`).

Mounted at `/site-api/event-settings`: `GET /` and `PATCH /` (EVENT_MANAGE; the singleton row `event_settings` id 1, upsert on first save; PATCH changes only keys sent) and `GET /brand` (public: `{brandColor, fontPreset}`, for pages and check-in).

Hook for other slices: `eventCancelHooks` (array of `(db, eventId) => Promise<void>`, exported from `routes/admin-events.ts`). Push the guest-email enqueue / refund job there; the cancel route awaits each after the status change.
Audit events written: `event_published`, `event_unpublished`, `event_cancelled`, `event_deleted`, `event_settings_changed`.

## 5. Shared code and schema gaps

- `src/lib/event-schemas.ts`: validators shared by server and forms (`parseEventFields`, `completeEvent`, `parseTicket`, `parseSettingsPatch`, `toLocalInput` / `fromLocalInput` for the event timezone via `src/domain/time.ts`), plus the response types (`AdminEventDetail`, ...).
- `TicketType` and `RsvpQuestion` have NO sort column in `prisma/schema.prisma`. They are listed `orderBy id` and new rows get time-ordered UUIDv7 ids (`uuidV7`), so "by id" is creation order; there is no reorder. A `sort_order` column would need a migration (not done here).
- Paid prices are not gated on a payments connection here (the old app refused them until Stripe was connected); the payments slice can add that check to the ticket POST/PATCH.
- No theme/poster CSS was added (no edits to `app.css`); screens use existing kit classes only.
- Tests: `npx vitest run tests/admin-events` (pure validators, routes with stubbed guards and a recording fake DB, real-guards 401 checks). No Postgres needed.
