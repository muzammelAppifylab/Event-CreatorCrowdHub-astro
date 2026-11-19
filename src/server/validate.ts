import type {Context} from 'hono';
import {createMiddleware} from 'hono/factory';
import {HTTPException} from 'hono/http-exception';

import {problem} from '../platform/guards';
import {isUuid, jsonHasNul} from '../lib/text';

/** Shared route helpers (audit L-37): import these, never copy them into a route. */
export {isUuid, parsePageCursor} from '../lib/text';

/**
 * The Site API's 404: `{error: 'not_found', message: '<What> not found.'}`. `what` is the
 * capitalised noun the route already used (`'Event'`, `'Webhook'`, `'Rule'`), so each
 * route keeps its exact message.
 */
export const notFound = (c: Context, what: string, message = `${what} not found.`) => c.json(problem('not_found', message), 404);

/**
 * Request hygiene for the whole Site API, mounted once in `app.ts` after `bodyLimit`:
 *
 *   - a NUL character anywhere in the URL (`%00` in a path segment or the query) → 422;
 *   - a write (POST/PUT/PATCH/DELETE) that carries a body must say it is JSON → 415
 *     (`validator('json')` silently ignores any other content type, so a mislabelled body
 *     used to become an empty, "successful" PATCH);
 *   - a JSON body holding a NUL (`\u0000`) → 422 (Postgres refuses NUL in text: `22021`).
 *
 * Malformed JSON itself is the validator's `HTTPException(400)`, passed through by `onError`.
 * The body is read through `c.req.text()`, which Hono caches, so the route still reads it.
 */
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const JSON_TYPE = /^application\/([\w.-]+\+)?json$/i;

const nulRefused = () => problem('invalid_input', 'The request holds a character that is not allowed (NUL). Remove it and try again.');

export const inputGuard = createMiddleware(async (c, next) => {
  const url = c.req.url;
  const start = url.indexOf('/', url.indexOf('//') + 2);
  if (/%00/i.test(start < 0 ? '' : url.slice(start))) return c.json(nulRefused(), 422);

  if (WRITES.has(c.req.method) && c.req.raw.body !== null && c.req.header('content-length') !== '0') {
    const mediaType = (c.req.header('content-type') ?? '').split(';')[0]!.trim();
    const text = await c.req.text();
    if (text.length > 0) {
      if (!JSON_TYPE.test(mediaType)) {
        return c.json(problem('unsupported_media_type', 'Send the request body as JSON (Content-Type: application/json).'), 415);
      }
      if (jsonHasNul(text)) return c.json(nulRefused(), 422);
    }
  }
  await next();
});

/**
 * A request path safe to log: secret-bearing segments (RSVP manage and invite tokens, privacy
 * tokens, poll guest links, ticket codes) are replaced by `:token`. Use it on every log line
 * that names a path.
 */
const TOKEN_ROUTES: RegExp[] = [
  /^(\/site-api\/rsvp\/(?:manage|invite)\/)[^/]+/,
  /^(\/site-api\/privacy\/[^/]+\/)[^/]+/,
  /^(\/site-api\/polls-public\/guest-link\/)[^/]+/,
  /^(\/site-api\/checkin\/codes\/)[^/]+/,
  /^(\/r\/)[^/]+/,
];
export function redactPath(path: string): string {
  let out = path;
  for (const re of TOKEN_ROUTES) out = out.replace(re, '$1:token');
  // Any other segment that looks like a long opaque token (24+ url-safe chars); ids stay readable.
  return out.replace(/\/([A-Za-z0-9_.~-]{24,})(?=\/|$)/g, (whole, seg: string) => (isUuid(seg) ? whole : '/:token'));
}

/**
 * The Site API's `onError`. A client error raised by Hono itself (malformed JSON in
 * `validator('json')`, ...) keeps its own status, in our JSON problem shape, and is not logged as a
 * server error. Anything else is a 500, logged with the message only (an error object can carry
 * request details) and the path with its tokens redacted.
 */
export function onSiteApiError(err: Error, c: Context): Response {
  if (err instanceof HTTPException && err.status < 500) {
    const code = err.status === 400 ? 'bad_request' : 'request_refused';
    return c.json(problem(code, err.message || 'That request could not be read.'), err.status);
  }
  console.error(`site-api ${c.req.method} ${redactPath(c.req.path)}: ${err.message}`);
  return c.json(problem('internal_error', 'Something went wrong.'), 500);
}
