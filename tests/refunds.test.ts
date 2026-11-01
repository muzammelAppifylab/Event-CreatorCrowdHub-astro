import {describe, expect, it, vi} from 'vitest';

import {FakeDb} from './ticket-fake-db';

vi.mock('../src/server/jobs/guest-emails', () => ({
  GUEST_EMAIL_LIST: 'rsvp-emails',
  queueGuestEmail: vi.fn(),
  sendGuestEmail: vi.fn(),
}));

import {countRefundDue, listRefundDue, markRefunded, REFUNDS_PAGE_SIZE} from '../src/server/routes/admin-refunds';

/** The fake db has no OR/AND, array orderBy or nested event: teach just those to its order table. */
function setup() {
  const db = new FakeDb();
  const table = db.ticketOrder as any;
  const matches = table.matches;
  const match = (row: any, where: any = {}): boolean => {
    const {AND, OR, ...rest} = where;
    return matches(row, rest) && (!AND || AND.every((w: any) => match(row, w))) && (!OR || OR.some((w: any) => match(row, w)));
  };
  table.matches = match;
  const shape = table.shape.bind(table);
  table.shape = (row: any) => {
    const s = shape(row);
    return {...s, rsvp: s.rsvp ? {...s.rsvp, event: db.event.rows.find(e => e.id === s.rsvp.eventId)} : null};
  };
  table.findMany = async ({where, take}: any) => {
    const rows = table.rows
      .filter((r: any) => match(r, where))
      .sort((a: any, b: any) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    return (take ? rows.slice(0, take) : rows).map((r: any) => table.shape(r));
  };
  const event = db.addEvent({title: 'Summer Jam'});
  return {db, event};
}
const add = (db: FakeDb, eventId: string, over: Record<string, unknown> = {}, rsvp: Record<string, unknown> = {}) => {
  const r = db.addRsvp(eventId, {status: 'confirmed', ...rsvp});
  return {rsvp: r, order: db.addOrder(r.id, {status: 'refund_due', ...over})};
};
const asDb = (db: FakeDb) => db as never;

describe('refunds to finish', () => {
  it('lists only refund_due orders, with guest name, event title and amount, and no email', async () => {
    const {db, event} = setup();
    add(db, event.id, {amountCents: 4200}, {name: 'Grace Hopper'});
    add(db, event.id, {status: 'paid'});
    add(db, event.id, {status: 'refunded'});
    const page = await listRefundDue(asDb(db));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({guestName: 'Grace Hopper', eventTitle: 'Summer Jam', amountCents: 4200, currency: 'USD'});
    expect(JSON.stringify(page)).not.toContain('@');
    expect(page.nextBefore).toBeNull();
    expect(await countRefundDue(asDb(db))).toBe(1);
  });

  it('filters by event', async () => {
    const {db, event} = setup();
    const other = db.addEvent({title: 'Other'});
    add(db, event.id);
    add(db, other.id);
    expect((await listRefundDue(asDb(db), {eventId: other.id})).items.map(i => i.eventTitle)).toEqual(['Other']);
    expect(await countRefundDue(asDb(db), event.id)).toBe(1);
  });

  it('pages by keyset without gaps or repeats', async () => {
    const {db, event} = setup();
    const total = REFUNDS_PAGE_SIZE + 5;
    for (let i = 0; i < total; i++) add(db, event.id, {createdAt: new Date(Date.UTC(2026, 0, 1) + (i % 10) * 1000)});
    const first = await listRefundDue(asDb(db));
    expect(first.items).toHaveLength(REFUNDS_PAGE_SIZE);
    expect(first.nextBefore).toBeTruthy();
    const second = await listRefundDue(asDb(db), {before: first.nextBefore});
    expect(second.items).toHaveLength(5);
    expect(second.nextBefore).toBeNull();
    const ids = [...first.items, ...second.items].map(i => i.id);
    expect(new Set(ids).size).toBe(total);
    expect((await listRefundDue(asDb(db), {before: 'garbage'})).items).toHaveLength(REFUNDS_PAGE_SIZE);
  });

  it('marks an order refunded once, frees the seat, and is idempotent', async () => {
    const {db, event} = setup();
    const {order, rsvp} = add(db, event.id);
    expect(await markRefunded(asDb(db), order.id)).toBe('done');
    expect(db.ticketOrder.rows[0].status).toBe('refunded');
    expect(db.rsvp.rows.find(r => r.id === rsvp.id)?.status).toBe('cancelled');
    expect(await markRefunded(asDb(db), order.id)).toBe('already');
    expect(await countRefundDue(asDb(db))).toBe(0);
  });

  it('refuses unknown ids and orders not waiting for a refund', async () => {
    const {db, event} = setup();
    const {order} = add(db, event.id, {status: 'paid'});
    expect(await markRefunded(asDb(db), 'nope')).toBe('not_found');
    expect(await markRefunded(asDb(db), '00000000-0000-4000-8000-ffffffffffff')).toBe('not_found');
    expect(await markRefunded(asDb(db), order.id)).toBe('not_due');
    expect(db.ticketOrder.rows[0].status).toBe('paid');
  });
});
