import {describe, expect, it} from 'vitest';

import {sameSitePath} from '../src/lib/safe-path';

describe('sameSitePath (checkout "Go back" link, M-16)', () => {
  it('keeps a path on this site, with its query', () => {
    expect(sameSitePath('/')).toBe('/');
    expect(sameSitePath('/events/launch/')).toBe('/events/launch/');
    expect(sameSitePath('/thanks/?checkout=pcs_1&x=a%20b', '/thanks/')).toBe('/thanks/?checkout=pcs_1&x=a%20b');
  });

  it.each([
    ['/\\evil.example'],
    ['//evil.example'],
    ['\\\\evil.example'],
    ['/%5Cevil.example'],
    ['/%2Fevil.example'],
    ['%2F%2Fevil.example'],
    ['https://evil.example/'],
    ['javascript:alert(1)'],
    ['evil.example'],
    ['/ok\\..\\x'],
    ['/a\tb'],
    ['/a%0Ab'],
    ['/a\u007fb'],
    ['/%E0%A4%A'],
    [' //evil.example'],
    ['/%09/evil.example'],
    ['/%5c%5cevil.example'],
    ['/%00'],
    [''],
    [`/${'a'.repeat(512)}`],
  ])('falls back for %j', value => {
    expect(sameSitePath(value)).toBe('/');
    expect(sameSitePath(value, '/thanks/')).toBe('/thanks/');
  });

  it('falls back for a missing value', () => {
    expect(sameSitePath(null)).toBe('/');
    expect(sameSitePath(undefined, '/thanks/')).toBe('/thanks/');
    expect(sameSitePath(42)).toBe('/');
  });
});
