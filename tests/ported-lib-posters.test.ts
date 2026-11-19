import {describe, expect, it} from 'vitest';

import {POSTER_PALETTES} from '../src/lib/event-schemas';
import {
  defaultPalette, fitHeadline, headlineBox, headlineStep, isPosterDesign, paletteLabel, posterDate, posterDesigns, posterFor,
  posterPalettes, posterTextFor, sampleText,
} from '../src/lib/posters';

const box = {base: 25, width: 84, height: 82, lineHeight: 0.9, glyph: 0.52};

describe('posterTextFor', () => {
  const event = {title: 'Pricing clinic', startAt: '2026-11-14T19:00:00Z', timezone: 'UTC', format: 'in_person' as const, venueName: 'The Loft'};
  it('uses title, date and venue by default', () => {
    expect(posterTextFor(event)).toEqual({headline: 'Pricing clinic', eyebrow: 'Sat 14 Nov · 19:00', footer: 'The Loft'});
  });
  it('says Online for online events', () => expect(posterTextFor({...event, format: 'online'}).footer).toBe('Online'));
  it('lets the creator override lines, ignoring blanks', () => {
    expect(posterTextFor(event, {headline: '  Price it right ', eyebrow: '', footer: 'Doors 6:30'} as never)).toEqual({
      headline: 'Price it right', eyebrow: 'Sat 14 Nov · 19:00', footer: 'Doors 6:30',
    });
  });
});

describe('posterDate', () => {
  it('formats in the event zone', () => expect(posterDate('2026-11-14T19:00:00Z', 'Asia/Dhaka')).toBe('Sun 15 Nov · 01:00'));
  it('is empty for a missing date or bad zone', () => {
    expect(posterDate('', 'UTC')).toBe('');
    expect(posterDate(null, 'UTC')).toBe('');
    expect(posterDate('2026-11-14T19:00:00Z', 'Not/AZone')).toBe('');
  });
});

describe('fitHeadline', () => {
  it('keeps the authored size for short headlines', () => expect(fitHeadline('Brunch', box)).toBe(25));
  it('shrinks long titles so words do not break', () => {
    const size = fitHeadline('Quarterly community town hall and networking evening', box);
    expect(size).toBeLessThan(25);
    expect('networking'.length * size * box.glyph).toBeLessThanOrEqual(box.width);
  });
  it('never goes below the floor', () => expect(fitHeadline('x '.repeat(200), box)).toBeCloseTo(25 * 0.3));
  it('returns base for empty text', () => expect(fitHeadline('   ', box)).toBe(25));
});

describe('designs and palettes', () => {
  it('lists the same palettes as the schema', () => expect([...posterPalettes]).toEqual([...POSTER_PALETTES]));
  it('every design has a default palette, sample text and headline box; every palette a label', () => {
    for (const d of posterDesigns) {
      expect(posterPalettes).toContain(defaultPalette[d]);
      expect(sampleText[d].headline).toBeTruthy();
      expect(headlineBox[d].base).toBeGreaterThan(0);
    }
    for (const p of posterPalettes) expect(paletteLabel[p]).toBeTruthy();
  });
  it('isPosterDesign is a strict guard', () => {
    expect(isPosterDesign('ama')).toBe(true);
    expect(isPosterDesign('nope')).toBe(false);
    expect(isPosterDesign(3)).toBe(false);
  });
  it('posterFor is stable and always a real design', () => {
    expect(posterFor('abc')).toBe(posterFor('abc'));
    for (const s of ['', 'a', 'some-uuid-1234', 'z'.repeat(5000)]) expect(isPosterDesign(posterFor(s))).toBe(true);
  });
  it('headlineStep is an integer class between 4 and 27', () => {
    for (const d of posterDesigns) {
      for (const t of ['Hi', 'A very long headline that goes on and on and on for ages', 'x '.repeat(300)]) {
        const s = headlineStep(d, t);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(4);
        expect(s).toBeLessThanOrEqual(27);
      }
    }
  });
});
