import {Hono} from 'hono';

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

export const eventRoutes = new Hono()
  .get('/', withDb, async c => {
    const cursor = parseCursor(c.req.query('before'));
    const rows = await c.var.db.event.findMany({
      select: summarySelect,
      where: {
        status: 'published',
        visibility: 'public',
        deletedAt: null,
        endAt: {gte: new Date()},
        ...(cursor
          ? {OR: [{startAt: {gt: cursor.startAt}}, {startAt: cursor.startAt, id: {gt: cursor.id}}]}
          : {}),
      },
      orderBy: [{startAt: 'asc'}, {id: 'asc'}],
      take: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return c.json({
      events: page.map(e => ({...e, startAt: e.startAt.toISOString(), endAt: e.endAt.toISOString()})),
      next: rows.length > PAGE_SIZE && last ? `${last.startAt.toISOString()}_${last.id}` : null,
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
      select: {...summarySelect, venueAddress: true, mapUrl: true, joinUrl: true, visibility: true, waitlistEnabled: true},
      where: {slug: c.req.param('slug'), status: 'published', visibility: {in: ['public', 'unlisted']}, deletedAt: null},
    });
    if (!event) return c.json(problem('not_found', 'No such event.'), 404);
    // An unlisted event is reachable by its link only: keep it out of shared caches.
    if (event.visibility === 'unlisted') c.header('X-Robots-Tag', 'noindex');
    return c.json({event: {...event, startAt: event.startAt.toISOString(), endAt: event.endAt.toISOString()}});
  });
