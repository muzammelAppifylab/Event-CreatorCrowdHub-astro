import {describe, expect, it} from 'vitest';

import {applyBrand, applyFontPreset, applyPageBrand, checkBrandContrast, contrastRatio, normalizeHex, relativeLuminance} from '../src/lib/event-brand';

function fakeRoot(dataset: Record<string, string> = {}) {
  const style = new Map<string, string>();
  const attrs = new Map<string, string>();
  return {
    dataset,
    style: {setProperty: (k: string, v: string) => style.set(k, v), removeProperty: (k: string) => style.delete(k)},
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
    _style: style,
    _attrs: attrs,
  } as unknown as HTMLElement & {_style: Map<string, string>; _attrs: Map<string, string>};
}

describe('normalizeHex', () => {
  it('accepts 3 and 6 digits, with or without #, any case', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex(' 2B44FF ')).toBe('#2b44ff');
  });
  it('rejects junk', () => {
    for (const bad of ['', '#12', '#12345', 'red', '#gggggg', '#1234567', 'url(x)']) expect(normalizeHex(bad)).toBeNull();
  });
});

describe('contrast', () => {
  it('luminance extremes', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1);
  });
  it('black on white is 21', () => expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21));
  it('is symmetric', () => expect(contrastRatio('#2b44ff', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#2b44ff')));
  it('picks ink on a light fill and paper on a dark fill', () => {
    expect(checkBrandContrast('#ffe27a').foreground).toBe('#000000');
    expect(checkBrandContrast('#2b44ff').foreground).toBe('#ffffff');
  });
  it('flags a pale brand as failing as text on white but fine as a fill', () => {
    const r = checkBrandContrast('#ffe27a');
    expect(r.textPassesAA).toBe(false);
    expect(r.fillPassesAA).toBe(true);
  });
});

describe('applyBrand', () => {
  it('sets properties; omits --brand-text when it would fail AA', () => {
    const root = fakeRoot();
    applyBrand('#2B44FF', root);
    expect(root._style.get('--brand')).toBe('#2b44ff');
    expect(root._style.get('--brand-text')).toBe('#2b44ff');
    applyBrand('#ffe27a', root);
    expect(root._style.has('--brand-text')).toBe(false);
    expect(root._style.get('--brand-foreground')).toBe('#000000');
  });
  it('clears with null, and ignores an invalid colour', () => {
    const root = fakeRoot();
    applyBrand('#2b44ff', root);
    expect(applyBrand(null, root)).toBeNull();
    expect(root._style.size).toBe(0);
    expect(applyBrand('not-a-colour', root)).toBeNull();
    expect(root._style.size).toBe(0);
  });
  it('font preset and page brand', () => {
    const root = fakeRoot({brand: '#2b44ff', fontPreset: 'serif'});
    applyPageBrand(root);
    expect(root._style.get('--brand')).toBe('#2b44ff');
    expect(root._attrs.get('data-font-preset')).toBe('serif');
    applyFontPreset('inter', root);
    expect(root._attrs.has('data-font-preset')).toBe(false);
  });
});
