import {Hono} from 'hono';
import {validator} from 'hono/validator';
import {describe, expect, it} from 'vitest';

import {hasNul, isStrictUuid, jsonHasNul, parseKeysetCursor} from '../src/lib/text';
import {parseEventFields} from '../src/lib/event-schemas';
import {validateRsvp} from '../src/lib/rsvp-types';
import {app} from '../src/server/app';
import {inputGuard, onSiteApiError, redactPath} from '../src/server/validate';

const ORIGIN = 'http://localhost';
const ID = '0192f0a1-0000-7000-8000-000000000001';

/** The real Site API, no database: the answers below all come before any query. */
const get = (path: string) => app.request(`${ORIGIN}${path}`);

/** The same middleware and error handler the Site API mounts, in front of a JSON route. */
const mini = new Hono()
  .use(inputGuard)
  .patch('/thing', validator('json', v => v as Record<string, unknown>), c => c.json({got: c.req.valid('json')}))
  .post('/empty', c => c.json({ok: true}))
  .onError(onSiteApiError);
const send = (method: string, path: string, body: string | undefined, type = 'application/json') =>
  mini.request(`${ORIGIN}${path}`, {method, body, headers: type ? {'content-type': type} : {}});

describe('M-6: malformed input is a client error, not a 500', () => {
  it('malformed JSON answers 400 in the problem shape', async () => {
    const res = await send('PATCH', '/thing', '{"title": ');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({error: 'bad_request'});
  });

  it('a NUL in a JSON body answers 422', async () => {
    const res = await send('PATCH', '/thing', JSON.stringify({title: 'a\u0000b'}));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({error: 'invalid_input'});
    // An escaped backslash followed by "u0000" is plain text, not a NUL.
    expect((await send('PATCH', '/thing', JSON.stringify({title: 'C:\\u0000'}))).status).toBe(200);
  });

  it('a NUL in the URL answers 422 on the real Site API (query or path)', async () => {
    expect((await get('/site-api/events?q=a%00b')).status).toBe(422);
    expect((await get('/site-api/events/abc%00')).status).toBe(422);
  });

  it('a crafted cursor answers 400 on the real Site API', async () => {
    for (const before of ['x'.repeat(36), `2026-01-01T00:00:00.000Z_${'-'.repeat(36)}`, 'not-a-cursor', `garbage_${ID}`]) {
      const res = await get(`/site-api/events?before=${encodeURIComponent(before)}`);
      expect(res.status, before).toBe(400);
      expect(await res.json()).toMatchObject({error: 'bad_cursor'});
    }
  });
});

describe('L-2: a write body must be JSON', () => {
  it('a JSON body sent as text/plain answers 415, not a silent 200', async () => {
    expect((await send('PATCH', '/thing', '{"title":"x"}', 'text/plain')).status).toBe(415);
    expect((await send('PATCH', '/thing', '{"title":"x"}', '')).status).toBe(415);
    expect((await send('PATCH', '/thing', '{"title":"x"}', 'application/json; charset=utf-8')).status).toBe(200);
  });

  it('a write with no body needs no content type', async () => {
    expect((await send('POST', '/empty', undefined, '')).status).toBe(200);
  });
});

describe('L-4: organiser routes check sign-in before validating', () => {
  it.each([
    ['/site-api/event-admin/events/not-a-uuid/guests?q=x'],
    [`/site-api/event-admin/events/${ID}/guests/export.csv?status=bogus`],
    ['/site-api/event-admin/events/not-a-uuid/invites?status=bogus'],
    [`/site-api/event-admin/contacts/detail?event=nope`],
    ['/site-api/checkin/events/not-a-uuid?q=x'],
    ['/site-api/checkin/codes/!!'],
  ])('GET %s answers 401 to a visitor', async path => {
    expect((await get(path)).status).toBe(401);
  });
});

describe('L-12: log lines never carry a token', () => {
  it('redacts token-bearing segments and keeps ids readable', () => {
    expect(redactPath('/site-api/rsvp/manage/abcDEF123_secret-token/cancel')).toBe('/site-api/rsvp/manage/:token/cancel');
    expect(redactPath('/site-api/rsvp/invite/aaaa.bbbb')).toBe('/site-api/rsvp/invite/:token');
    expect(redactPath('/site-api/privacy/unsubscribe/tok')).toBe('/site-api/privacy/unsubscribe/:token');
    expect(redactPath('/site-api/privacy/guest/tok/erase')).toBe('/site-api/privacy/guest/:token/erase');
    expect(redactPath('/site-api/polls-public/guest-link/tok')).toBe('/site-api/polls-public/guest-link/:token');
    expect(redactPath('/site-api/checkin/codes/TCK-1234')).toBe('/site-api/checkin/codes/:token');
    expect(redactPath('/r/abcdef/')).toBe('/r/:token/');
    expect(redactPath(`/site-api/event-admin/events/${ID}/guests`)).toBe(`/site-api/event-admin/events/${ID}/guests`);
    expect(redactPath('/site-api/other/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe('/site-api/other/:token');
  });
});

describe('shared checks', () => {
  it('parses cursors strictly', () => {
    expect(parseKeysetCursor(undefined)).toBeNull();
    expect(parseKeysetCursor('')).toBeNull();
    expect(parseKeysetCursor(`2026-01-01T00:00:00.000Z_${ID.toUpperCase()}`)).toEqual({startAt: new Date('2026-01-01T00:00:00.000Z'), id: ID});
    expect(parseKeysetCursor('x'.repeat(36))).toBe('invalid');
    expect(parseKeysetCursor(`nope_${ID}`)).toBe('invalid');
    expect(isStrictUuid(ID)).toBe(true);
    expect(isStrictUuid('-'.repeat(36))).toBe(false);
    expect(hasNul('a\u0000')).toBe(true);
    expect(jsonHasNul('{"a":"\\u0000"}')).toBe(true);
    expect(jsonHasNul('{"a":"\\\\u0000"}')).toBe(false);
  });

  it('the shared text validators refuse NUL as a field error', () => {
    const parsed = parseEventFields({title: 'Launch\u0000'}, true);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.fields.title).toMatch(/control character/);
    const rsvp = validateRsvp(
      {name: 'Ann\u0000', email: 'ann@example.com', response: 'going'},
      {allowMaybe: false, maxPlusOnes: 0, questions: [], ticketTypeIds: []} as never
    );
    expect(rsvp.ok).toBe(false);
    if (!rsvp.ok) expect(rsvp.fields.name).toMatch(/control character/);
  });
});
