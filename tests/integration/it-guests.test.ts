import {createHash, randomBytes, randomUUID} from 'node:crypto';

import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {hashToken, newToken} from '../../src/domain/secureToken';
import {authRoutes} from '../../src/platform/auth';
import {csrf, previewCookies, sameOrigin} from '../../src/platform/guards';
import {syncPermissions} from '../../src/platform/permission-sync';
import {authSettings} from '../../src/server/auth-settings';
import {parseCsv} from '../../src/server/csv';
import {CATALOGUE} from '../../src/server/permissions';
import {adminEventRoutes} from '../../src/server/routes/admin-events';
import {adminGuestRoutes, EXPORT_MAX_ROWS, EXPORT_PAGE, guestExportPages} from '../../src/server/routes/admin-guests';
import {createEvent, resetEvents, setRoles} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

/**
 * Host guest admin against a real Postgres (audit M-22, M-24, M-26, M-27, M-21): bulk erase and
 * remove, the contacts consent rule in the list and the detail, the streamed CSV exports past one
 * page and at the cap, and host notices queued in the guest email outbox.
 */
const app = new Hono()
  .basePath('/site-api')
  .use(previewCookies)
  .use(sameOrigin)
  .use(csrf)
  .use(bodyLimit({maxSize: 64 * 1024}))
  .use(syncPermissions(CATALOGUE))
  .route('/auth', authRoutes(authSettings))
  .route('/admin-events', adminEventRoutes)
  .route('/event-admin', adminGuestRoutes);

const G = '/site-api/event-admin';
const T = (minute: number) => new Date(Date.UTC(2026, 9, 10, 9, minute));
/** The erasure log's address hash: sha256 hex of the lower-case address (schema `GuestErasure`). */
const sha = (email: string) => createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');

type Contact = {email: string; marketingConsent: boolean};

