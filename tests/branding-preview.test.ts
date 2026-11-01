import {describe, expect, it} from 'vitest';

import {posterLabel, previewVars, resolveBrandDraft} from '../src/portal/screens/branding-preview';

describe('branding preview helpers', () => {
  it('treats blank as default and junk as invalid', () => {
    expect(resolveBrandDraft('  ').state).toBe('default');
    expect(resolveBrandDraft('#12').state).toBe('invalid');
    expect(previewVars(resolveBrandDraft('nope'))).toEqual({});
  });
  it('normalises and reports contrast', () => {
    const d = resolveBrandDraft('#FFF');
    expect(d.state === 'ok' && d.hex).toBe('#ffffff');
    const light = resolveBrandDraft('#ffff00');
    expect(light.state === 'ok' && light.report.fillPassesAA).toBe(true);
    expect(light.state === 'ok' && light.report.textPassesAA).toBe(false);
  });
  it('only sets text colour when it passes AA on white', () => {
    expect(previewVars(resolveBrandDraft('#4f46e5'))['--primary-text']).toBe('#4f46e5');
    expect(previewVars(resolveBrandDraft('#ffff00'))['--primary-text']).toBeUndefined();
    expect(previewVars(resolveBrandDraft('#ffff00'))['--primary-foreground']).toBe('#000000');
  });
  it('labels posters', () => {
    expect(posterLabel('')).toBe('Automatic');
    expect(posterLabel('ama')).toBe('Ama');
  });
});
