import {Hono} from 'hono';
import {describe, expect, it} from 'vitest';

import {isUuid, parsePageCursor} from '../src/lib/text';
import {notFound} from '../src/server/validate';

// Audit L-37: one id check, one cursor reader, one 404 shape for the whole Site API.
const ID = '3f2b8c1e-5d4a-4e6f-8a9b-0c1d2e3f4a5b';
const ISO = '2026-06-10T12:00:00.000Z';

describe('isUuid', () => {
  it('accepts any canonical uuid, either case, and nothing else', () => {
    expect(isUuid(ID)).toBe(true);
    expect(isUuid(ID.toUpperCase())).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUuid('-'.repeat(36))).toBe(false);
    expect(isUuid(`${ID}x`)).toBe(false);
    expect(isUuid(7)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('parsePageCursor', () => {
  it('reads <ISO>_<uuid>', () => {
    expect(parsePageCursor(`${ISO}_${ID}`)).toEqual({at: new Date(ISO), id: ID});
    expect(parsePageCursor(`${ISO}_${ID.toUpperCase()}`)).toEqual({at: new Date(ISO), id: ID});
  });

  it('treats anything missing or malformed as the first page', () => {
    for (const raw of [undefined, null, 7, '', 'garbage', `${ISO}_nope`, `junk_${ID}`, `${ISO}_${ID}_x`, `${'9'.repeat(80)}_${ID}`]) {
      expect(parsePageCursor(raw)).toBeNull();
    }
  });
});

describe('notFound', () => {
  it('answers 404 with the problem shape and the route\'s own noun', async () => {
    const app = new Hono().get('/x', c => notFound(c, 'Webhook'));
    const res = await app.request('/x');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({error: 'not_found', message: 'Webhook not found.'});
  });
});
