import {Hono} from 'hono';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {problem, withDb} from '../../platform/guards';
import {normaliseSource} from './admin-analytics';

/**
 * Public page-view beacon (ported from CreatorCrowdHub; PRD privacy: "salted hashes, not IPs").
 * Mount: `.route('/pageviews', pageViewRoutes)`.
 *
 *   POST /pageviews/:slug   body {utmSource?}   → 204 always (recorded, deduplicated, or not counted),
 *                                                 429 when this IP sends too many
 *
 * Only published, public or unlisted events are counted. An unknown, malformed, draft, private,
 * cancelled or deleted slug gets the same empty 204, so the beacon cannot be used to find out which
 * slugs exist (L-8).
 *
 * No session. The app-wide `sameOrigin` + `csrf` guards already refuse cross-site and token-less
 * writes (call it with `siteFetch`). The raw IP and user agent only feed the hash and the in-memory
 * limiter; neither is stored or logged. The hash is salted with a RANDOM salt per UTC day, kept in
 * `page_view_salts` (one row per day, created on first use) and deleted after 2 days: once a day's
 * salt is gone nobody, the site included, can recompute a hash from an IP, and days cannot be
 * linked to each other (L-43). One row per
 * (event, visitor, day): `page_views_event_visitor_day_uq` + `ON CONFLICT DO NOTHING`.
 *
 * ABUSE LIMITS ARE BEST EFFORT: the counters live in this isolate's memory (bounded to MAX_TRACKED keys,
 * oldest windows evicted, then cleared), so N isolates allow roughly N x the limit. A database-backed
 * limiter would cost a write per beacon (more than the beacon itself), so it is deliberately not used.
 * The real bounds are the unique index (one row per visitor hash per day) and the per-event cap; a
 * spammer rotating user agents can only add analytics noise, never reach other data. Listed in the
 * security audit follow-ups.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** Beacons per IP and per event, per minute, per Worker isolate (best effort; the unique index is the real dedupe). */
export const BEACON_LIMIT = {perIp: 60, perEvent: 500, windowMs: 60_000};
const MAX_TRACKED = 5000;

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

/** "YYYY-MM-DD" of `at` in UTC. */
export const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/** Salts are kept this many days back from today, then deleted (today's and yesterday's stay). */
export const SALT_KEEP_DAYS = 2;

/** This isolate's copy of today's salt: one small value, so most beacons skip the salt query. */
let memo: {day: string; salt: string} | null = null;

type SaltRow = {salt: string; inserted: boolean};

/**
 * The random salt of `day` ("YYYY-MM-DD", UTC). The first beacon of the day creates it
 * (`ON CONFLICT DO NOTHING`: concurrent first beacons agree on one row) and deletes salts older than
 * SALT_KEEP_DAYS (a handful of rows, once a day). Tagged raw SQL: prepared, no generated model needed.
 */
export async function dailySalt(db: Pick<PrismaClient, '$queryRaw' | '$executeRaw'>, day: string): Promise<string> {
  if (memo?.day === day) return memo.salt;
  const fresh = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  // The CTE's insert is not visible to the outer read of the table (same snapshot): union both.
  let rows = await db.$queryRaw<SaltRow[]>`
    with ins as (
      insert into page_view_salts (day, salt) values (${day}::date, ${fresh})
      on conflict (day) do nothing
      returning salt
    )
    select salt, true as inserted from ins
    union all
    select salt, false as inserted from page_view_salts where day = ${day}::date
    limit 1`;
  // Lost a race with a transaction that committed after this statement's snapshot: read it again.
  if (rows.length === 0) rows = await db.$queryRaw<SaltRow[]>`select salt, false as inserted from page_view_salts where day = ${day}::date`;
  const row = rows[0];
  if (!row) throw new Error('page view salt missing');
  if (row.inserted) await db.$executeRaw`delete from page_view_salts where day < ${day}::date - ${SALT_KEEP_DAYS}::int`;
  memo = {day, salt: row.salt};
  return row.salt;
}

/** Tests only: forget this isolate's memoized salt. */
export const resetSaltMemo = () => {
  memo = null;
};

/** sha256(daySalt \n ip \n userAgent \n eventId): newlines stop "1.2.3.4"+"5x" colliding with "1.2.3.45"+"x". */
export async function visitorHash(input: {salt: string; ip: string; userAgent: string; eventId: string}): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode([input.salt, input.ip, input.userAgent, input.eventId].join('\n'))));
}

/** A small fixed-window counter, bounded in size (module memory is for tiny caches only). */
export function createLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, {start: number; n: number}>();
  return (key: string): boolean => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      if (hits.size >= MAX_TRACKED) {
        for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
        if (hits.size >= MAX_TRACKED) hits.clear();
      }
      hits.set(key, {start: t, n: 1});
      return true;
    }
    entry.n += 1;
    return entry.n <= limit;
  };
}

const ipLimit = createLimiter(BEACON_LIMIT.perIp, BEACON_LIMIT.windowMs);
const eventLimit = createLimiter(BEACON_LIMIT.perEvent, BEACON_LIMIT.windowMs);

/** A beacon must never break the page: a missing or odd body just means "no utm". */
const beaconBody = validator('json', value => {
  const raw = (value as {utmSource?: unknown} | null)?.utmSource;
  return {utmSource: typeof raw === 'string' ? normaliseSource(raw.slice(0, 200)) : null};
});

export const pageViewRoutes = new Hono().post('/:slug', beaconBody, withDb, async c => {
  const slug = c.req.param('slug');
  // Same answer as an event we don't count: nothing to learn from a probe.
  if (!SLUG.test(slug)) return c.body(null, 204);

  // The Worker's own view of the client; never x-forwarded-for, which anyone can send.
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (!ipLimit(ip)) return c.json(problem('rate_limited', 'Too many requests. Try again in a minute.'), 429);

  // Only what the public event page shows and is still running: published, public or unlisted, not
  // deleted (events_slug_live_uq: one live event per slug). Anything else is not counted, quietly.
  const event = await c.var.db.event.findFirst({
    where: {slug, deletedAt: null, status: 'published', visibility: {in: ['public', 'unlisted']}},
    select: {id: true},
  });
  if (!event) return c.body(null, 204);
  // Over the cap: drop quietly. The page does not care and a spammer learns nothing.
  if (!eventLimit(event.id)) return c.body(null, 204);

  const now = new Date();
  const day = utcDay(now);
  const salt = await dailySalt(c.var.db, day);
  const visitor = await visitorHash({salt, ip, userAgent: c.req.header('user-agent') ?? '', eventId: event.id});
  await c.var.db.pageView.createMany({
    data: [{eventId: event.id, visitorHash: visitor, utmSource: c.req.valid('json').utmSource, createdAt: now, day: new Date(`${day}T00:00:00.000Z`)}],
    skipDuplicates: true,
  });
  // 204 whether recorded or deduplicated, so the response does not reveal repeat visits.
  return c.body(null, 204);
});
