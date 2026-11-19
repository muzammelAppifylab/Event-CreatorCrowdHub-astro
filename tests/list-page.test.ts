import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {listUrl} from '../src/lib/list-page';

// The template checks its /jobs/ page here; this app removed the job board, so only the
// helper itself is checked (with the app's own events list route).
describe('a list page', () => {
  it('asks for the plain route with no filters, so the preload is used', () => {
    expect(listUrl('/site-api/events', new URLSearchParams())).toBe('/site-api/events');
    expect(listUrl('/site-api/events', new URLSearchParams('q=&format='))).toBe('/site-api/events');
  });

  it('keeps filters, and the next page wins over a cursor in the URL', () => {
    const params = new URLSearchParams('format=online&before=40&when=week');
    expect(listUrl('/site-api/events', params)).toBe('/site-api/events?format=online&when=week&before=40');
    expect(listUrl('/site-api/events', params, 'before', 12)).toBe('/site-api/events?format=online&when=week&before=12');
  });

  it('never builds a row from HTML', () => {
    const helper = readFileSync(new URL('../src/lib/list-page.ts', import.meta.url), 'utf8');
    expect(helper).not.toMatch(/innerHTML|set:html|insertAdjacentHTML/);
  });
});
