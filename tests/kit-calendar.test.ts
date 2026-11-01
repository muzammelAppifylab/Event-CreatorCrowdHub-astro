import {describe, expect, it} from 'vitest';

import {buildMonthGrid} from '../src/portal/ui/calendar-grid';

describe('buildMonthGrid', () => {
  it('pads to whole weeks starting Sunday', () => {
    const weeks = buildMonthGrid(new Date(2026, 1, 10)); // Feb 2026 starts on Sunday, 28 days
    expect(weeks).toHaveLength(4);
    expect(weeks[0][0].getDate()).toBe(1);
    expect(weeks[3][6].getDate()).toBe(28);
  });
  it('includes neighbouring days and honours Monday start', () => {
    const weeks = buildMonthGrid(new Date(2026, 9, 15), 1); // Oct 2026
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0][0].getDay()).toBe(1);
    expect(weeks[0][0].getMonth()).toBe(8);
    expect(weeks[weeks.length - 1][6].getDay()).toBe(0);
  });
});
