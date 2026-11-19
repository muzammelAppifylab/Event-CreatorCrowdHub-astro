import {cache} from '../platform/cache';

/**
 * The Site Cache keys for the PUBLIC event detail (`GET /site-api/events/:slug`, audit M-29).
 *
 *   event:slug:<slug>   the detail as the public route returns it, PUBLIC events only, 1 day
 *
 * The detail holds only the event's own columns (title, dates, venue, cover, capacity as a number,
 * status, visibility): the same for every visitor and nothing that moves by itself. Seats left,
 * the RSVP form and ticket prices come from other routes and are never cached here. Unlisted
 * events are never cached: their slug is the secret link, and cache keys are listed to staff.
 *
 * Every write to an event clears the WHOLE prefix (a slug can change, so the old key has to go
 * too): `clearPublicEvents()` right after the write succeeds, outside any transaction.
 */
export const EVENT_SLUG_PREFIX = 'event:slug:';
export const EVENT_DETAIL_TTL = 24 * 60 * 60;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** The key for a slug, or null when the slug isn't one we'd ever issue (never a key from free text). */
export const eventSlugKey = (slug: string): string | null => (SLUG.test(slug) ? `${EVENT_SLUG_PREFIX}${slug}` : null);

/** Clears every cached public event detail. Never throws: a failed clear only means the TTL decides. */
export async function clearPublicEvents(): Promise<void> {
  await cache.delPrefix(EVENT_SLUG_PREFIX).catch(() => false);
}
