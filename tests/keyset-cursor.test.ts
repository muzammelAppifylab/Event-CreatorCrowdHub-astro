import {describe, expect, it} from 'vitest';

import {keysetAfter, type KeysetWhere, parsePageCursor} from '../src/lib/text';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const AT = new Date('2026-03-01T10:00:00.123Z');
const NEXT_MS = new Date('2026-03-01T10:00:00.124Z');

describe('keysetAfter', () => {
  it('ascending: later milliseconds, or the cursor millisecond with a greater id', () => {
    expect(keysetAfter('startAt', 'asc', {at: AT, id: ID})).toEqual({
      OR: [{startAt: {gte: NEXT_MS}}, {startAt: {gte: AT, lt: NEXT_MS}, id: {gt: ID}}],
    });
  });

  it('descending: earlier milliseconds, or the cursor millisecond with a smaller id', () => {
    expect(keysetAfter('createdAt', 'desc', {at: AT, id: ID})).toEqual({
      OR: [{createdAt: {lt: AT}}, {createdAt: {gte: AT, lt: NEXT_MS}, id: {lt: ID}}],
    });
  });

  it('keeps the cursor string the site emits readable', () => {
    const cursor = parsePageCursor(`${AT.toISOString()}_${ID}`);
    expect(cursor).toEqual({at: AT, id: ID});
  });
});

/**
 * Paging simulation: rows stamped in microseconds (as `timestamptz(6)` stores them), read back as
 * millisecond Dates (as the driver truncates them), paged with the emitted `<ISO>_<id>` cursor.
 */
type Row = {id: string; micros: number};
const asDate = (micros: number) => new Date(Math.floor(micros / 1000));

function matches(row: Row, where: KeysetWhere<'at'>): boolean {
  return where.OR.some(branch => {
    const ms = row.micros / 1000; // the column's real value, compared with millisecond Dates
    const r = branch.at;
    if (r.gte && !(ms >= r.gte.getTime())) return false;
    if (r.lt && !(ms < r.lt.getTime())) return false;
    if (branch.id && 'gt' in branch.id && !(row.id > branch.id.gt)) return false;
    if (branch.id && 'lt' in branch.id && !(row.id < branch.id.lt)) return false;
    return true;
  });
}

function pageAll(rows: Row[], dir: 'asc' | 'desc', size: number): string[] {
  const sign = dir === 'asc' ? 1 : -1;
  const sorted = [...rows].sort((a, b) => sign * (a.micros - b.micros || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  const seen: string[] = [];
  let before: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const cursor = parsePageCursor(before);
    const hits = sorted.filter(r => !cursor || matches(r, keysetAfter('at', dir, cursor))).slice(0, size + 1);
    const page = hits.slice(0, size);
    seen.push(...page.map(r => r.id));
    const last = page.at(-1);
    if (hits.length <= size || !last) return seen;
    before = `${asDate(last.micros).toISOString()}_${last.id}`;
  }
  throw new Error('paging did not end');
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// One INSERT: five rows share `now()` with a sub-millisecond part, plus neighbours either side.
const base = Date.parse('2026-03-01T10:00:00.000Z') * 1000;
const ROWS: Row[] = [
  {id: id(9), micros: base + 1_000},
  ...[3, 7, 1, 5, 8].map(n => ({id: id(n), micros: base + 123_456})),
  {id: id(2), micros: base + 124_000},
  {id: id(4), micros: base + 500_789},
];

describe('keyset paging over microsecond timestamps', () => {
  for (const dir of ['asc', 'desc'] as const) {
    for (const size of [1, 2, 3]) {
      it(`${dir}, ${size} a page: every row exactly once, in order`, () => {
        const sign = dir === 'asc' ? 1 : -1;
        const expected = [...ROWS]
          .sort((a, b) => sign * (a.micros - b.micros || (a.id < b.id ? -1 : 1)))
          .map(r => r.id);
        expect(pageAll(ROWS, dir, size)).toEqual(expected);
      });
    }
  }
});
