import {Hono, type Context} from 'hono';

import type {PrismaClient} from '../../generated/prisma/client';
import {clientIp, invalid, rateLimitIp} from '../../platform/auth/kit';
import {problem, withAuthCore} from '../../platform/guards';
import {
  confirmConsent,
  consentState,
  eraseByManageToken,
  exportFilename,
  guestExport,
  guestSummary,
  unsubscribe,
  unsubscribeState,
} from '../privacy';

/**
 * Guest privacy, public and token-authenticated (ported from CreatorCrowdHub `privacy/routes.ts`,
 * `routes/consent.ts`). No session: the secret in the path IS the credential (the RSVP's manage
 * token, the signed consent token from the confirmation email, or a signed unsubscribe token from
 * any guest email). A bad, rotated, expired or foreign token is always the same 404, and no answer
 * echoes the token. Mount: `.route('/privacy', privacyRoutes)`.
 *
 *   GET  /privacy/consent/:token        what the consent page shows (never changes anything)
 *   POST /privacy/consent/:token        confirm marketing consent (the click; double opt-in)
 *   GET  /privacy/unsubscribe/:token    current state (manage token or signed unsubscribe token)
 *   POST /privacy/unsubscribe/:token    unsubscribe this person from the host's updates
 *   GET  /privacy/guest/:token          what we hold, in short
 *   GET  /privacy/guest/:token/export   the full data export (JSON download)
 *   POST /privacy/guest/:token/erase    body {confirm: "erase"}: erase this RSVP
 *
 * Confirming and unsubscribing are POSTs behind a button, never GET side effects: mail scanners
 * and link previews open every link. Writes also pass the app-wide `sameOrigin` + `csrf` guards.
 *
 * Abuse limits (audit L-40: never by changing the managed limiter's kinds): a bounded count on the
 * site's own `privacy_attempts` table, per client IP and per token, both only as keyed hashes.
 */

type Env = {Variables: {db: PrismaClient; secret: string}};
type Ctx = Context<Env>;

/** One link opened over and over: 20 per token per hour. Someone guessing links: 120 per IP per 10 minutes. */
export const PRIVACY_LIMITS = {
  token: {windowMs: 60 * 60 * 1000, max: 20},
  ip: {windowMs: 10 * 60 * 1000, max: 120},
} as const;

const NOT_FOUND = problem('not_found', 'This link is not valid any more.');
const gone = (c: Ctx) => c.json(NOT_FOUND, 404);

/** Every privacy answer: private, never cached. */
const live = (c: Ctx) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
};

/** HMAC-SHA256 hex under the site secret: the raw token or IP never reaches the table. */
async function keyedHash(secret: string, kind: string, value: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`privacy-${kind}:${value}`)));
  return Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The rate limit: two bounded reads on `privacy_attempts` (indexes (ip_hash, created_at) and
 * (token_hash, created_at)), each stopping at max rows (a count of max blocks: exactly max tries per window), then this attempt is recorded.
 * Returns the 429 or null. Old rows are pruned by the daily retention job.
 */
