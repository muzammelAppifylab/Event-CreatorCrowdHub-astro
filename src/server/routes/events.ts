import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {cache} from '../../platform/cache';
import {problem, withDb} from '../../platform/guards';
import type {PrismaClient} from '../../generated/prisma/client';
import {EVENT_DETAIL_TTL, eventSlugKey} from '../event-cache';
import {hasNul, keysetAfter, NUL_MESSAGE, parseKeysetCursor} from '../../lib/text';
import {escapeLike} from '../like';

/**
 * Events, public side (ported from CreatorCrowdHub, `/e/:slug`).
 *
 *   GET /site-api/events?before=<iso>|<id>   upcoming public events, soonest first
 *   GET /site-api/events/:slug               one published event (public or unlisted)
 *   GET /site-api/events/sitemap             slugs of upcoming public events (/sitemap.xml)
 *
 * Index: events(start_at) WHERE published AND not deleted. Lists are keyset-paged by
 * (start_at, id); no count. Admin routes (create, edit, RSVPs) follow in the next phase.
 */
const PAGE_SIZE = 20;
const SITEMAP_LIMIT = 1000;
const PAST_LIMIT = 12;

const summarySelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  coverImageUrl: true,
  coverPoster: true,
  startAt: true,
  endAt: true,
  timezone: true,
  format: true,
  venueName: true,
  capacity: true,
} as const;

const FORMATS = ['in_person', 'online', 'hybrid'] as const;
const WINDOW_DAYS = {week: 7, month: 30} as const;
const DAY_MS = 86_400_000;

/**
 * Optional list filters: title search, format and a rolling date window. Anything else is ignored.
 * The cursor `?before=<startAt ISO>_<uuid>` must be well formed (a crafted one is 400, never a 500).
 */
type ListQuery = {
  before?: string;
  q?: string;
  format?: (typeof FORMATS)[number];
  when?: 'week' | 'month';
};

const listQuery = validator('query', (value, c) => {
  const one = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const cursor = parseKeysetCursor(one(value.before));
  if (cursor === 'invalid') return c.json(problem('bad_cursor', 'That page link is not valid. Start again from the first page.'), 400);
  const q = (one(value.q) ?? '').trim().slice(0, 80);
  if (hasNul(q)) return c.json({...problem('invalid_input', NUL_MESSAGE), fields: {q: NUL_MESSAGE}}, 422);
  const format = FORMATS.find(f => f === one(value.format));
  const w = one(value.when);
  const when = w === 'week' || w === 'month' ? w : undefined;
  // Keyed `before` (the query name), every key optional: the typed client takes its parameters from this type.
  const out: ListQuery = {before: cursor ? one(value.before) : undefined, q: q || undefined, format, when};
  return out;
});

const detailSelect = {...summarySelect, venueAddress: true, mapUrl: true, visibility: true, waitlistEnabled: true, status: true} as const;

/** The public detail as JSON-ready values (dates as ISO strings): the same shape on a cache hit and a miss. */
async function loadDetail(db: PrismaClient, slug: string) {
  const event = await db.event.findFirst({
    select: detailSelect,
    // A cancelled event stays readable (US-11): the page shows the "Cancelled" banner and no RSVP form.
    where: {slug, status: {in: ['published', 'cancelled']}, visibility: {in: ['public', 'unlisted']}, deletedAt: null},
  });
  return event ? {...event, startAt: event.startAt.toISOString(), endAt: event.endAt.toISOString()} : null;
}

export type PublicEventDetail = NonNullable<Awaited<ReturnType<typeof loadDetail>>>;

/**
 * One published (or cancelled) event by slug, through the Site Cache for PUBLIC events (`event-cache.ts`:
 * key `event:slug:<slug>`, 1 day, cleared by every event write in `admin-events.ts`). An unlisted event
 * is read from the database every time and never stored; nothing in the detail depends on the visitor.
 */
export async function publicEventDetail(db: PrismaClient, slug: string): Promise<PublicEventDetail | null> {
  const key = eventSlugKey(slug);
  if (!key) return loadDetail(db, slug);
  let read: PublicEventDetail | null = null;
  // `getOrSet` stores nothing for null: an unlisted (or missing) event answers null to the cache, and `read` to us.
  const cached = await cache.getOrSet<PublicEventDetail | null>(key, EVENT_DETAIL_TTL, async () => {
    read = await loadDetail(db, slug);
    return read?.visibility === 'public' ? read : null;
  });
  return cached ?? read;
}

