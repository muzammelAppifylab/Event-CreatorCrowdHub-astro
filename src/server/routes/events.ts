import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {problem, withDb} from '../../platform/guards';

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

/** Cursor `<startAt ISO>_<id>`; anything malformed means "first page". */
function parseCursor(raw: string | undefined): {startAt: Date; id: string} | null {
  const [iso, id] = (raw ?? '').split('_');
  const startAt = new Date(iso ?? '');
  return id && /^[0-9a-f-]{36}$/.test(id) && !Number.isNaN(startAt.getTime()) ? {startAt, id} : null;
}

const FORMATS = ['in_person', 'online', 'hybrid'] as const;
const WINDOW_DAYS = {week: 7, month: 30} as const;
const DAY_MS = 86_400_000;

/** Optional list filters: title search, format and a rolling date window. Anything else is ignored. */
const listQuery = validator('query', value => {
  const one = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const q = (one(value.q) ?? '').trim().slice(0, 80);
  const format = FORMATS.find(f => f === one(value.format));
  const w = one(value.when);
  const when = w === 'week' || w === 'month' ? w : undefined;
  return {before: one(value.before), q: q || undefined, format, when};
});

export const eventRoutes = new Hono()
  .get('/', listQuery, withDb, async c => {
    const {before, q, format, when} = c.req.valid('query');
    const cursor = parseCursor(before);
    const rows = await c.var.db.event.findMany({
      select: summarySelect,
      where: {
        status: 'published',
        visibility: 'public',
        deletedAt: null,
        endAt: {gte: new Date()},
        ...(q ? {title: {contains: q, mode: 'insensitive' as const}} : {}),
        ...(format ? {format} : {}),
        ...(when ? {startAt: {lte: new Date(Date.now() + WINDOW_DAYS[when === 'week' ? 'week' : 'month'] * DAY_MS)}} : {}),
        ...(cursor
          ? {OR: [{startAt: {gt: cursor.startAt}}, {startAt: cursor.startAt, id: {gt: cursor.id}}]}
          : {}),
      },
      orderBy: [{startAt: 'asc'}, {id: 'asc'}],
      take: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    // Cheapest ticket per event for the cards' price chip (one bounded, explicit-select query).
    const tickets = page.length
      ? await c.var.db.ticketType.findMany({
          where: {eventId: {in: page.map(e => e.id)}},
          select: {eventId: true, priceCents: true, currency: true},
          take: PAGE_SIZE * 20,
        })
      : [];
    const cheapest = new Map<string, {amountCents: number; currency: string}>();
    const paid = new Set<string>();
    for (const t of tickets) {
      if (t.priceCents > 0) paid.add(t.eventId);
      const best = cheapest.get(t.eventId);
      if (!best || t.priceCents < best.amountCents) cheapest.set(t.eventId, {amountCents: t.priceCents, currency: t.currency});
    }
    return c.json({
      events: page.map(e => ({
        ...e,
        startAt: e.startAt.toISOString(),
        endAt: e.endAt.toISOString(),
        fromPrice: cheapest.get(e.id) ?? null,
        free: !paid.has(e.id),
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
    const event = await c.var.db.event.findFirst({
      select: {...summarySelect, venueAddress: true, mapUrl: true, visibility: true, waitlistEnabled: true},
      where: {slug: c.req.param('slug'), status: 'published', visibility: {in: ['public', 'unlisted']}, deletedAt: null},
    });
    if (!event) return c.json(problem('not_found', 'No such event.'), 404);
    // An unlisted event is reachable by its link only: keep it out of shared caches.
    if (event.visibility === 'unlisted') c.header('X-Robots-Tag', 'noindex');
    return c.json({event: {...event, startAt: event.startAt.toISOString(), endAt: event.endAt.toISOString()}});
  });
