import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {authRoutes} from '../../src/platform/auth';
import {csrf, previewCookies, sameOrigin} from '../../src/platform/guards';
import {syncPermissions} from '../../src/platform/permission-sync';
import {authSettings} from '../../src/server/auth-settings';
import {CATALOGUE} from '../../src/server/permissions';
import {adminMessageRoutes} from '../../src/server/routes/admin-messages';
import {resetEvents, setRoles} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

const mail = vi.hoisted(() => ({sent: [] as {to: string; subject: string; text: string}[], failNext: 0}));
vi.mock('../../src/server/guest-mail', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/server/guest-mail')>();
  return {
    ...real,
    sendMail: async (m: {to: string; subject: string; text: string}) => {
      if (mail.failNext > 0) {
        mail.failNext -= 1;
        return {ok: false};
      }
      mail.sent.push({to: m.to, subject: m.subject, text: m.text});
      return {ok: true};
    },
  };
});

/** Same middleware chain as src/server/app.ts, with the event admin routes mounted at /event-admin. */
const app = new Hono()
  .basePath('/site-api')
  .use(previewCookies)
  .use(sameOrigin)
  .use(csrf)
  .use(bodyLimit({maxSize: 1024 * 1024}))
  .use(syncPermissions(CATALOGUE))
  .route('/auth', authRoutes({...authSettings, requireEmailVerification: true}))
  .route('/event-admin', adminMessageRoutes);

async function userWith(email: string, roles: string[], ip: string) {
  const b = await signedIn(app, email, undefined, ip);
  await setRoles(email, ...roles);
  return b;
}

/** Inserted directly: the admin-events API is not under test here. */
let seq = 0;
async function createEvent(over: Record<string, unknown> = {}) {
  seq += 1;
  return db.event.create({
    data: {
      slug: `msg-event-${seq}`,
      title: 'Pricing Workshop',
      startAt: new Date(Date.now() + 10 * 24 * 3_600_000),
      endAt: new Date(Date.now() + 10 * 24 * 3_600_000 + 2 * 3_600_000),
      timezone: 'UTC',
      format: 'online',
      joinUrl: 'https://zoom.example/j/123',
      status: 'published',
      pollJoinCode: `M${String(seq).padStart(5, '0')}`,
      ...over,
    },
    select: {id: true, slug: true, endAt: true},
  });
}

let gseq = 0;
function guestData(eventId: string, over: Record<string, unknown> = {}) {
  gseq += 1;
  return {
    eventId,
    name: `Guest ${gseq} Lastname`,
    email: `guest${gseq}@x.com`,
    response: 'going' as const,
    status: 'confirmed' as const,
    ticketCode: `T${String(gseq).padStart(7, '0')}`,
    manageToken: `mt-${gseq}-${Math.random()}`,
    ...over,
  };
}
const addGuests = (eventId: string, ...overs: Record<string, unknown>[]) =>
  db.rsvp.createMany({data: overs.map(o => guestData(eventId, o))});

const base = (id: string, rest = '') => `/site-api/event-admin/events/${id}/messages${rest}`;
const ruleInput = {kind: 'reminder', offsetMinutes: -1440, subject: 'Tomorrow: {{event.title}}', body: 'Hi {{guest.first_name}}'};
const KEY = '6f1c2b9e-1d3a-4c5b-8e7f-0a1b2c3d4e5f';
const NIL = '00000000-0000-4000-8000-000000000000';

