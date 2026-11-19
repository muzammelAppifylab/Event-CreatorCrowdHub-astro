/**
 * A small in-memory stand-in for the Prisma client, just enough for the ticket and scheduler
 * code (`where` with equality, in, not, gt/gte/lt/lte; relations wired by hand). Real-database
 * behaviour (unique indexes, row locks) is mimicked only where the code depends on it: the
 * unique (rsvpId, reminderRuleId) on message_deliveries.
 */
type Row = Record<string, any>;

let seq = 0;
export const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function matchValue(actual: any, cond: any): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
    if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
    return actual === cond;
  }
  if ('in' in cond && !cond.in.includes(actual)) return false;
  if ('not' in cond && actual === cond.not) return false;
  if ('gt' in cond && !(actual !== null && actual !== undefined && actual > cond.gt)) return false;
  if ('gte' in cond && !(actual !== null && actual !== undefined && actual >= cond.gte)) return false;
  if ('lt' in cond && !(actual !== null && actual !== undefined && actual < cond.lt)) return false;
  if ('lte' in cond && !(actual !== null && actual !== undefined && actual <= cond.lte)) return false;
  return true;
}

export class Table {
  rows: Row[] = [];
  constructor(
    private readonly defaults: () => Row = () => ({}),
    private readonly relations: (db: FakeDb, row: Row, key: string, cond: any) => boolean | undefined = () => undefined,
    private readonly db?: () => FakeDb,
    private readonly unique: string[][] = [],
  ) {}

  matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      const rel = this.relations(this.db?.() as FakeDb, row, key, cond);
      if (rel !== undefined) return rel;
      return matchValue(row[key], cond);
    });

  async create({data}: {data: Row}) {
    for (const keys of this.unique) {
      if (keys.every(k => data[k] !== null && data[k] !== undefined) && this.rows.some(r => keys.every(k => r[k] === data[k]))) {
        throw Object.assign(new Error('Unique constraint failed'), {code: 'P2002'});
      }
    }
    const row = {id: uid(), createdAt: new Date(), updatedAt: new Date(), ...this.defaults(), ...data};
    this.rows.push(row);
    return row;
  }
  async findMany({where, take, orderBy, distinct}: {where?: Row; take?: number; orderBy?: any; distinct?: string[]} = {}) {
    let out = this.rows.filter(r => this.matches(r, where));
    if (orderBy && !Array.isArray(orderBy)) {
      const [[k, dir]] = Object.entries(orderBy) as [[string, string]];
      out = [...out].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    if (distinct) {
      const seen = new Set<string>();
      out = out.filter(r => {
        const key = distinct.map(k => r[k]).join('|');
        return seen.has(key) ? false : (seen.add(key), true);
      });
    }
    return (take ? out.slice(0, take) : out).map(r => ({...r}));
  }
  async findFirst(args: {where?: Row; orderBy?: any} = {}) {
    return (await this.findMany(args))[0] ?? null;
  }
  async findUnique({where}: {where: Row}) {
    const row = this.rows.find(r => Object.entries(where).every(([k, v]) => r[k] === v));
    return row ? this.shape(row) : null;
  }
  shape(row: Row): Row {
    return {...row};
  }
  async update({where, data}: {where: Row; data: Row}) {
    const row = this.rows.find(r => this.matches(r, where));
    if (!row) throw Object.assign(new Error('not found'), {code: 'P2025'});
    Object.assign(row, data, {updatedAt: new Date()});
    return {...row};
  }
  async updateMany({where, data}: {where?: Row; data: Row}) {
    const hit = this.rows.filter(r => this.matches(r, where));
    for (const row of hit) Object.assign(row, data, {updatedAt: new Date()});
    return {count: hit.length};
  }
  async count({where}: {where?: Row} = {}) {
    return this.rows.filter(r => this.matches(r, where)).length;
  }
  async aggregate({where}: {where?: Row; _sum?: Row}) {
    const hit = this.rows.filter(r => this.matches(r, where));
    return {_sum: {seats: hit.reduce((n, r) => n + (r.seats ?? 0), 0)}};
  }
}

class EventTable extends Table {}

export class FakeDb {
  event: EventTable;
  ticketType: Table;
  rsvp: Table;
  ticketOrder: Table;
  reminderRule: Table;
  messageDelivery: Table;
  eventSettings: Table;

