# Live polls: paste-in snippets

Files of this slice: `src/server/routes/{admin-polls,polls-public}.ts`, `src/pages/p/[code].astro`,
`src/lib/poll-client.ts`, `src/portal/polls-queries.ts`, `src/portal/screens/{polls,poll-presenter}.tsx`,
`tests/polls.test.ts`.

## 1. `src/server/app.ts` (chained with the other `.route()` lines)

```ts
import {adminPollRoutes} from './routes/admin-polls';
import {pollPublicRoutes} from './routes/polls-public';
// ...
  .route('/polls', adminPollRoutes)          // site:event:manage; GET /polls/event/:eventId, /polls/by-code/:code ...
  .route('/polls-public', pollPublicRoutes)  // guests: /polls-public/:code/{active,votes,results}
```
Both sit after `csrf` (the page uses `siteFetch`, which sends the token). No other change needed.

## 2. `src/portal/routes.tsx`

Imports: `import {presenterPollsQuery} from './polls-queries';`

```tsx
const pollPresenterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/polls/$code/present',
  staticData: {title: 'Poll presenter'},
  loader: ({context: {queryClient}, params}) => warm(queryClient.ensureQueryData(presenterPollsQuery(params.code))),
  component: lazyRouteComponent(() => import('./screens/poll-presenter'), 'PollPresenter'),
});
```
Add `pollPresenterRoute` to `routeTree`. No NAV item: it is opened from the polls screen / event screen
("Presenter view" link, `/dashboard/polls/<code>/present`). The event screen (other slice) embeds the polls tab:

```tsx
import {Polls} from './polls';   // <Polls eventId={event.id} />  (lazy it if the tab is not the first one)
```
If you also want a standalone screen: route `path: '/events/$eventId/polls'`, component `() => <Polls eventId={useParams({from: ...}).eventId} />`.
After adding the route, the `as never` casts on the `<Link to=...>` in `screens/polls.tsx` can be dropped.

## 3. `src/styles/app.css` (append at the END; the guest page styles itself in `[code].astro`)

```css
.screen-polls .poll-options { border: 0; padding: 0; margin: 0; display: grid; gap: 0.5rem; }
.screen-polls .poll-option-row { display: flex; gap: 0.5rem; align-items: center; }
.screen-polls .poll-option-row input { flex: 1; }
.screen-poll-present .poll-present-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1.5rem; flex-wrap: wrap; }
.screen-poll-present .poll-present-question { font-size: clamp(1.75rem, 4vw, 3.5rem); line-height: 1.15; margin: 0 0 1.5rem; }
.screen-poll-present .poll-present-url { font-size: 1.25em; }
.screen-poll-present .poll-present-body { display: grid; gap: 1.5rem; }
.screen-poll-present .poll-present-body .stat-value { font-size: clamp(2.5rem, 6vw, 5rem); }
.screen-poll-present .bar-chart { min-height: 22rem; }
.screen-poll-present .bar-chart-labels { font-size: clamp(1rem, 2vw, 1.6rem); font-weight: 600; }
.screen-poll-present .poll-present-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; font-size: clamp(1.1rem, 2.2vw, 1.75rem); }
.screen-poll-present .poll-present-list li { display: flex; justify-content: space-between; gap: 1rem; }
.screen-poll-present .poll-present-answers { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); font-size: clamp(1.1rem, 2vw, 1.6rem); font-weight: 600; }
.screen-poll-present .poll-present-answers li { padding: 1rem 1.25rem; border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); }
.screen-poll-present .poll-present-note { font-size: 1.5rem; }
```

## Notes for the integrator

- **Order without a sort column.** `Poll`/`PollOption` have no `sortOrder` (and `Poll` no `createdAt`). Order is carried by the
  uuid: `orderedUuid(position)` (polls: creation time in seconds; options: index) and every read is `orderBy: {id: 'asc'}`.
  Poll reordering is therefore not offered. If you add `sort_order` columns to the schema, replace `orderedUuid` and the two `orderBy`s.
- **Rate limit.** The template's limiter (`platform/auth/rate-limit.ts`, DB-backed `takeAttempt` via `kit.attempt`) is reused.
  Its `AttemptKind` list has no vote kind, so `polls-public.ts` registers `RATE_LIMITS.vote` at import (per IP, 600 per 10 min, then
  10s/20s/40s backoff, 429 + `Retry-After`). To make it official, add `'vote'` to `AttemptKind` and the policy to `RATE_LIMITS`, and
  delete the registration block. A vote is one `login_attempts` row; `sweep` clears old rows.
- **Voter identity**: HttpOnly cookie `site_voter` (uuid, path `/site-api/polls-public`), minted on the first vote, as in the source.
  In the editor Preview (cookies dropped) every vote looks like a new device.
- **Results cache**: per-isolate, 1s, concurrent callers share one query; best effort (another isolate may be 1s stale).
- **Guest identity (`g`)**: the manage page (`/r/<token>`) shows an "Open the poll" link `/p/<code>?g=<raw manage token>` (from `GET /site-api/polls-public/guest-link/:token`, confirmed guests of a published event only). `/p/<code>` with `g` is `no-referrer` + `noindex`, hands `g` to `poll-client.ts` (`data-guest`), which sends it in the vote POST BODY only. `polls-public.ts` hashes it (`hashToken`), matches an RSVP of that event with a voting-eligible status (`VOTING_ELIGIBLE_STATUSES` = confirmed, not `not_going`) and sets `PollVote.rsvpId` ONLY when the poll is not anonymous; an unknown token is ignored silently. The admin CSV then fills its `Guest email` column for non-anonymous polls; privacy erase nulls `rsvpId`. Second identity for EMAILS: the manage token is stored hashed, so `{{poll.join_url}}` (`guest-mail.ts` `emailDataFor`, `jobs/shared.ts` `loadGuestMail`, via `pollLinkFor` in `src/domain/tokens.ts`) carries `?g=pg_<signed>`: an HMAC (`JWT_SECRET`, purpose `poll`) over `{rsvpId, eventId}`, 180-day expiry, stateless, nothing stored. `guestRsvpId` takes either form: `pg_` values are verified (timing-safe, must name THIS event, then the RSVP must still be voting-eligible), anything else is hashed as a manage token; invalid values are ignored silently; anonymous polls never link. Poll and event links in emails now all end with `/` (`/p/<code>/?g=…`). `g` may be up to 400 characters.
- `/p/<code>` is SSR (`prerender = false`), reads its first state in-process from `app.request`, and is `noindex`.
