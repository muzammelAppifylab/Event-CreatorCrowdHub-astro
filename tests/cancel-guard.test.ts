import {describe, expect, it} from 'vitest';

import {guarded} from '../src/portal/screens/event-hub-actions';

describe('guarded (Cancel event double click)', () => {
  it('runs once while the first run is still going', async () => {
    const flight = {current: false};
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const first = guarded(flight, async () => {
      runs += 1;
      await gate;
      return 'body';
    });
    const second = guarded(flight, async () => {
      runs += 1;
      return 'second';
    });
    expect(flight.current).toBe(true);
    await expect(second).resolves.toBeUndefined();
    release();
    await expect(first).resolves.toBe('body');
    expect(runs).toBe(1);
    expect(flight.current).toBe(false);
  });

  it('allows a new run after the previous one finished or failed', async () => {
    const flight = {current: false};
    await expect(guarded(flight, async () => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
    expect(flight.current).toBe(false);
    await expect(guarded(flight, async () => 'again')).resolves.toBe('again');
  });
});
