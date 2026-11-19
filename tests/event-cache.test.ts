import {readFileSync} from 'node:fs';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {cache, setCacheModeForTests} from '../src/platform/cache';
import {clearPublicEvents, EVENT_SLUG_PREFIX, eventSlugKey} from '../src/server/event-cache';
import {publicEventDetail} from '../src/server/routes/events';

/** The public event detail through the Site Cache (audit M-29), on the in-memory stand-in. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  slug: 'launch-night',
  title: 'Launch night',
  description: null,
  coverImageUrl: null,
  coverPoster: null,
  startAt: new Date('2026-12-01T18:00:00Z'),
  endAt: new Date('2026-12-01T21:00:00Z'),
  timezone: 'UTC',
  format: 'in_person',
  venueName: 'Hall',
  capacity: 50,
  venueAddress: null,
  mapUrl: null,
  visibility: 'public',
  waitlistEnabled: false,
  status: 'published',
  ...over,
});
const fakeDb = (value: unknown) => {
  const findFirst = vi.fn(async (_args: unknown) => value);
  return {db: {event: {findFirst}} as never, findFirst};
};

beforeEach(() => setCacheModeForTests('memory'));
afterEach(() => setCacheModeForTests(null));

describe('public event detail cache', () => {
  it('serves a public event from the cache, with the same JSON shape on a hit and a miss', async () => {
    const {db, findFirst} = fakeDb(row());
    const first = await publicEventDetail(db, 'launch-night');
    const second = await publicEventDetail(db, 'launch-night');
    expect(first).toEqual(second);
    expect(first?.startAt).toBe('2026-12-01T18:00:00.000Z');
    expect(findFirst).toHaveBeenCalledTimes(1);
    // Only published or cancelled, public or unlisted, not deleted.
    expect(findFirst.mock.calls[0]![0]).toMatchObject({where: {slug: 'launch-night', status: {in: ['published', 'cancelled']}, deletedAt: null}});
  });

  it('never stores an unlisted event (its slug is the secret link) nor a miss', async () => {
    const unlisted = fakeDb(row({slug: 'secret-party', visibility: 'unlisted'}));
    expect((await publicEventDetail(unlisted.db, 'secret-party'))?.visibility).toBe('unlisted');
    await publicEventDetail(unlisted.db, 'secret-party');
    expect(unlisted.findFirst).toHaveBeenCalledTimes(2);
    expect(await cache.get(`${EVENT_SLUG_PREFIX}secret-party`)).toBeNull();

    const missing = fakeDb(null);
    expect(await publicEventDetail(missing.db, 'nothing-here')).toBeNull();
    await publicEventDetail(missing.db, 'nothing-here');
    expect(missing.findFirst).toHaveBeenCalledTimes(2);
  });

  it('a clear after a save shows the change on the next read', async () => {
    const {db, findFirst} = fakeDb(row());
    await publicEventDetail(db, 'launch-night');
    findFirst.mockResolvedValue(row({title: 'Launch night (moved)'}));
    expect((await publicEventDetail(db, 'launch-night'))?.title).toBe('Launch night');
    await clearPublicEvents();
    expect((await publicEventDetail(db, 'launch-night'))?.title).toBe('Launch night (moved)');
  });

  it('keys only well-formed slugs; anything else reads the database without a key', async () => {
    expect(eventSlugKey('launch-night')).toBe('event:slug:launch-night');
    for (const bad of ['', 'Launch', 'a b', '-x', 'x-', 'a'.repeat(61), 'x:y', '../x']) expect(eventSlugKey(bad)).toBeNull();
    const {db, findFirst} = fakeDb(row());
    await publicEventDetail(db, 'Weird Slug');
    await publicEventDetail(db, 'Weird Slug');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('every event write in admin-events clears the public cache', () => {
    const source = readFileSync('src/server/routes/admin-events.ts', 'utf8');
    const writes = source.match(/\b(?:db|tx)\.event\.(?:update|updateMany|delete|deleteMany|upsert)\(/g) ?? [];
    // Save, publish, unpublish, cancel, delete: each followed by a clear (creates are drafts, never cached).
    expect(writes.length).toBe(5);
    expect(source.match(/await clearPublicEvents\(\)/g)?.length).toBe(5);
  });
});
