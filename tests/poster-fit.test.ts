import {describe, expect, it} from 'vitest';
import {headlineBox, headlineStep, posterDesigns} from '../src/lib/posters';

describe('poster headline fit', () => {
  it('Pricing Workshop keeps the authored 17cqw (40.8px at 240px)', () => {
    expect(headlineStep('workshop', 'Pricing Workshop')).toBe(17);
  });
  it('steps stay inside the CSS classes (4 to 27)', () => {
    for (const d of posterDesigns) {
      for (const t of ['A', 'Pricing Workshop', 'Extraordinarily long headline words here', 'x '.repeat(80)]) {
        const s = headlineStep(d, t);
        expect(s).toBeGreaterThanOrEqual(4);
        expect(s).toBeLessThanOrEqual(Math.max(27, headlineBox[d].base));
      }
    }
  });
  it('shrinks for a long single word', () => {
    expect(headlineStep('workshop', 'Internationalisation')).toBeLessThan(17);
  });
});
