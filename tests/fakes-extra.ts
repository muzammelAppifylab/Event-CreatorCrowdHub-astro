import {FakeDb, Table} from './ticket-fake-db';

/** FakeDb plus the platform `order` table (unique checkoutId), used by payments-hooks tests. */
export class FakeDbX extends FakeDb {
  order = new Table(() => ({status: 'paid'}), () => undefined, () => this, [['checkoutId']]);
}