export const eventRoutes = new Hono()
  .get('/', listQuery, withDb, async c => {
    const {before, q, format, when} = c.req.valid('query');
    // Already checked by `listQuery` (a malformed cursor answered 400 there).
    const parsed = parseKeysetCursor(before);
    const cursor = parsed === 'invalid' ? null : parsed;
    const rows = await c.var.db.event.findMany({
      // The ticket prices for the cards' price chip come with the events: one SQL query (relationJoins).
      select: {...summarySelect, ticketTypes: {select: {priceCents: true, currency: true}, take: 20}},
      where: {
        status: 'published',
        visibility: 'public',
        deletedAt: null,
        endAt: {gte: new Date()},
        ...(q ? {title: {contains: escapeLike(q), mode: 'insensitive' as const}} : {}),
        ...(format ? {format} : {}),
        ...(when ? {startAt: {lte: new Date(Date.now() + WINDOW_DAYS[when === 'week' ? 'week' : 'month'] * DAY_MS)}} : {}),
        ...(cursor
          ? // Millisecond cursor vs microsecond column (seed rows use now() + interval): compare at the cursor's precision.
            keysetAfter('startAt', 'asc', {at: cursor.startAt, id: cursor.id})
          : {}),
      },
      orderBy: [{startAt: 'asc'}, {id: 'asc'}],
      take: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    // Cheapest ticket per event for the cards' price chip.
    const priced = (tickets: {priceCents: number; currency: string}[]) => {
      let from: {amountCents: number; currency: string} | null = null;
      for (const t of tickets) if (!from || t.priceCents < from.amountCents) from = {amountCents: t.priceCents, currency: t.currency};
      return {fromPrice: from, free: !tickets.some(t => t.priceCents > 0)};
    };
    return c.json({
      events: page.map(({ticketTypes, ...e}) => ({
        ...e,
        startAt: e.startAt.toISOString(),
        endAt: e.endAt.toISOString(),
        ...priced(ticketTypes),
      })),
      next: rows.length > PAGE_SIZE && last ? `${last.startAt.toISOString()}_${last.id}` : null,
    });
  })

  // The host page's collapsed "Past events": latest first, one bounded page, no cursor. Before `/:slug`.
  .get('/past', withDb, async c => {
    const rows = await c.var.db.event.findMany({
      select: summarySelect,
      where: {status: 'published', visibility: 'public', deletedAt: null, endAt: {lt: new Date()}},
      orderBy: [{startAt: 'desc'}, {id: 'desc'}],
      take: PAST_LIMIT,
    });
    return c.json({
      events: rows.map(e => ({...e, startAt: e.startAt.toISOString(), endAt: e.endAt.toISOString(), fromPrice: null, free: true})),
      next: null,
    });
  })

  // Registered before `/:slug` so `sitemap` is not a slug.
  .get('/sitemap', withDb, async c => {
    const rows = await c.var.db.event.findMany({
      select: {slug: true, updatedAt: true},
      where: {status: 'published', visibility: 'public', deletedAt: null, endAt: {gte: new Date()}},
      orderBy: {startAt: 'asc'},
      take: SITEMAP_LIMIT,
    });
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json({events: rows.map(r => ({slug: r.slug, updatedAt: r.updatedAt.toISOString()}))});
  })

  .get('/:slug', withDb, async c => {
    const event = await publicEventDetail(c.var.db, c.req.param('slug'));
    if (!event) return c.json(problem('not_found', 'No such event.'), 404);
    // An unlisted event is reachable by its link only, and a cancelled one shouldn't rank: keep both out of indexes.
    if (event.visibility === 'unlisted' || event.status === 'cancelled') c.header('X-Robots-Tag', 'noindex');
    // The link is what keeps an unlisted event unlisted: no shared cache may keep or replay it (L-10).
    if (event.visibility === 'unlisted') c.header('Cache-Control', 'private, no-store');
    return c.json({event});
  });