describe.skipIf(!DATABASE_URL)('admin messages (integration, real Postgres)', () => {
  let admin: Browser;
  let member: Browser;
  let guest: Browser;
  let e: Awaited<ReturnType<typeof createEvent>>;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    mail.sent.length = 0;
    mail.failNext = 0;
    await userWith('first@example.test', ['owner'], '203.0.113.1');
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
    member = await userWith('member@example.test', ['member'], '203.0.113.4');
    guest = new Browser(app, '203.0.113.9');
    e = await createEvent();
  });

  it('gates every endpoint: guest 401, non-manager 403', async () => {
    const calls: [string, string, unknown?][] = [
      ['get', base(e.id)],
      ['get', base(e.id, '/segments')],
      ['get', base(e.id, '/rules')],
      ['post', base(e.id, '/rules'), ruleInput],
      ['post', base(e.id, '/preview'), {kind: 'reminder', subject: 'x', body: 'y'}],
      ['post', base(e.id, '/broadcast'), {segment: 'all', subject: 'x', body: 'y', expectedCount: 0}],
      ['post', base(e.id, `/rules/${NIL}/toggle`), {enabled: true}],
      ['delete', base(e.id, `/rules/${NIL}`)],
    ];
    for (const [method, path, body] of calls) {
      const g = await (guest as never as Record<string, (p: string, b?: unknown) => Promise<{status: number}>>)[method]!(path, body);
      const m = await (member as never as Record<string, (p: string, b?: unknown) => Promise<{status: number}>>)[method]!(path, body);
      expect([method, path, g.status, m.status]).toEqual([method, path, 401, 403]);
    }
    expect((await admin.get(base(e.id))).status).toBe(200);
    expect((await admin.get(base('junk'))).status).toBe(404);
    expect((await admin.get(base(NIL))).status).toBe(404);
  });

  describe('reminder rules', () => {
    it('creates, lists, edits and toggles rules', async () => {
      const created = await admin.post(base(e.id, '/rules'), ruleInput);
      expect(created.status).toBe(201);
      expect(created.json).toMatchObject({kind: 'reminder', offsetMinutes: -1440, enabled: true, eventId: e.id});
      const id = created.json.id as string;

      const patched = await admin.request('PATCH', base(e.id, `/rules/${id}`), {offsetMinutes: -120, subject: 'Soon', kind: 'thank_you'});
      expect(patched.status).toBe(200);
      expect(patched.json).toMatchObject({kind: 'reminder', offsetMinutes: -120, subject: 'Soon', body: 'Hi {{guest.first_name}}'});

      const toggled = await admin.post(base(e.id, `/rules/${id}/toggle`), {enabled: false});
      expect(toggled.json.enabled).toBe(false);

      const list = await admin.get(base(e.id, '/rules'));
      expect((list.json.rules as unknown[]).length).toBe(1);
      expect((list.json.rules as {offsetMinutes: number; enabled: boolean}[])[0]).toMatchObject({offsetMinutes: -120, enabled: false});

      expect((await admin.delete(base(e.id, `/rules/${id}`))).json).toEqual({ok: true});
      expect((await admin.delete(base(e.id, `/rules/${id}`))).status).toBe(404);
      expect(await db.reminderRule.count()).toBe(0);
    });

    it('lists rules by offset', async () => {
      await admin.post(base(e.id, '/rules'), ruleInput);
      await admin.post(base(e.id, '/rules'), {...ruleInput, offsetMinutes: -60 * 24 * 7});
      await admin.post(base(e.id, '/rules'), {...ruleInput, offsetMinutes: -60});
      const rules = (await admin.get(base(e.id, '/rules'))).json.rules as {offsetMinutes: number}[];
      expect(rules.map(r => r.offsetMinutes)).toEqual([-10080, -1440, -60]);
    });

    it('422s on unknown merge tags, naming them in fields.body', async () => {
      const res = await admin.post(base(e.id, '/rules'), {...ruleInput, body: 'Hi {{guest.nickname}} {{event.foo}}'});
      expect(res.status).toBe(422);
      const fields = res.json.fields as Record<string, string>;
      expect(fields.body).toBe('Unknown merge tags: {{guest.nickname}}, {{event.foo}}');
      expect(fields.subject).toBeUndefined();
    });

    it('422s on bad kind, offsets outside the kind range, empty or oversized copy', async () => {
      const bad = async (over: Record<string, unknown>, field: string) => {
        const res = await admin.post(base(e.id, '/rules'), {...ruleInput, ...over});
        expect([JSON.stringify(over), res.status]).toEqual([JSON.stringify(over), 422]);
        expect(Object.keys(res.json.fields as object)).toContain(field);
      };
      await bad({kind: 'nope'}, 'kind');
      await bad({offsetMinutes: 30}, 'offsetMinutes'); // reminder: only before the start
      await bad({offsetMinutes: -14 * 24 * 60 - 1}, 'offsetMinutes');
      await bad({offsetMinutes: 1.5}, 'offsetMinutes');
      await bad({kind: 'thank_you', offsetMinutes: 7 * 24 * 60 + 1}, 'offsetMinutes');
      await bad({kind: 'confirmation', offsetMinutes: 5}, 'offsetMinutes');
      await bad({kind: 'live_now', offsetMinutes: 61}, 'offsetMinutes');
      await bad({subject: '  '}, 'subject');
      await bad({subject: 'x'.repeat(201)}, 'subject');
      await bad({body: ''}, 'body');
      await bad({body: 'x'.repeat(10_001)}, 'body');
      await bad({enabled: 'yes'}, 'enabled');
      // Edges that are fine.
      expect((await admin.post(base(e.id, '/rules'), {...ruleInput, offsetMinutes: -14 * 24 * 60})).status).toBe(201);
      expect((await admin.post(base(e.id, '/rules'), {...ruleInput, kind: 'thank_you', offsetMinutes: 7 * 24 * 60})).status).toBe(201);
      expect((await admin.post(base(e.id, '/rules'), {...ruleInput, kind: 'live_now', offsetMinutes: -60})).status).toBe(201);
    });

    it("refuses a 'we're live' rule for an in-person event, and a second confirmation rule", async () => {
      const inPerson = await createEvent({format: 'in_person', venueName: 'Studio', joinUrl: null});
      const live = await admin.post(base(inPerson.id, '/rules'), {kind: 'live_now', offsetMinutes: 0, subject: 'Live', body: 'Now'});
      expect(live.status).toBe(422);
      expect((live.json.fields as Record<string, string>).kind).toBeDefined();

      const conf = {kind: 'confirmation', offsetMinutes: 0, subject: 'Thanks', body: 'See you'};
      expect((await admin.post(base(e.id, '/rules'), conf)).status).toBe(201);
      expect((await admin.post(base(e.id, '/rules'), conf)).status).toBe(409);
    });

    it('allows at most 50 rules per event', async () => {
      await db.reminderRule.createMany({data: Array.from({length: 50}, (_, i) => ({eventId: e.id, kind: 'reminder' as const, offsetMinutes: -i, subject: 's', body: 'b'}))});
      const res = await admin.post(base(e.id, '/rules'), ruleInput);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.json)).toContain('too_many_rules');
    });

    it('patch validates against the existing kind and rejects bad fields', async () => {
      const id = (await admin.post(base(e.id, '/rules'), ruleInput)).json.id as string;
      const patch = (body: unknown) => admin.request('PATCH', base(e.id, `/rules/${id}`), body);
      expect((await patch({offsetMinutes: 10})).status).toBe(422);
      expect((await patch({offsetMinutes: 'x'})).status).toBe(422);
      expect((await patch({enabled: 'maybe'})).status).toBe(422);
      expect((await patch({subject: ''})).status).toBe(422);
      expect((await patch({body: 'Hi {{nope}}'})).status).toBe(422);
      expect((await patch({enabled: false})).json.enabled).toBe(false);
    });

    it('toggle validates {enabled}', async () => {
      const id = (await admin.post(base(e.id, '/rules'), ruleInput)).json.id as string;
      expect((await admin.post(base(e.id, `/rules/${id}/toggle`), {enabled: 'on'})).status).toBe(422);
      expect((await admin.post(base(e.id, `/rules/${id}/toggle`), {})).status).toBe(422);
    });

    it("404s a rule of another event and malformed ids", async () => {
      const other = await createEvent();
      const rule = await db.reminderRule.create({data: {eventId: other.id, kind: 'reminder', offsetMinutes: -5, subject: 's', body: 'b'}});
      expect((await admin.request('PATCH', base(e.id, `/rules/${rule.id}`), {subject: 'x'})).status).toBe(404);
      expect((await admin.post(base(e.id, `/rules/${rule.id}/toggle`), {enabled: false})).status).toBe(404);
      expect((await admin.delete(base(e.id, `/rules/${rule.id}`))).status).toBe(404);
      expect((await admin.post(base(e.id, '/rules/not-a-uuid/toggle'), {enabled: true})).status).toBe(404);
      expect((await db.reminderRule.findUniqueOrThrow({where: {id: rule.id}})).enabled).toBe(true);
    });
  });

  describe('preview', () => {
    it('renders for the first confirmed guest, else sample data, and reports unknown tags', async () => {
      const sample = await admin.post(base(e.id, '/preview'), {kind: 'reminder', subject: 'Hi {{guest.first_name}}', body: '{{oops}}'});
      expect(sample.status).toBe(200);
      expect(sample.json.recipient).toEqual({name: 'Sam Rivera', sample: true});
      expect(sample.json.subject).toBe('Hi Sam');
      expect(sample.json.unknownTags).toEqual(['oops']);
      expect(String(sample.json.html).toLowerCase()).toContain('<!doctype html>');
      expect(typeof sample.json.text).toBe('string');

      await addGuests(e.id, {name: 'Priya Shah'});
      const real = await admin.post(base(e.id, '/preview'), {kind: 'broadcast', subject: 'Hi {{guest.first_name}}', body: 'x'});
      expect(real.json.recipient).toEqual({name: 'Priya Shah', sample: false});
      expect(real.json.subject).toBe('Hi Priya');
      expect(mail.sent).toHaveLength(0);
    });

    it('previews every kind and rejects an unknown one', async () => {
      for (const kind of ['confirmation', 'reminder', 'live_now', 'thank_you', 'broadcast']) {
        const res = await admin.post(base(e.id, '/preview'), {kind, subject: 'S', body: 'B'});
        expect([kind, res.status]).toEqual([kind, 200]);
      }
      const bad = await admin.post(base(e.id, '/preview'), {kind: 'spam', subject: 'S', body: 'B'});
      expect(bad.status).toBe(422);
      expect((bad.json.fields as Record<string, string>).kind).toBeDefined();
    });
  });

  describe('segments and broadcasts', () => {
    const seed = (id: string) =>
      addGuests(
        id,
        {response: 'going', checkedInAt: new Date()},
        {response: 'going'},
        {response: 'going', attended: true},
        {response: 'maybe'},
        {status: 'waitlisted'},
        {status: 'pending'},
        {status: 'declined', response: 'not_going'},
        {status: 'cancelled'}
      );

    it('counts every segment; no-shows only after the end', async () => {
      await seed(e.id);
      const before = await admin.get(base(e.id, '/segments'));
      expect(before.json).toEqual({counts: {going: 3, maybe: 1, waitlisted: 1, pending: 1, checked_in: 1, no_show: 0, all: 6}, eventEnded: false});
      await db.event.update({where: {id: e.id}, data: {startAt: new Date(Date.now() - 3 * 3_600_000), endAt: new Date(Date.now() - 3_600_000)}});
      const after = await admin.get(base(e.id, '/segments'));
      expect((after.json.counts as Record<string, number>).no_show).toBe(1);
      expect(after.json.eventEnded).toBe(true);
    });

    it('sends to the confirmed count, logs the message and one delivery per guest, audits', async () => {
      await seed(e.id);
      const res = await admin.post(base(e.id, '/broadcast'), {
        segment: 'going',
        subject: 'Room change for {{event.title}}',
        body: 'Hi {{guest.first_name}}, we moved to room 2.',
        expectedCount: 3,
      });
      expect(res.status).toBe(201);
      const adminId = await userId('admin@example.test');
      expect(res.json.message).toMatchObject({segment: 'going', sentCount: 3, failedCount: 0, sentBy: adminId});
      expect(res.json.failed).toBe(0);
      expect(mail.sent.map(m => m.subject)).toEqual(Array(3).fill('Room change for Pricing Workshop'));
      const messageId = (res.json.message as {id: string}).id;
      expect(await db.messageDelivery.count({where: {messageId, status: 'sent'}})).toBe(3);

      const log = await admin.get(base(e.id));
      const items = log.json.items as {subject: string; sentCount: number}[];
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({subject: 'Room change for {{event.title}}', sentCount: 3});
      expect(log.json.nextBefore).toBeNull();

      const audits = await db.auditEvent.findMany({where: {action: 'message_broadcast'}});
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({actorUserId: adminId, targetType: 'event', targetId: e.id});
      expect(audits[0]!.meta).toEqual({sent: 3, failed: 0});
    });

    it('sends to waitlisted, pending, maybe, all and checked_in segments with the right recipients', async () => {
      await seed(e.id);
      const send = async (segment: string, expectedCount: number) => {
        mail.sent.length = 0;
        const r = await admin.post(base(e.id, '/broadcast'), {segment, subject: `s-${segment}`, body: 'b', expectedCount});
        expect([segment, r.status]).toEqual([segment, 201]);
        return mail.sent.length;
      };
      expect(await send('waitlisted', 1)).toBe(1);
      expect(await send('pending', 1)).toBe(1);
      expect(await send('maybe', 1)).toBe(1);
      expect(await send('checked_in', 1)).toBe(1);
      expect(await send('all', 6)).toBe(6);
      // Declined and cancelled guests are never mailed.
      const declined = await db.rsvp.findMany({where: {status: {in: ['declined', 'cancelled']}}, select: {email: true}});
      expect(declined.length).toBe(2);
    });

    it('409s when the segment changed since the host confirmed, and sends nothing', async () => {
      await seed(e.id);
      const res = await admin.post(base(e.id, '/broadcast'), {segment: 'going', subject: 'x', body: 'y', expectedCount: 2});
      expect(res.status).toBe(409);
      expect(String(res.json.message ?? '')).toContain('now has 3 guests');
      expect(mail.sent).toHaveLength(0);
      expect(await db.message.count()).toBe(0);
    });

    it('counts failed sends in the log', async () => {
      await seed(e.id);
      mail.failNext = 1;
      const res = await admin.post(base(e.id, '/broadcast'), {segment: 'going', subject: 'x', body: 'y', expectedCount: 3});
      expect(res.status).toBe(201);
      expect(res.json.message).toMatchObject({sentCount: 2, failedCount: 1});
      expect(res.json.failed).toBe(1);
      const log = await admin.get(base(e.id));
      expect((log.json.items as unknown[])[0]).toMatchObject({sentCount: 2, failedCount: 1});
      expect(await db.messageDelivery.count({where: {status: 'failed'}})).toBe(1);
      expect((await db.auditEvent.findFirstOrThrow({where: {action: 'message_broadcast'}})).meta).toEqual({sent: 2, failed: 1});
    });

    it('422s on unknown tags, an empty segment and malformed bodies', async () => {
      const tags = await admin.post(base(e.id, '/broadcast'), {segment: 'all', subject: '{{nope}}', body: 'y', expectedCount: 0});
      expect(tags.status).toBe(422);
      expect((tags.json.fields as Record<string, string>).subject).toBe('Unknown merge tag: {{nope}}');
      const empty = await admin.post(base(e.id, '/broadcast'), {segment: 'all', subject: 'x', body: 'y', expectedCount: 0});
      expect(empty.status).toBe(422);
      expect((empty.json.fields as Record<string, string>).segment).toBeDefined();
      const ok = {segment: 'all', subject: 'x', body: 'y', expectedCount: 0};
      for (const over of [{segment: 'everyone'}, {subject: ''}, {body: ' '}, {expectedCount: -1}, {expectedCount: 1.5}, {expectedCount: '3'}]) {
        expect([JSON.stringify(over), (await admin.post(base(e.id, '/broadcast'), {...ok, ...over})).status]).toEqual([JSON.stringify(over), 422]);
      }
    });

    it('refuses to message guests of a draft event', async () => {
      const draft = await createEvent({status: 'draft'});
      await addGuests(draft.id, {});
      const res = await admin.post(base(draft.id, '/broadcast'), {segment: 'all', subject: 'x', body: 'y', expectedCount: 1});
      expect(res.status).toBe(409);
      expect(mail.sent).toHaveLength(0);
    });

    it('caps a broadcast at 500 recipients (501 refused, 500 sent)', { timeout: 180_000 }, async () => {
      await addGuests(e.id, ...Array.from({length: 501}, () => ({})));
      const over = await admin.post(base(e.id, '/broadcast'), {segment: 'all', subject: 'x', body: 'y', expectedCount: 501});
      expect(over.status).toBe(422);
      expect((over.json.fields as Record<string, string>).segment).toContain('500');
      expect(mail.sent).toHaveLength(0);
      expect(await db.message.count()).toBe(0);

      await db.rsvp.deleteMany({where: {id: (await db.rsvp.findFirstOrThrow({where: {eventId: e.id}})).id}});
      const ok = await admin.post(base(e.id, '/broadcast'), {segment: 'all', subject: 'x', body: 'y', expectedCount: 500});
      expect(ok.status).toBe(201);
      expect((ok.json.message as {sentCount: number}).sentCount).toBe(500);
      expect(mail.sent).toHaveLength(500);
    });
  });

  describe('broadcast idempotency', () => {
    const body = {segment: 'all', subject: 'Room change', body: 'Room 2', expectedCount: 2, idempotencyKey: KEY};

    it('a repeated key returns the first message (200) and sends nothing more', async () => {
      await addGuests(e.id, {}, {});
      const first = await admin.post(base(e.id, '/broadcast'), body);
      expect(first.status).toBe(201);
      // The segment grew since: a retry must still answer with the original send, not a 409.
      await addGuests(e.id, {});
      const again = await admin.post(base(e.id, '/broadcast'), body);
      expect(again.status).toBe(200);
      expect(again.json).toEqual(first.json);
      expect(mail.sent).toHaveLength(2);
      expect(await db.message.count()).toBe(1);

      const other = await admin.post(base(e.id, '/broadcast'), {...body, expectedCount: 3, idempotencyKey: '0d9e8f7a-6b5c-4d3e-9f1a-2b3c4d5e6f70'});
      expect(other.status).toBe(201);
      expect(mail.sent).toHaveLength(5);
    });

    it('is scoped to the event: the same key on another event is a new send', async () => {
      const other = await createEvent();
      await addGuests(e.id, {}, {});
      await addGuests(other.id, {}, {});
      expect((await admin.post(base(e.id, '/broadcast'), body)).status).toBe(201);
      expect((await admin.post(base(other.id, '/broadcast'), body)).status).toBe(201);
    });

    it('two identical requests racing past the lookup still send once', async () => {
      await addGuests(e.id, {}, {});
      const [a, b] = await Promise.all([admin.post(base(e.id, '/broadcast'), body), admin.post(base(e.id, '/broadcast'), body)]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((a.json.message as {id: string}).id).toBe((b.json.message as {id: string}).id);
      expect(await db.message.count()).toBe(1);
      expect(mail.sent).toHaveLength(2);
    });

    it('rejects a malformed key and still works without one', async () => {
      await addGuests(e.id, {}, {});
      expect((await admin.post(base(e.id, '/broadcast'), {...body, idempotencyKey: 'not-a-uuid'})).status).toBe(422);
      const {idempotencyKey: _omit, ...noKey} = body;
      void _omit;
      expect((await admin.post(base(e.id, '/broadcast'), noKey)).status).toBe(201);
    });
  });

  describe('message log paging', () => {
    it('pages the log 50 at a time, newest first, by cursor', async () => {
      const t0 = Date.now() - 3_600_000;
      await db.message.createMany({
        data: Array.from({length: 55}, (_, i) => ({eventId: e.id, segment: 'all' as const, subject: `m${i}`, body: 'b', createdAt: new Date(t0 + i * 1000)})),
      });
      const first = await admin.get(base(e.id));
      const items = first.json.items as {subject: string}[];
      expect(items).toHaveLength(50);
      expect(items[0]!.subject).toBe('m54');
      expect(typeof first.json.nextBefore).toBe('string');
      const second = await admin.get(base(e.id) + `?before=${encodeURIComponent(first.json.nextBefore as string)}`);
      expect((second.json.items as {subject: string}[]).map(m => m.subject)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0']);
      expect(second.json.nextBefore).toBeNull();
      // A malformed cursor means the first page.
      const junk = await admin.get(base(e.id) + '?before=garbage');
      expect((junk.json.items as unknown[]).length).toBe(50);
    });
  });
});
