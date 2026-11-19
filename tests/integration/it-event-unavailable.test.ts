import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {hashToken, newToken} from '../../src/domain/secureToken';
import {createEvent, eventsApp, resetEvents, rsvpBody, userWith} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

/**
 * A guest's valid link to an event the host unpublished or deleted answers 410 `event_unavailable` with
 * only the title (no guest data, nothing to edit), so `/r/<token>` and `/i/<token>` can show a friendly
 * page. An unknown token stays a plain 404.
 */
const R = '/site-api/rsvp/events';
const M = '/site-api/rsvp/manage';
const I = '/site-api/rsvp/invite';
let n = 30;
const guest = () => new Browser(eventsApp, `198.51.100.${n++ % 250}`);

async function rsvpWithToken(slug: string, email: string) {
  expect((await guest().post(`${R}/${slug}`, rsvpBody(email))).status).toBe(202);
  const token = newToken();
  const row = await db.rsvp.findFirstOrThrow({where: {email}, select: {id: true}});
  await db.rsvp.update({where: {id: row.id}, data: {manageToken: hashToken(token)}});
  return token;
}

describe.skipIf(!DATABASE_URL)('event no longer available: 410 vs 404 (integration, real Postgres)', () => {
  let admin: Browser;
  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
  });

  it('manage token: 200 while published, 410 with only the title once unpublished or deleted; unknown stays 404', async () => {
    const ev = await createEvent(admin, {title: 'Gone Gala'});
    const token = await rsvpWithToken(ev.slug, 'g@example.test');
    expect((await guest().get(`${M}/${token}`)).status).toBe(200);

    await db.event.update({where: {id: ev.id}, data: {status: 'draft'}});
    const draft = await guest().get(`${M}/${token}`);
    expect(draft.status).toBe(410);
    expect(draft.json).toEqual({error: 'event_unavailable', message: expect.any(String), event: {title: 'Gone Gala'}});
    expect(JSON.stringify(draft.json)).not.toContain('g@example.test');
    expect(draft.headers.get('cache-control')).toBe('private, no-store');
    expect(draft.headers.get('x-robots-tag')).toBe('noindex');

    // Nothing to change, cancel or download either.
    expect((await guest().request('PATCH', `${M}/${token}`, rsvpBody('g@example.test', {response: 'not_going'}))).status).toBe(410);
    expect((await guest().post(`${M}/${token}/cancel`)).status).toBe(410);
    expect((await guest().get(`${M}/${token}/calendar.ics`)).status).toBe(410);
    expect((await db.rsvp.findFirstOrThrow({where: {email: 'g@example.test'}})).status).toBe('confirmed');

    await db.event.update({where: {id: ev.id}, data: {status: 'published', deletedAt: new Date()}});
    const deleted = await guest().get(`${M}/${token}`);
    expect(deleted.status).toBe(410);
    expect(deleted.json.event).toEqual({title: 'Gone Gala'});

    const unknown = await guest().get(`${M}/${newToken()}`);
    expect(unknown.status).toBe(404);
    expect(unknown.json.error).toBe('not_found');
  });

  it('invite token: 410 when the event is unpublished or deleted, 404 when unknown or bounced', async () => {
    const ev = await createEvent(admin, {title: 'Invite Only'});
    const live = await db.invite.create({data: {eventId: ev.id, email: 'i@example.test', token: `inv-${newToken().slice(0, 16)}`, status: 'sent', sentAt: new Date()}});
    const bounced = await db.invite.create({data: {eventId: ev.id, email: 'b@example.test', token: `inv-${newToken().slice(0, 16)}`, status: 'bounced'}});
    expect((await guest().get(`${I}/${live.token}`)).status).toBe(200);

    await db.event.update({where: {id: ev.id}, data: {status: 'draft'}});
    const draft = await guest().get(`${I}/${live.token}`);
    expect(draft.status).toBe(410);
    expect(draft.json).toEqual({error: 'event_unavailable', message: expect.any(String), event: {title: 'Invite Only'}});
    expect((await guest().get(`${I}/${bounced.token}`)).status).toBe(404);

    await db.event.update({where: {id: ev.id}, data: {status: 'published', deletedAt: new Date()}});
    expect((await guest().get(`${I}/${live.token}`)).status).toBe(410);
    expect((await guest().get(`${I}/inv-unknown-${newToken().slice(0, 12)}`)).status).toBe(404);
  });
});