async function limited(c: Ctx, token: string): Promise<Response | null> {
  const {db, secret} = c.var;
  const now = Date.now();
  const [ipHash, tokenHash] = await Promise.all([
    keyedHash(secret, 'ip', rateLimitIp(clientIp(c))),
    keyedHash(secret, 'token', token.slice(0, 512)),
  ]);
  const ipSince = new Date(now - PRIVACY_LIMITS.ip.windowMs);
  const tokenSince = new Date(now - PRIVACY_LIMITS.token.windowMs);
  const [byIp, byToken] = await Promise.all([
    db.$queryRaw<Array<{n: number}>>`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM privacy_attempts WHERE ip_hash = ${ipHash} AND created_at > ${ipSince} LIMIT ${PRIVACY_LIMITS.ip.max}) s`,
    db.$queryRaw<Array<{n: number}>>`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM privacy_attempts WHERE token_hash = ${tokenHash} AND created_at > ${tokenSince} LIMIT ${PRIVACY_LIMITS.token.max}) s`,
  ]);
  if ((byIp[0]?.n ?? 0) >= PRIVACY_LIMITS.ip.max || (byToken[0]?.n ?? 0) >= PRIVACY_LIMITS.token.max) {
    const seconds = (byIp[0]?.n ?? 0) >= PRIVACY_LIMITS.ip.max ? PRIVACY_LIMITS.ip.windowMs / 1000 : PRIVACY_LIMITS.token.windowMs / 1000;
    c.header('Retry-After', String(seconds));
    return c.json(problem('rate_limited', 'Too many tries with this link. Wait a while, then try again.'), 429);
  }
  await db.$executeRaw`INSERT INTO privacy_attempts (ip_hash, token_hash, created_at) VALUES (${ipHash}, ${tokenHash}, ${new Date(now)})`;
  return null;
}

/** Shared head of every route: no-store headers, then the rate limit. Returns the token, or the 429. */
async function begin(c: Ctx): Promise<{token: string; stop: Response | null}> {
  live(c);
  const token = c.req.param('token') ?? '';
  return {token, stop: await limited(c, token)};
}

export const privacyRoutes = new Hono<Env>()
  .use('*', withAuthCore)

  .get('/consent/:token', async c => {
    const {token, stop} = await begin(c);
    if (stop) return stop;
    const state = await consentState(c.var.db, token, c.var.secret, new Date());
    return state ? c.json(state) : gone(c);
  })

  .post('/consent/:token', async c => {
    const {token, stop} = await begin(c);
    if (stop) return stop;
    const result = await confirmConsent(c.var.db, token, c.var.secret, new Date());
    if (result === 'invalid') return gone(c);
    return c.json({
      state: result,
      message:
        result === 'confirmed'
          ? "Thanks, you're on the list. You can unsubscribe from any update."
          : 'You are not subscribed to updates, so nothing was changed.',
    });
  })

  .get('/unsubscribe/:token', async c => {
    const {token, stop} = await begin(c);
    if (stop) return stop;
    const state = await unsubscribeState(c.var.db, token, c.var.secret);
    return state ? c.json(state) : gone(c);
  })

  .post('/unsubscribe/:token', async c => {
    const {token, stop} = await begin(c);
    if (stop) return stop;
    const result = await unsubscribe(c.var.db, token, c.var.secret);
    return result === 'ok' ? c.json({state: 'off', message: 'You are unsubscribed. No more updates from the host.'}) : gone(c);
  })

  .get('/guest/:token', async c => {
    const {token, stop} = await begin(c);
    if (stop) return stop;
    const summary = await guestSummary(c.var.db, token);
    return summary ? c.json(summary) : gone(c);
  })

  .get('/guest/:token/export', async c => {
    const {token, stop} = await begin(c);
    if (stop) return stop;
    const now = new Date();
    const doc = await guestExport(c.var.db, token, now);
    if (!doc) return gone(c);
    return c.body(JSON.stringify(doc, null, 2), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(doc.event.slug, now)}"`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
  })

  .post('/guest/:token/erase', async c => {
    const {token, stop} = await begin(c);
    if (stop) return stop;
    const parsed = await c.req.json().catch(() => null);
    const confirm = parsed && typeof parsed.confirm === 'string' ? parsed.confirm.trim().toLowerCase() : '';
    if (confirm !== 'erase') return invalid(c, {confirm: 'Type "erase" to confirm.'});
    const result = await eraseByManageToken(c.var.db, token, c);
    if (result === 'not_found') return gone(c);
    if (result === 'checkout_in_progress') {
      return c.json(problem('checkout_in_progress', 'Your payment is still being completed. Try again once it has finished or expired.'), 409);
    }
    return c.json({message: 'Your data has been erased. This link no longer works.'});
  });
