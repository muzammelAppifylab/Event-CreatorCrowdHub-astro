import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {config} from '../../platform/config';
import {problem, withDb} from '../../platform/guards';
import {normaliseSource} from './admin-analytics';

/**
 * Public page-view beacon (ported from CreatorCrowdHub; PRD privacy: "salted hashes, not IPs").
 * Mount: `.route('/pageviews', pageViewRoutes)`.
 *
 *   POST /pageviews/:slug   body {utmSource?}   → 204 always (recorded or deduplicated)
 *
 * No session. The app-wide `sameOrigin` + `csrf` guards already refuse cross-site and token-less
 * writes (call it with `siteFetch`). The raw IP and user agent only feed the hash and the in-memory
 * limiter; neither is stored or logged. The hash is salted with an HMAC of the UTC date, so it
 * rotates at midnight and yesterday's hashes cannot be linked to today's. One row per
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

async function dailySalt(secret: string, at: Date): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`page-view-salt:${utcDay(at)}`)));
}

/** sha256(dailySalt \n ip \n userAgent \n eventId): newlines stop "1.2.3.4"+"5x" colliding with "1.2.3.45"+"x". */
export async function visitorHash(input: {secret: string; at: Date; ip: string; userAgent: string; eventId: string}): Promise<string> {
  const salt = await dailySalt(input.secret, input.at);
  return hex(await crypto.subtle.digest('SHA-256', enc.encode([salt, input.ip, input.userAgent, input.eventId].join('\n'))));
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
  if (!SLUG.test(slug)) return c.json(problem('not_found', 'Event not found.'), 404);
  const secret = config.jwtSecret;
  if (!secret) return c.body(null, 204);

  // The Worker's own view of the client; never x-forwarded-for, which anyone can send.
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (!ipLimit(ip)) return c.json(problem('rate_limited', 'Too many requests. Try again in a minute.'), 429);

  // Live and visible: not a draft, not deleted (events_slug_live_uq: one live event per slug).
  const event = await c.var.db.event.findFirst({
    where: {slug, deletedAt: null, status: {not: 'draft'}},
    select: {id: true},
  });
  if (!event) return c.json(problem('not_found', 'Event not found.'), 404);
  // Over the cap: drop quietly. The page does not care and a spammer learns nothing.
  if (!eventLimit(event.id)) return c.body(null, 204);

  const now = new Date();
  const visitor = await visitorHash({secret, at: now, ip, userAgent: c.req.header('user-agent') ?? '', eventId: event.id});
  await c.var.db.pageView.createMany({
    data: [{eventId: event.id, visitorHash: visitor, utmSource: c.req.valid('json').utmSource, createdAt: now, day: new Date(`${utcDay(now)}T00:00:00.000Z`)}],
    skipDuplicates: true,
  });
  // 204 whether recorded or deduplicated, so the response does not reveal repeat visits.
  return c.body(null, 204);
});
