# SEO notes for the CreatorCrowdHub port

## Event JSON-LD (one line in `src/pages/events/[slug].astro`)

`eventJsonLd(event, site)` is exported from `src/lib/seo.ts` (schema.org `Event`: name, dates,
attendance mode, venue / virtual location, cover, organizer). `<Base>` already renders its
`jsonLd` prop, so the only edit is on the detail page:

```astro
import {eventJsonLd} from '../../lib/seo';
...
<Base ... jsonLd={eventJsonLd(event, site ?? undefined)}>
```

`event` is the `EventDetail` the page already loads (needs `slug`, `title`, `description`,
`coverImageUrl`, `startAt`, `endAt`, `format`, `venueName`, `venueAddress`, `joinUrl`). Pass
nothing for unlisted events (they are `noindex`; `<Base>` drops JSON-LD on `noindex` pages anyway).

## Sitemap

`/sitemap.xml` lists `/events/` (found automatically) and every upcoming public event slug from
`GET /site-api/events/sitemap`. Unlisted/private/past events are not listed.

## Home page

`/` is prerendered with no visitor data. The "Upcoming events" section is hidden in the HTML and
filled in the browser from `GET /site-api/events` (next 3), like the open-roles section.
