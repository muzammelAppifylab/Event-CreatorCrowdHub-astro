# Door check-in and analytics: paste-in snippets

Files (all new, nothing else edited): `src/server/routes/{admin-checkin,admin-analytics,pageviews}.ts`,
`src/portal/checkin-queries.ts`, `src/portal/screens/{checkin,checkin-event,event-analytics}.tsx`,
`prisma/migrations/20261030100000_checkin_role/`, `tests/{checkin,analytics}.test.ts`.

## 1. `src/server/app.ts`
```ts
import {adminAnalyticsRoutes} from './routes/admin-analytics';
import {adminCheckinRoutes} from './routes/admin-checkin';
import {pageViewRoutes} from './routes/pageviews';
// ... chained, before .notFound:
  .route('/checkin', adminCheckinRoutes)
  .route('/analytics', adminAnalyticsRoutes)
  .route('/pageviews', pageViewRoutes)
```
Endpoints: `GET /checkin/events`, `GET /checkin/events/:eventId?q=`, `GET|POST /checkin/codes/:code`
(`site:event:checkin` OR `site:event:manage`); `GET /checkin/events/:eventId/attendees?before=`,
`POST /checkin/events/:eventId/attendance`, `POST .../attendance/import` and
`GET /analytics/events/:eventId` (`site:event:manage`); `POST /pageviews/:slug` (public, 204).

## 2. `src/portal/routes.tsx`
Import `eventDoorQuery`-style warmers from `./checkin-queries` (`doorEventsQuery`, `doorListQuery`).
```tsx
const checkinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/checkin',
  staticData: {title: 'Check-in'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureQueryData(doorEventsQuery)),
  component: lazyRouteComponent(() => import('./screens/checkin'), 'Checkin'),
});
const checkinEventRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/checkin/$eventId',
  staticData: {title: 'Door list'},
  loader: ({context: {queryClient}, params}) => warm(queryClient.ensureQueryData(doorListQuery(params.eventId, ''))),
  component: lazyRouteComponent(() => import('./screens/checkin-event'), 'CheckinEvent'),
});
// add both to routeTree, then a NAV_GROUPS item:
{to: '/checkin', label: 'Check-in', icon: 'check-circle', ability: 'checkinGuests'},
```
The screens link with `to={'/checkin/$eventId' as never}` so they compile before the routes exist;
once added you may drop the casts.

Admins hold `site:event:manage` but `ability: 'checkinGuests'` only shows for `site:event:checkin`
holders (and `*`/`site:event:*`). If managers should see the nav item too, use an ability for
manage, or give the `admin` role both (the catalogue already defaults both to `admin`).

## 3. Event analytics inside the event hub
```tsx
import {EventAnalytics} from './event-analytics';
<EventAnalytics eventId={event.id} />   // needs site:event:manage; renders its own cards
```
It uses `.stat-grid` for the KPI row.

## 4. Recording a view (public event page)
```ts
// in the /e/<slug>/ page script, once per visit (astro:page-load), after the page is shown:
import {siteFetch} from '../platform/browser';
const utmSource = new URLSearchParams(location.search).get('utm_source');
void siteFetch(`/site-api/pageviews/${encodeURIComponent(slug)}`, {
  method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({utmSource}),
}).catch(() => {});
```
Always 204 (recorded or deduplicated). Never fails the page. One row per (event, visitor, UTC day).
The visitor hash is sha256 of an HMAC-of-the-date salt, the IP, the user agent and the event id;
the raw IP is never stored. Limits (per Worker isolate): 60/min per IP, 500/min per event.

## 5. The `checkin_staff` role
Option A (no deploy): an owner opens `/dashboard/roles`, creates a role named "Check-in staff"
(slug `checkin_staff`), ticks ONLY "Check guests in" (`site:event:checkin`), then assigns it to users
in `/dashboard/users`. They can open `/dashboard/checkin` and nothing else; the door list shows
names, ticket codes, seats and status, never emails, and search matches name and code only.

Option B: the migration `20261030100000_checkin_role` creates the same role (idempotent, not a
system role) with that one permission. Owners still assign it to users.

## Notes
- Emails in RSVPs must be stored lowercase for the attendee CSV match (`email IN (...)`).
- Revenue and poll-participation KPIs from the source are not ported here (they belong to the
  tickets/polls slices); add them to `admin-analytics.ts` when those tables are served.
