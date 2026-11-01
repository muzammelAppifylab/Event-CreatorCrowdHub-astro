import {beforeEach, describe, expect, it, vi} from 'vitest';

import {DontRetry, JobRejected} from '../src/platform/background';
import {deliverWebhookJob} from '../src/server/webhook-delivery';
import {MAX_JOB_BYTES, OUTBOX_MAX_ATTEMPTS, outboxBackoffMs, packItems, parkRows, rowsOf, type WebhookItem} from '../src/server/webhook-outbox';
import {dispatchWebhooks, drainWebhookOutbox} from '../src/server/webhooks';

type Row = {id: string; endpointId: string; event: string; deliveryId: string; body: string; attempts: number; nextAttemptAt: Date; createdAt: Date};

const NOW = new Date('2026-11-01T12:00:00Z');

/** Just enough of the outbox + endpoint tables. */
function fakeDb(endpoints: {id: string; events?: unknown; url?: string; secret?: string; active?: boolean}[] = []) {
  const rows: Row[] = [];
  let n = 0;
  const outbox = {
    createMany: async ({data, skipDuplicates}: {data: Omit<Row, 'id' | 'createdAt'>[]; skipDuplicates?: boolean}) => {
      for (const d of data) {
        if (rows.some(r => r.endpointId === d.endpointId && r.deliveryId === d.deliveryId)) {
          if (skipDuplicates) continue;
          throw new Error('unique');
        }
        rows.push({...d, id: `row${String(++n).padStart(4, '0')}`, createdAt: new Date(NOW)});
      }
      return {count: data.length};
    },
    findMany: async ({where, take}: {where: {nextAttemptAt: {lte: Date}}; take: number}) =>
      rows
        .filter(r => r.nextAttemptAt <= where.nextAttemptAt.lte)
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.id.localeCompare(b.id))
        .slice(0, take),
    updateMany: async ({where, data}: {where: {id: {in: string[]}}; data: Partial<Row>}) => {
      for (const r of rows) if (where.id.in.includes(r.id)) Object.assign(r, data);
      return {count: 0};
    },
    deleteMany: async ({where}: {where: {endpointId?: string; deliveryId?: string; OR?: unknown[]}}) => {
      const before = rows.length;
      const keep = rows.filter(r => {
        if (where.OR) return !(r.createdAt.getTime() < NOW.getTime() - 24 * 3600_000 || r.attempts >= OUTBOX_MAX_ATTEMPTS);
        return !(r.endpointId === where.endpointId && r.deliveryId === where.deliveryId);
      });
      rows.splice(0, rows.length, ...keep);
      return {count: before - rows.length};
    },
  };
  const webhookEndpoint = {
    findMany: async (args?: {where?: {id?: {in: string[]}; active?: boolean}}) => {
      const ids = args?.where?.id?.in;
      return endpoints
        .filter(e => (!ids || ids.includes(e.id)) && (args?.where?.active === undefined || (e.active ?? true) === args.where.active))
        .map(e => ({url: 'https://hooks.example.org/x', secret: 's', active: true, events: [], ...e}));
    },
  };
  return {db: {webhookOutbox: outbox, webhookEndpoint} as never, rows};
}