describe.skipIf(!DATABASE_URL)('host guest admin: erase, contacts consent, exports, notices (integration, real Postgres)', () => {
  let admin: Browser;
  let adminId: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    // Not covered by resetEvents: the platform's orders and the erasure log.
    await db.$executeRawUnsafe('TRUNCATE "orders", "guest_erasures" RESTART IDENTITY');
    admin = await signedIn(app, 'admin@example.test', undefined, '203.0.113.2');
    await setRoles('admin@example.test', 'admin');
    adminId = (await db.user.findFirstOrThrow({where: {email: 'admin@example.test'}, select: {id: true}})).id;
  });

  async function mkEvent(over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
    const ev = await createEvent(admin, over);
    if (Object.keys(settings).length) await db.event.update({where: {id: ev.id}, data: settings});
    return ev;
  }

  let seq = 0;
  async function seed(eventId: string, over: Record<string, unknown> = {}) {
    seq++;
    return db.rsvp.create({
      data: {
        eventId,
        name: `Guest ${seq}`,
        email: `guest${seq}@example.test`,
        response: 'going',
        status: 'confirmed',
        confirmedAt: new Date(),
        ticketCode: randomBytes(4).toString('hex').toUpperCase(),
        manageToken: hashToken(newToken()),
        ...over,
      } as never,
      select: {id: true, email: true, ticketCode: true},
    });
  }

  /** Confirmed guests `from`..`to` in ONE statement (so they share one created_at: keyset ties at every page edge). */
  async function bulkGuests(eventId: string, prefix: string, from: number, to: number, emailPrefix = prefix) {
    await db.$executeRaw`
      INSERT INTO rsvps (event_id, name, email, response, status, ticket_code, manage_token, confirmed_at)
      SELECT ${eventId}::uuid, 'Bulk ' || i, lower(${emailPrefix}) || lpad(i::text, 6, '0') || '@example.test', 'going', 'confirmed',
             ${prefix} || lpad(i::text, 6, '0'), 'mt-' || ${prefix} || '-' || i, now()
      FROM generate_series(${from}::int, ${to}::int) AS i`;
  }

  const bulk = (eventId: string, action: string, rsvpIds: string[]) => admin.post(`${G}/events/${eventId}/guests/bulk`, {action, rsvpIds});
  const csvOf = (res: {json: Record<string, unknown>}) => parseCsv(res.json.text as string);
  const audits = (action: string) => db.auditEvent.findMany({where: {action}, select: {actorUserId: true, meta: true}});

  async function paidOrder(rsvpId: string, email: string, checkoutId: string) {
    await db.ticketOrder.create({data: {rsvpId, checkoutId, amountCents: 2500, currency: 'USD', status: 'paid'}});
    await db.order.create({
      data: {checkoutId, priceKey: 'ticket', email, status: 'paid', amountCents: 2500, currency: 'USD', metadata: {rsvpId, kind: 'ticket'}},
    });
  }

  describe('bulk erase and remove', () => {
    it('erase scrubs the orders, logs hashed erasures, clears poll vote text; other guests and events untouched', async () => {
      const ev = await mkEvent();
      const other = await mkEvent({title: 'Other'});
      const a = await seed(ev.id, {email: 'ada@example.test'});
      const b = await seed(ev.id, {email: 'bob@example.test'});
      const keep = await seed(ev.id, {email: 'keep@example.test'});
      const elsewhere = await seed(other.id, {email: 'ada@example.test'});
      await paidOrder(a.id, a.email, 'cs_a');
      await paidOrder(b.id, b.email, 'cs_b');
      await paidOrder(elsewhere.id, elsewhere.email, 'cs_other');
      const poll = await db.poll.create({data: {eventId: ev.id, question: 'One word?', type: 'short_text'}, select: {id: true}});
      for (const [r, text] of [[a, 'ada secret'], [b, 'bob secret'], [keep, 'keep me']] as const) {
        await db.pollVote.create({data: {pollId: poll.id, voterToken: randomUUID(), rsvpId: r.id, textValue: text}});
      }

      const res = await bulk(ev.id, 'erase', [a.id, b.id, a.id]);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({action: 'erase', failed: [], emailsQueued: 0});
      expect([...(res.json.succeeded as string[])].sort()).toEqual([a.id, b.id].sort());

      // Orders: no address, no rsvpId, other metadata and the amounts kept.
      const orders = await db.order.findMany({orderBy: {checkoutId: 'asc'}, select: {checkoutId: true, email: true, metadata: true, amountCents: true}});
      expect(orders).toEqual([
        {checkoutId: 'cs_a', email: null, metadata: {kind: 'ticket'}, amountCents: 2500},
        {checkoutId: 'cs_b', email: null, metadata: {kind: 'ticket'}, amountCents: 2500},
        {checkoutId: 'cs_other', email: 'ada@example.test', metadata: {rsvpId: elsewhere.id, kind: 'ticket'}, amountCents: 2500},
      ]);
      expect(await db.ticketOrder.count({where: {rsvpId: {in: [a.id, b.id]}}})).toBe(2);

      // The erasure log: one hashed row per address for THIS event, never the address itself.
      const log = await db.guestErasure.findMany({select: {emailHash: true, eventId: true}});
      expect(log).toHaveLength(2);
      expect(new Set(log.map(l => l.emailHash))).toEqual(new Set([sha('ada@example.test'), sha('bob@example.test')]));
      expect(log.every(l => l.eventId === ev.id)).toBe(true);
      expect(JSON.stringify(log)).not.toContain('@');

      // Poll votes: the erased guests' text and link gone, the vote counts kept; another guest's untouched.
      const votes = await db.pollVote.findMany({where: {pollId: poll.id}, select: {rsvpId: true, textValue: true}});
      expect(votes).toHaveLength(3);
      expect(votes.filter(v => v.textValue === null && v.rsvpId === null)).toHaveLength(2);
      expect(votes).toContainEqual({rsvpId: keep.id, textValue: 'keep me'});

      // The same guest in another event is untouched, and erasing again logs nothing new.
      expect((await db.rsvp.findUniqueOrThrow({where: {id: elsewhere.id}})).email).toBe('ada@example.test');
      const again = await bulk(ev.id, 'erase', [a.id]);
      expect(again.json.failed).toEqual([]);
      expect(await db.guestErasure.count()).toBe(2);
      const audit = await audits('guests_erased');
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({actorUserId: adminId, meta: {done: 2, failed: 0}});
    });

    it('bulk remove deletes the free guests and refuses those with an order; the order and its guest stay', async () => {
      const ev = await mkEvent();
      const paid = await seed(ev.id, {email: 'paid@example.test'});
      const free = await seed(ev.id, {email: 'free@example.test'});
      const refunded = await seed(ev.id, {email: 'refunded@example.test'});
      await paidOrder(paid.id, paid.email, 'cs_paid');
      await db.ticketOrder.create({data: {rsvpId: refunded.id, checkoutId: 'cs_ref', amountCents: 900, currency: 'USD', status: 'refunded'}});
      const poll = await db.poll.create({data: {eventId: ev.id, question: 'Word?', type: 'short_text'}, select: {id: true}});
      await db.pollVote.create({data: {pollId: poll.id, voterToken: randomUUID(), rsvpId: paid.id, textValue: 'paid text'}});

      const res = await bulk(ev.id, 'remove', [paid.id, free.id, refunded.id]);
      expect(res.status).toBe(200);
      expect(res.json.succeeded).toEqual([free.id]);
      expect(res.json.failed).toEqual([
        {rsvpId: paid.id, reason: 'has_order: use erase'},
        {rsvpId: refunded.id, reason: 'has_order: use erase'},
      ]);
      expect(await db.rsvp.findUnique({where: {id: free.id}})).toBeNull();
      expect((await db.rsvp.findUniqueOrThrow({where: {id: paid.id}})).email).toBe('paid@example.test');
      expect(await db.ticketOrder.count()).toBe(2);
      expect((await db.order.findUniqueOrThrow({where: {checkoutId: 'cs_paid'}})).email).toBe('paid@example.test');
      // A refused guest's poll vote is not touched; a remove writes no erasure log.
      expect(await db.pollVote.findFirstOrThrow({select: {rsvpId: true, textValue: true}})).toEqual({rsvpId: paid.id, textValue: 'paid text'});
      expect(await db.guestErasure.count()).toBe(0);
      expect((await audits('guests_removed'))[0]).toMatchObject({actorUserId: adminId, meta: {done: 1, failed: 2}});
    });
  });

  describe('contacts consent: list and detail agree', () => {
    const listed = async (email: string) => {
      const items = (await admin.get(`${G}/contacts?q=${encodeURIComponent(email)}`)).json.items as Contact[];
      return items.find(i => i.email === email);
    };
    const detail = async (email: string) => (await admin.get(`${G}/contacts/detail?email=${encodeURIComponent(email)}`)).json.contact as Contact;

    it('opted in and confirmed on the latest RSVP, and nobody with that address unsubscribed', async () => {
      const e1 = await mkEvent({title: 'One'});
      const e2 = await mkEvent({title: 'Two'});
      const gone = await mkEvent({title: 'Gone'});
      const yes = {marketingConsent: true, consentConfirmedAt: T(0)};
      const cases: [string, Record<string, unknown>[], boolean][] = [
        // [address, RSVPs oldest first (e1, e2), expected consent]
        ['yes@example.test', [{}, yes], true],
        ['unconfirmed@example.test', [yes, {marketingConsent: true}], false],
        ['stale@example.test', [yes, {}], false],
        ['unsub-old@example.test', [{...yes, unsubscribedAt: T(5)}, yes], false],
        ['unsub-latest@example.test', [{}, {...yes, unsubscribedAt: T(5)}], false],
        ['never@example.test', [{}, {}], false],
      ];
      for (const [email, rsvps] of cases) {
        await seed(e1.id, {email, createdAt: T(1), ...rsvps[0]});
        await seed(e2.id, {email, createdAt: T(2), ...rsvps[1]});
      }
      // A newer RSVP on a deleted event counts in neither view.
      await seed(e1.id, {email: 'deleted-latest@example.test', createdAt: T(1), ...yes});
      await seed(gone.id, {email: 'deleted-latest@example.test', createdAt: T(3), unsubscribedAt: T(4)});
      await db.event.update({where: {id: gone.id}, data: {deletedAt: new Date()}});
      cases.push(['deleted-latest@example.test', [], true]);

      for (const [email, , expected] of cases) {
        const inList = await listed(email);
        const inDetail = await detail(email);
        expect({email, list: inList?.marketingConsent, detail: inDetail?.marketingConsent}).toEqual({email, list: expected, detail: expected});
      }
      const consenting = ((await admin.get(`${G}/contacts?consent=yes&limit=100`)).json.items as Contact[]).map(c => c.email);
      expect(consenting).toEqual(cases.filter(c => c[2]).map(c => c[0]).sort());
      // The export says the same.
      const rows = csvOf(await admin.get(`${G}/contacts/export.csv`)).slice(1);
      for (const [email, , expected] of cases) expect(rows.find(r => r[1] === email)?.[7]).toBe(expected ? 'Yes' : 'No');
    });

    it('an unsubscribe on an RSVP older than the newest 200 still means no consent in the detail', async () => {
      const email = 'regular@example.test';
      await db.$executeRaw`
        INSERT INTO events (slug, title, start_at, end_at, timezone, format, status, poll_join_code)
        SELECT 'many-' || i, 'Many ' || i, now() + (i || ' days')::interval, now() + (i || ' days')::interval + interval '1 hour',
               'UTC', 'online', 'published', 'M' || lpad(i::text, 5, '0')
        FROM generate_series(1, 201) AS i`;
      await db.$executeRaw`
        INSERT INTO rsvps (event_id, name, email, response, status, ticket_code, manage_token, marketing_consent, consent_confirmed_at, unsubscribed_at, created_at)
        SELECT e.id, 'Regular', ${email}, 'going', 'confirmed', 'R' || lpad(n::text, 7, '0'), 'mt-reg-' || n, true, now(),
               CASE WHEN n = 1 THEN now() ELSE NULL END, now() - ((202 - n) || ' minutes')::interval
        FROM (SELECT id, row_number() OVER (ORDER BY slug) AS n FROM events WHERE slug LIKE 'many-%') AS e`;
      expect((await listed(email))?.marketingConsent).toBe(false);
      expect((await detail(email)).marketingConsent).toBe(false);
    });

    // 12 addresses with random ids: the chance all 12 agree by luck is about 1 in 4,096.
    it('two RSVPs made at the same instant: the list and the detail still agree', async () => {
      const e1 = await mkEvent({title: 'One'});
      const e2 = await mkEvent({title: 'Two'});
      const mismatches: string[] = [];
      for (const [i, email] of Array.from({length: 12}, (_, k) => `tie-${k}@example.test`).entries()) {
        // Alternate which event's RSVP holds the consent, so both id orders are covered.
        await seed(e1.id, {email, createdAt: T(9), ...(i % 2 ? {marketingConsent: true, consentConfirmedAt: T(9)} : {})});
        await seed(e2.id, {email, createdAt: T(9), ...(i % 2 ? {} : {marketingConsent: true, consentConfirmedAt: T(9)})});
        if ((await listed(email))?.marketingConsent !== (await detail(email)).marketingConsent) mismatches.push(email);
      }
      expect(mismatches).toEqual([]);
    });
  });

  describe('streamed CSV exports', () => {
    it(`guest export past one page (${EXPORT_PAGE}): every guest once, filters kept, not truncated, audited`, async () => {
      const ev = await mkEvent();
      const other = await mkEvent({title: 'Other'});
      const n = 2 * EXPORT_PAGE + 345;
      await bulkGuests(ev.id, 'GA', 1, n);
      await bulkGuests(other.id, 'GB', 1, 10);
      await seed(ev.id, {email: 'pending@example.test', status: 'pending', confirmedAt: null});

      const res = await admin.get(`${G}/events/${ev.id}/guests/export.csv?status=confirmed`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-export-truncated')).toBe('0');
      const [header, ...rows] = csvOf(res);
      expect(header![1]).toBe('Email');
      expect(rows).toHaveLength(n);
      const emails = new Set(rows.map(r => r[1]));
      expect(emails.size).toBe(n);
      expect([...emails].every(e => e!.startsWith('ga'))).toBe(true);
      expect((await audits('guests_exported'))[0]).toEqual({actorUserId: adminId, meta: {rows: n, truncated: false}});
    });

    it('guest export pages by value: removing the guest that ended a page mid-export still exports every remaining guest', async () => {
      const ev = await mkEvent();
      const n = 2 * EXPORT_PAGE + 345;
      await bulkGuests(ev.id, 'GD', 1, n);
      const seen: string[] = [];
      const removed: string[] = [];
      for await (const rows of guestExportPages(db, {eventId: ev.id})) {
        seen.push(...rows.map(r => r.email));
        // Between pages: remove the boundary guest (the cursor's own row), as a host acting meanwhile would.
        const last = rows.at(-1)!;
        if (rows.length === EXPORT_PAGE) {
          await db.rsvp.delete({where: {id: last.id}});
          removed.push(last.email);
        }
      }
      expect(removed).toHaveLength(2);
      expect(seen).toHaveLength(n);
      expect(new Set(seen).size).toBe(n);
      // Every guest still there was exported.
      const remaining = await db.rsvp.findMany({where: {eventId: ev.id}, select: {email: true}});
      expect(remaining).toHaveLength(n - 2);
      const seenSet = new Set(seen);
      expect(remaining.every(r => seenSet.has(r.email))).toBe(true);
    });

    it(`contacts export past one page: every address once (paging by email), consent filter kept, audited`, async () => {
      const e1 = await mkEvent({title: 'One'});
      const e2 = await mkEvent({title: 'Two'});
      const n = 2 * EXPORT_PAGE + 123;
      await bulkGuests(e1.id, 'CA', 1, n);
      // The first 600 addresses also came to the second event: still one row each.
      await bulkGuests(e2.id, 'CB', 1, 600, 'CA');
      const res = await admin.get(`${G}/contacts/export.csv`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-export-truncated')).toBe('0');
      const rows = csvOf(res).slice(1);
      expect(rows).toHaveLength(n);
      expect(new Set(rows.map(r => r[1])).size).toBe(n);
      expect(rows.map(r => r[1])).toEqual(rows.map(r => r[1]).sort());
      expect(rows.filter(r => r[2] === '2')).toHaveLength(600);
      expect((await audits('contacts_exported'))[0]).toEqual({actorUserId: adminId, meta: {rows: n, truncated: false}});
      // Nobody opted in: the consent-only export is the header alone.
      expect(csvOf(await admin.get(`${G}/contacts/export.csv?consent=yes`))).toHaveLength(1);
    });

    it(`both exports stop at the cap (${EXPORT_MAX_ROWS}) and say so only past it`, {timeout: 180_000}, async () => {
      const ev = await mkEvent();
      await bulkGuests(ev.id, 'CP', 1, EXPORT_MAX_ROWS);

      const guestsAt = await admin.get(`${G}/events/${ev.id}/guests/export.csv`);
      expect(guestsAt.headers.get('x-export-truncated')).toBe('0');
      expect(csvOf(guestsAt)).toHaveLength(EXPORT_MAX_ROWS + 1);
      const contactsAt = await admin.get(`${G}/contacts/export.csv`);
      expect(contactsAt.headers.get('x-export-truncated')).toBe('0');
      expect(csvOf(contactsAt)).toHaveLength(EXPORT_MAX_ROWS + 1);

      await bulkGuests(ev.id, 'CP', EXPORT_MAX_ROWS + 1, EXPORT_MAX_ROWS + 1);
      const guestsOver = await admin.get(`${G}/events/${ev.id}/guests/export.csv`);
      expect(guestsOver.headers.get('x-export-truncated')).toBe('1');
      const guestRows = csvOf(guestsOver).slice(1);
      expect(guestRows).toHaveLength(EXPORT_MAX_ROWS);
      expect(new Set(guestRows.map(r => r[1])).size).toBe(EXPORT_MAX_ROWS);
      const contactsOver = await admin.get(`${G}/contacts/export.csv`);
      expect(contactsOver.headers.get('x-export-truncated')).toBe('1');
      const contactRows = csvOf(contactsOver).slice(1);
      expect(contactRows).toHaveLength(EXPORT_MAX_ROWS);
      expect(new Set(contactRows.map(r => r[1])).size).toBe(EXPORT_MAX_ROWS);
      // Address order: the one left out is the last address.
      expect(contactRows.some(r => r[1] === `cp${String(EXPORT_MAX_ROWS + 1).padStart(6, '0')}@example.test`)).toBe(false);

      expect((await audits('guests_exported')).map(a => a.meta)).toEqual([
        {rows: EXPORT_MAX_ROWS, truncated: false},
        {rows: EXPORT_MAX_ROWS, truncated: true},
      ]);
      expect((await audits('contacts_exported')).map(a => a.meta)).toEqual([
        {rows: EXPORT_MAX_ROWS, truncated: false},
        {rows: EXPORT_MAX_ROWS, truncated: true},
      ]);
    });
  });

  describe('host notices go to the guest email outbox', () => {
    const outbox = () => db.guestEmailOutbox.findMany({select: {kind: true, rsvpId: true}, orderBy: {createdAt: 'asc'}});

    it('bulk approve and decline queue one row per guest, emailsQueued says how many; a repeat queues nothing', async () => {
      const ev = await mkEvent({}, {approvalRequired: true, capacity: 3});
      await seed(ev.id); // one seat taken
      const approve = [];
      for (let i = 0; i < 3; i++) approve.push(await seed(ev.id, {status: 'pending', confirmedAt: null}));
      // An unsubscribe covers broadcasts, not news about the guest's own RSVP.
      await db.rsvp.update({where: {id: approve[0]!.id}, data: {unsubscribedAt: new Date()}});
      const decline = [];
      for (let i = 0; i < 2; i++) decline.push(await seed(ev.id, {status: 'pending', confirmedAt: null}));

      const ok = await bulk(ev.id, 'approve', approve.map(r => r.id));
      expect(ok.status).toBe(200);
      expect(ok.json.succeeded).toEqual(approve.map(r => r.id));
      expect(ok.json.emailsQueued).toBe(3);
      // Two seats were left: the third approval is waitlisted, and told so.
      expect((await db.rsvp.findUniqueOrThrow({where: {id: approve[2]!.id}})).status).toBe('waitlisted');
      let rows = await outbox();
      expect(rows).toHaveLength(3);
      expect(rows.every(r => r.kind === 'notice_confirmation')).toBe(true);
      expect(new Set(rows.map(r => r.rsvpId))).toEqual(new Set(approve.map(r => r.id)));

      const no = await bulk(ev.id, 'decline', decline.map(r => r.id));
      expect(no.json).toMatchObject({succeeded: decline.map(r => r.id), failed: [], emailsQueued: 2});
      rows = await outbox();
      expect(rows.filter(r => r.kind === 'notice_declined').map(r => r.rsvpId).sort()).toEqual(decline.map(r => r.id).sort());

      const repeat = await bulk(ev.id, 'approve', approve.map(r => r.id));
      expect(repeat.json.emailsQueued).toBe(0);
      expect(await db.guestEmailOutbox.count()).toBe(5);
    });

    it('a cancelled event queues no notice for a decline', async () => {
      const ev = await mkEvent({}, {approvalRequired: true});
      const p = await seed(ev.id, {status: 'pending', confirmedAt: null});
      await db.event.update({where: {id: ev.id}, data: {status: 'cancelled'}});
      const res = await bulk(ev.id, 'decline', [p.id]);
      expect(res.json).toMatchObject({succeeded: [p.id], emailsQueued: 0});
      expect(await db.guestEmailOutbox.count()).toBe(0);
    });

    it('a remove that frees a seat queues the promoted guest’s notice', async () => {
      const ev = await mkEvent({}, {capacity: 1});
      const seated = await seed(ev.id);
      const waiting = await seed(ev.id, {status: 'waitlisted', waitlistPosition: 1, confirmedAt: null});
      const res = await bulk(ev.id, 'remove', [seated.id]);
      expect(res.json).toMatchObject({succeeded: [seated.id], emailsQueued: 1});
      expect(await outbox()).toEqual([{kind: 'notice_confirmation', rsvpId: waiting.id}]);
    });
  });
});
