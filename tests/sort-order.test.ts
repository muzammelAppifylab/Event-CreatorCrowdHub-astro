import {describe, expect, it} from 'vitest';

import {nextSortOrder, validateOrder} from '../src/server/sort-order';

describe('validateOrder', () => {
  const rows = ['a', 'b', 'c'];
  it('accepts any permutation of exactly the existing ids', () => {
    expect(validateOrder(['c', 'a', 'b'], rows)).toBe(true);
  });
  it('rejects missing, extra, duplicate, foreign and non-array input', () => {
    expect(validateOrder(['a', 'b'], rows)).toBe(false);
    expect(validateOrder(['a', 'b', 'c', 'd'], rows)).toBe(false);
    expect(validateOrder(['a', 'a', 'b'], rows)).toBe(false);
    expect(validateOrder(['a', 'b', 'x'], rows)).toBe(false);
    expect(validateOrder(['a', 'b', 1], rows)).toBe(false);
    expect(validateOrder('abc', rows)).toBe(false);
    expect(validateOrder([], [])).toBe(false);
  });
});

describe('nextSortOrder', () => {
  it('continues after the max', () => {
    expect(nextSortOrder(null)).toBe(0);
    expect(nextSortOrder(4)).toBe(5);
  });
});