const item = (id: string, endpointIds = ['a'], extra: Partial<WebhookItem> = {}): WebhookItem => ({
  id,
  event: 'rsvp.updated',
  body: JSON.stringify({id}),
  endpointIds,
  ...extra,
});
const limited = () => new JobRejected('Too many jobs', 'E_JOBS_RATE_LIMITED', 429);
const past = new Date(NOW.getTime() - 3600_000);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('backoff and packing', () => {
  it('doubles from a minute and is capped at 4 hours', () => {
    expect([0, 1, 2, 3].map(outboxBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(outboxBackoffMs(30)).toBe(4 * 3600_000);
  });

  it('packs many events into few jobs, each inside the payload limit', () => {
    const items = Array.from({length: 300}, (_, i) => item(`d${i}`, ['a', 'b'], {body: JSON.stringify({pad: 'x'.repeat(200), i})}));
    const jobs = packItems(items);
    expect(jobs.length).toBeGreaterThan(1);
    expect(jobs.flat()).toHaveLength(300);
    for (const j of jobs) expect(new TextEncoder().encode(JSON.stringify({items: j})).length).toBeLessThanOrEqual(MAX_JOB_BYTES);
    expect(packItems([])).toEqual([]);
  });
});

describe('dispatchWebhooks (coalescing, outbox on failure)', () => {
  const endpoints = [
    {id: 'a', events: ['rsvp.updated']},
    {id: 'b', events: ['rsvp.updated', 'poll.closed']},
  ];

  it('sends ONE job for a whole bulk emit, each event listing its own endpoints', async () => {
    const {db} = fakeDb(endpoints);
    const send = vi.fn(async () => ({id: 'j'}) as never);
    const n = await dispatchWebhooks(db, [{event: 'rsvp.updated', payload: {i: 1}}, {event: 'poll.closed', payload: {i: 2}}, {event: 'order.paid', payload: {}}], {send});
    expect(n).toBe(2); // order.paid has no receiver
    expect(send).toHaveBeenCalledTimes(1);
    const data = (send.mock.calls[0] as unknown as [string, string, {items: WebhookItem[]}])[2];
    expect(data.items.map(i => [i.event, i.endpointIds])).toEqual([
      ['rsvp.updated', ['a', 'b']],
      ['poll.closed', ['b']],
    ]);
  });

  it('parks every delivery in the outbox when the platform refuses the job (rate limit)', async () => {
    const {db, rows} = fakeDb(endpoints);
    const send = vi.fn(async () => Promise.reject(limited()));
    await dispatchWebhooks(db, [{event: 'rsvp.updated', payload: {i: 1}}], {send});
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2); // one per endpoint
    expect(new Set(rows.map(r => r.deliveryId)).size).toBe(1);
    expect(rows.every(r => r.attempts === 0)).toBe(true);
  });

  it('never throws even when the outbox write fails too', async () => {
    const {db} = fakeDb(endpoints);
    (db as never as {webhookOutbox: {createMany: unknown}}).webhookOutbox.createMany = async () => Promise.reject(new Error('db down'));
    await expect(dispatchWebhooks(db, [{event: 'rsvp.updated', payload: {}}], {send: async () => Promise.reject(limited())})).resolves.toBe(1);
  });

  it('a later chunk still goes out when an earlier one was refused', async () => {
    const {db, rows} = fakeDb(endpoints);
    const big = (i: number) => ({event: 'rsvp.updated' as const, payload: {i, pad: 'x'.repeat(9_000)}});
    let calls = 0;
    const send = vi.fn(async () => (++calls === 1 ? Promise.reject(limited()) : ({id: 'j'}) as never));
    await dispatchWebhooks(db, [big(1), big(2), big(3), big(4)], {send});
    expect(send.mock.calls.length).toBeGreaterThan(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(8); // only the refused chunk is parked
  });
});

describe('drainWebhookOutbox', () => {
  it('sends due rows as batched jobs (rows of one delivery share an item), oldest first', async () => {
    const {db, rows} = fakeDb();
    await parkRows(db as never, rowsOf([item('d1', ['a', 'b']), item('d2', ['a'])]), 0, past);
    const send = vi.fn(async () => ({id: 'j'}) as never);
    const run = await drainWebhookOutbox(db as never, NOW, {send});
    expect(run).toMatchObject({sent: 1, dropped: 0});
    const data = (send.mock.calls[0] as unknown as [string, string, {items: WebhookItem[]}])[2];
    expect(data.items.map(i => [i.id, i.endpointIds, i.attempt])).toEqual([
      ['d1', ['a', 'b'], 1],
      ['d2', ['a'], 1],
    ]);
    // leased: the try is counted and the next one pushed out, so a second tick does not resend
    expect(rows.every(r => r.attempts === 1 && r.nextAttemptAt > NOW)).toBe(true);
    expect((await drainWebhookOutbox(db as never, NOW, {send})).sent).toBe(0);
  });

  it('sends at most maxJobs jobs per tick and leaves the rest', async () => {
    const {db} = fakeDb();
    const many = Array.from({length: 40}, (_, i) => item(`d${i}`, ['a'], {body: JSON.stringify({pad: 'x'.repeat(5_000), i})}));
    await parkRows(db as never, rowsOf(many), 0, past);
    const send = vi.fn(async () => ({id: 'j'}) as never);
    const run = await drainWebhookOutbox(db as never, NOW, {send, maxJobs: 2});
    expect(send).toHaveBeenCalledTimes(2);
    expect(run.waiting).toBe(true);
  });

  it("a rate-limited send stops the sweep and does not use up the rows' tries", async () => {
    const {db, rows} = fakeDb();
    await parkRows(db as never, rowsOf([item('d1')]), 0, past);
    const run = await drainWebhookOutbox(db as never, NOW, {send: async () => Promise.reject(limited())});
    expect(run).toMatchObject({sent: 0, waiting: true});
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].nextAttemptAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it('any other send failure counts as a try with an exponential backoff', async () => {
    const {db, rows} = fakeDb();
    await parkRows(db as never, rowsOf([item('d1')]), 2, past);
    await drainWebhookOutbox(db as never, NOW, {send: async () => Promise.reject(new Error('boom'))});
    expect(rows[0].attempts).toBe(3);
    expect(rows[0].nextAttemptAt.getTime()).toBe(NOW.getTime() + outboxBackoffMs(3));
  });

  it('keeps the delivery id and body across retries, with a stable job key per try', async () => {
    const {db, rows} = fakeDb();
    const original = item('d1');
    await parkRows(db as never, rowsOf([original]), 0, past);
    const send = vi.fn(async () => ({id: 'j'}) as never);
    await drainWebhookOutbox(db as never, NOW, {send});
    const [, , data, opts] = send.mock.calls[0] as unknown as [string, string, {items: WebhookItem[]}, {key: string}];
    expect(data.items[0]).toMatchObject({id: 'd1', body: original.body});
    expect(opts.key).toBe('wr-d1-1');
    expect(rows[0].deliveryId).toBe('d1');
  });

  it('prunes rows older than 24 h or past 8 tries, and does nothing without the table', async () => {
    const {db, rows} = fakeDb();
    await parkRows(db as never, rowsOf([item('old'), item('spent')]), 0, past);
    rows[0].createdAt = new Date(NOW.getTime() - 25 * 3600_000);
    rows[1].attempts = OUTBOX_MAX_ATTEMPTS;
    const send = vi.fn(async () => ({id: 'j'}) as never);
    const run = await drainWebhookOutbox(db as never, NOW, {send});
    expect(run.dropped).toBe(2);
    expect(rows).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(await drainWebhookOutbox({} as never, NOW, {send})).toEqual({sent: 0, dropped: 0, waiting: false});
  });

  it('parkRows refuses rows past the attempt cap', async () => {
    const {db, rows} = fakeDb();
    expect(await parkRows(db as never, rowsOf([item('x')]), OUTBOX_MAX_ATTEMPTS)).toBe(1);
    expect(rows).toHaveLength(0);
  });
});

describe('deliverWebhookJob (batch)', () => {
  const ok = async () => new Response(null, {status: 200});
  const status = (code: number) => async () => new Response(null, {status: code});

  it('fans an event out to every endpoint; one dead receiver parks only itself (no duplicates to healthy ones)', async () => {
    const {db, rows} = fakeDb([{id: 'a', url: 'https://a.example.org/x'}, {id: 'b', url: 'https://b.example.org/x'}]);
    const seen: string[] = [];
    const fetch = async (url: string) => (seen.push(url), url.includes('b.') ? new Response(null, {status: 503}) : new Response(null, {status: 200}));
    await deliverWebhookJob({items: [item('d1', ['a', 'b'])]}, undefined, {db: db as never, fetch});
    expect(seen.sort()).toEqual(['https://a.example.org/x', 'https://b.example.org/x']);
    expect(rows.map(r => [r.endpointId, r.deliveryId, r.attempts])).toEqual([['b', 'd1', 1]]);
  });

  it('delivers many events in one run and removes outbox rows once delivered', async () => {
    const {db, rows} = fakeDb([{id: 'a'}]);
    await parkRows(db as never, rowsOf([item('d1'), item('d2')]), 1);
    await deliverWebhookJob({items: [item('d1', ['a'], {attempt: 2}), item('d2', ['a'], {attempt: 2}), item('d3')]}, undefined, {db: db as never, fetch: ok});
    expect(rows).toHaveLength(0);
  });

  it('a failing retry keeps its leased row; a delivery past the try cap is dropped', async () => {
    const {db, rows} = fakeDb([{id: 'a'}]);
    await parkRows(db as never, rowsOf([item('d1')]), 3);
    await deliverWebhookJob({items: [item('d1', ['a'], {attempt: 4})]}, undefined, {db: db as never, fetch: status(500)});
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(3); // the drain already counted this try when it leased the row
    const fresh = fakeDb([{id: 'a'}]);
    await deliverWebhookJob({items: [item('d9', ['a'], {attempt: OUTBOX_MAX_ATTEMPTS})]}, undefined, {db: fresh.db as never, fetch: status(500)});
    expect(fresh.rows).toHaveLength(0);
  });

  it('a refused (4xx) delivery is final: not parked, reported once the others are done', async () => {
    const {db, rows} = fakeDb([{id: 'a', url: 'https://a.example.org/x'}, {id: 'b', url: 'https://b.example.org/x'}]);
    const fetch = vi.fn(async (url: string) => new Response(null, {status: url.includes('a.') ? 410 : 200}));
    await expect(deliverWebhookJob({items: [item('d1', ['a', 'b'])]}, undefined, {db: db as never, fetch})).rejects.toBeInstanceOf(DontRetry);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(0);
  });

  it('skips deleted or paused endpoints, never fetching them', async () => {
    const {db, rows} = fakeDb([{id: 'a', active: false}]);
    const fetch = vi.fn(ok);
    await deliverWebhookJob({items: [item('d1', ['a', 'gone'])]}, undefined, {db: db as never, fetch});
    expect(fetch).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it('out of time: untried deliveries go back to the outbox without using a try', async () => {
    const {db, rows} = fakeDb([{id: 'a'}]);
    const fetch = vi.fn(ok);
    await deliverWebhookJob({items: [item('d1')]}, undefined, {db: db as never, fetch, budgetMs: -1});
    expect(fetch).not.toHaveBeenCalled();
    expect(rows.map(r => [r.deliveryId, r.attempts])).toEqual([['d1', 0]]);
  });

  it('refuses a malformed batch without retrying', async () => {
    const {db} = fakeDb();
    await expect(deliverWebhookJob({items: [{id: 1}]} as never, undefined, {db: db as never})).rejects.toBeInstanceOf(DontRetry);
    await expect(deliverWebhookJob({items: []}, undefined, {db: db as never})).rejects.toBeInstanceOf(DontRetry);
  });
});