  constructor() {
    const self = () => this;
    this.event = new EventTable(() => ({status: 'published', deletedAt: null, capacity: null, format: 'online', slug: `ev-${uid().slice(-6)}`, title: 'Launch party', timezone: 'UTC', pollJoinCode: 'ABC123', venueName: null, venueAddress: null, mapUrl: null, joinUrl: null, thankYouLink: null}), () => undefined, self);
    this.ticketType = new Table(() => ({priceCents: 2500, currency: 'USD', name: 'General'}));
    this.reminderRule = new Table(() => ({enabled: true, subject: 'See you soon', body: 'Hi {{guest.first_name}}'}));
    this.messageDelivery = new Table(() => ({status: 'queued', sentAt: null, error: null, reminderRuleId: null}), () => undefined, self, [['rsvpId', 'reminderRuleId']]);
    this.eventSettings = new Table(() => ({id: 1, senderName: 'Studio', replyToEmail: '', brandColor: null}));
    const db = self;
    this.rsvp = new (class extends Table {
      shape(row: Row) {
        const d = db();
        return {
          ...row,
          event: d.event.rows.find(e => e.id === row.eventId) ?? null,
          ticketType: d.ticketType.rows.find(t => t.id === row.ticketTypeId) ?? null,
        };
      }
    })(
      () => ({status: 'awaiting_payment', response: 'going', seats: 1, plusOnes: 0, waitlistPosition: null, claimExpiresAt: null, confirmedAt: null, ticketCode: 'TICKET01', ticketTypeId: null}),
      (d, row, key, cond) => {
        if (key === 'ticketOrders') {
          const orders = d.ticketOrder.rows.filter(o => o.rsvpId === row.id);
          if ('none' in cond) return !orders.some(o => d.ticketOrder.matches(o, cond.none));
        }
        return undefined;
      },
      self,
    );
    this.ticketOrder = new (class extends Table {
      shape(row: Row) {
        const r = db().rsvp.rows.find(x => x.id === row.rsvpId);
        return {...row, rsvp: r ? {...r} : null};
      }
    })(
      () => ({status: 'pending'}),
      (d, row, key, cond) => {
        if (key === 'rsvp') {
          const r = d.rsvp.rows.find(x => x.id === row.rsvpId);
          return !!r && d.rsvp.matches(r, cond);
        }
        return undefined;
      },
      self,
    );
    const baseEventFind = this.event.findUnique.bind(this.event);
    this.event.findUnique = async args => baseEventFind(args);
  }

  async $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async $queryRaw() {
    return [];
  }
  /** Understands only the waitlist renumber statement (`renumberWaitlist` in src/server/waitlist-promote.ts). */
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('?');
    if (!sql.includes('row_number()')) return 0;
    const eventId = values[0];
    const line = this.rsvp.rows
      .filter(r => r.eventId === eventId && r.status === 'waitlisted')
      .sort(
        (a, b) =>
          (a.waitlistPosition ?? Infinity) - (b.waitlistPosition ?? Infinity) ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );
    let changed = 0;
    line.forEach((r, i) => {
      if (r.waitlistPosition !== i + 1) {
        r.waitlistPosition = i + 1;
        changed++;
      }
    });
    return changed;
  }

  // Seeding helpers
  addEvent(over: Row = {}) {
    const row = {id: uid(), createdAt: new Date(), updatedAt: new Date(), status: 'published', deletedAt: null, capacity: null, format: 'online', slug: `ev-${uid().slice(-6)}`, title: 'Launch party', timezone: 'UTC', pollJoinCode: 'ABC123', venueName: null, venueAddress: null, mapUrl: null, joinUrl: null, thankYouLink: null, startAt: new Date(Date.now() + 86_400_000), endAt: new Date(Date.now() + 90_000_000), ...over};
    this.event.rows.push(row);
    return row;
  }
  addTicket(eventId: string, over: Row = {}) {
    const row = {id: uid(), eventId, name: 'General', priceCents: 2500, currency: 'USD', ...over};
    this.ticketType.rows.push(row);
    return row;
  }
  addRsvp(eventId: string, over: Row = {}) {
    const row = {id: uid(), eventId, name: 'Ada Lovelace', email: `ada${seq}@example.com`, response: 'going', status: 'awaiting_payment', seats: 1, waitlistPosition: null, claimExpiresAt: null, confirmedAt: null, ticketCode: 'TICKET01', ticketTypeId: null, createdAt: new Date(), updatedAt: new Date(), ...over};
    this.rsvp.rows.push(row);
    return row;
  }
  addOrder(rsvpId: string, over: Row = {}) {
    const row = {id: uid(), rsvpId, checkoutId: `pcs_test${String(++seq).padStart(8, '0')}`, amountCents: 2500, currency: 'USD', seats: 1, status: 'pending', createdAt: new Date(), ...over};
    this.ticketOrder.rows.push(row);
    return row;
  }
}
