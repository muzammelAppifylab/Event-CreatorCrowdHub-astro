import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {createEvent, eventsApp, resetEvents, rsvpBody, userWith} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

const A = '/site-api/admin-events';

describe.skipIf(!DATABASE_URL)('events admin (integration, real Postgres)', () => {
  let owner: Browser;
  let admin: Browser;
  let staff: Browser;
  let member: Browser;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    await userWith('first@example.test', ['owner'], '203.0.113.1'); // throwaway: takes the owner slot
    owner = await userWith('owner@example.test', ['owner'], '203.0.113.5');
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
    staff = await userWith('staff@example.test', ['checkin_staff'], '203.0.113.3');
    member = await userWith('member@example.test', ['member'], '203.0.113.4');
  });

  it('gates event management: guest 401, member 403, checkin_staff 403, admin ok', async () => {
    const guest = new Browser(eventsApp, '203.0.113.9');
    expect((await guest.get(A)).status).toBe(401);
    expect((await member.get(A)).status).toBe(403);
    expect((await staff.get(A)).status).toBe(403);
    expect((await staff.post(A, {title: 'x'})).status).toBe(403);
    expect((await admin.get(A)).status).toBe(200);
    expect((await guest.post(A, {title: 'x'})).status).toBe(401);
  });

  it('a draft is hidden until published, then publicly readable; unpublish hides it again', async () => {
    const guest = new Browser(eventsApp, '203.0.113.9');
    const ev = await createEvent(admin, {}, false);
    expect((await guest.get(`/site-api/events/${ev.slug}`)).status).toBe(404);
    expect((await admin.post(`${A}/${ev.id}/publish`)).status).toBe(200);
    expect((await guest.get(`/site-api/events/${ev.slug}`)).status).toBe(200);
    const list = await guest.get('/site-api/events');
    expect((list.json.events as {slug: string}[]).map(e => e.slug)).toContain(ev.slug);
    expect((await admin.post(`${A}/${ev.id}/unpublish`)).status).toBe(200);
    expect((await guest.get(`/site-api/events/${ev.slug}`)).status).toBe(404);
  });

  it('refuses an event without a venue', async () => {
    const bad = await admin.post(A, {
      title: 'No venue',
      startAt: new Date(Date.now() + 1e9).toISOString(),
      endAt: new Date(Date.now() + 2e9).toISOString(),
      timezone: 'UTC',
      format: 'in_person',
    });
    expect(bad.status).toBe(422);
  });

  it('checkin_staff can only check in by ticket code, and only confirmed guests', async () => {
    const ev = await createEvent(admin);
    const made = await new Browser(eventsApp, '203.0.113.20').post(`/site-api/rsvp/events/${ev.slug}`, rsvpBody('guest1@example.test'));
    expect(made.status).toBe(202);
    const row = await db.rsvp.findFirstOrThrow({where: {email: 'guest1@example.test'}});
    const code = row.ticketCode;
    const door = '/site-api/checkin';

    expect((await new Browser(eventsApp, '203.0.113.9').get(`${door}/codes/${code}`)).status).toBe(401);
    expect((await member.get(`${door}/codes/${code}`)).status).toBe(403);
    const look = await staff.get(`${door}/codes/${code.toLowerCase()}`);
    expect(look.status).toBe(200);
    expect(JSON.stringify(look.json)).not.toContain('guest1@example.test');
    expect((await staff.post(`${door}/codes/${code}`, {checkedIn: true})).status).toBe(200);
    const first = (await db.rsvp.findUniqueOrThrow({where: {id: row.id}})).checkedInAt;
    expect(first).not.toBeNull();
    await staff.post(`${door}/codes/${code}`, {checkedIn: true});
    expect((await db.rsvp.findUniqueOrThrow({where: {id: row.id}})).checkedInAt).toEqual(first);
    expect((await staff.post(`${door}/codes/${code}`, {checkedIn: false})).status).toBe(200);
    expect((await staff.get(`${door}/codes/ZZZZZZZZ`)).status).toBe(404);
    // Staff cannot reach manager-only routes.
    expect((await staff.get(`${door}/events/${ev.id}/attendees`)).status).toBe(403);
    expect((await staff.get(`${A}/${ev.id}`)).status).toBe(403);
    expect((await admin.get(`${door}/codes/${code}`)).status).toBe(200);
  });

  it('refuses a check-in for a waitlisted guest', async () => {
    const ev = await createEvent(admin, {capacity: 1});
    await new Browser(eventsApp, '203.0.113.21').post(`/site-api/rsvp/events/${ev.slug}`, rsvpBody('a@example.test'));
    const w = await new Browser(eventsApp, '203.0.113.22').post(`/site-api/rsvp/events/${ev.slug}`, rsvpBody('b@example.test'));
    expect(w.status).toBe(202);
    expect((await db.rsvp.findFirstOrThrow({where: {email: 'b@example.test'}})).status).toBe('waitlisted');
    const row = await db.rsvp.findFirstOrThrow({where: {email: 'b@example.test'}});
    expect((await staff.post(`/site-api/checkin/codes/${row.ticketCode}`, {checkedIn: true})).status).toBe(409);
  });

  it('refuses a check-in for a maybe guest', async () => {
    const ev = await createEvent(admin, {capacity: 5});
    await new Browser(eventsApp, '203.0.113.31').post(`/site-api/rsvp/events/${ev.slug}`, {...rsvpBody('m@example.test'), response: 'maybe'});
    const row = await db.rsvp.findFirstOrThrow({where: {email: 'm@example.test'}});
    expect(row.response).toBe('maybe');
    expect((await staff.post(`/site-api/checkin/codes/${row.ticketCode}`, {checkedIn: true})).status).toBe(409);
  });

  it('webhooks: owner only (admin 403), and private or unsafe URLs are refused (SSRF)', async () => {
    const W = '/site-api/webhook-endpoints';
    expect((await staff.get(W)).status).toBe(403);
    expect((await admin.get(W)).status).toBe(403);
    expect((await owner.get(W)).status).toBe(200);
    for (const url of [
      'http://example.com/hook',
      'https://127.0.0.1/hook',
      'https://localhost/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://2130706433/hook',
      'https://0x7f.1/hook',
      'https://user:pw@example.com/hook',
      'https://example.com:8443/hook',
      'https://intranet/hook',
      'https://printer.local/hook',
    ]) {
      const res = await owner.post(W, {url, events: ['rsvp.created']});
      expect(res.status, url).toBe(422);
    }
    expect(await db.webhookEndpoint.count()).toBe(0);
    // A row planted in the database (older data) is still never fetched.
    const planted = await db.webhookEndpoint.create({data: {url: 'https://127.0.0.1/x', events: ['webhook.test'], secret: 'whsec_x', active: true}});
    const t = await owner.post(`${W}/${planted.id}/test`);
    expect(t.status).toBe(200);
    expect(t.json.ok).toBe(false);
    expect(t.json.status).toBeNull();
  });
});
