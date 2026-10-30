# Overview + event hub: wiring

## app.ts
```ts
import {adminOverviewRoutes} from './routes/admin-overview';
// on the site-api chain:
.route('/overview', adminOverviewRoutes)   // GET /site-api/overview (EVENT_MANAGE)
```

## routes.tsx
```tsx
const eventHubRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/events/$id',
  staticData: {title: 'Event'},
  component: lazyRouteComponent(() => import('./screens/event-hub'), 'EventHubRoute'),
});
```
`event-hub.tsx` exports `EventHub({eventId})`. Wrap it where the route is declared:
`function EventHubRoute() { const {id} = eventHubRoute.useParams(); return <EventHub eventId={id} />; }`
(or lazy-import and render that wrapper). Add `eventHubRoute` to the route tree. The tab is kept in `?tab=`.

## Contracts
- Header reads `GET /site-api/admin/events/:id` (owned by the events-admin agent); accepts `{id,title,status,startAt,endAt,slug,timezone?}` or `{event: {...}}`.
- Tabs resolve by file in `src/portal/screens/`: guests.tsx, invites.tsx, messages.tsx, polls.tsx, event-analytics.tsx, checkin-tab.tsx, event-settings.tsx. Default export, or named `Guests`/`EventGuests`/`GuestsTab`..., or the first function export, taking `{eventId: string}`. Missing file -> "Coming soon".
- Overview tab uses `/analytics/events/:eventId` (admin-analytics). Dashboard tiles use `/site-api/overview`; the section hides itself if the viewer lacks EVENT_MANAGE (403).
- Overview links use `/events` (events list route, owned elsewhere).
