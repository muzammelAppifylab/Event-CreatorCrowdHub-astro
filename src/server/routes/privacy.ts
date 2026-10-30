import {Hono} from 'hono';

import {attempt, invalid, keysFor, type Ctx} from '../../platform/auth/kit';
import {RATE_LIMITS, type AttemptKind, type KindPolicy} from '../../platform/auth/rate-limit';
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
 * token, or the signed consent token from the confirmation email). A bad, rotated, expired or
 * foreign token is always the same 404, and no answer echoes the token. Mount: `.route('/privacy', privacyRoutes)`.
 *
 *   GET  /privacy/consent/:token        what the consent page shows (never changes anything)
 *   POST /privacy/consent/:token        confirm marketing consent (the click; double opt-in)
 *   GET  /privacy/unsubscribe/:token    current marketing state
 *   POST /privacy/unsubscribe/:token    withdraw marketing consent
 *   GET  /privacy/guest/:token          what we hold, in short
 *   GET  /privacy/guest/:token/export   the full data export (JSON download)
 *   POST /privacy/guest/:token/erase    body {confirm: "erase"}: erase this RSVP
 *
 * Confirming and unsubscribing are POSTs behind a button, never GET side effects: mail scanners
 * and link previews open every link. Writes also pass the app-wide `sameOrigin` + `csrf` guards.
 *
 * Abuse limits: kind `privacy`, per client IP and per token (hashed): the template's rate limiter.
 */

/**
 * `privacy` is not in the template's `AttemptKind` list: its policy is registered once, here, so
 * this slice needs no edit to `rate-limit.ts` (move it into `RATE_LIMITS` there when convenient).
 */
const PRIVACY_KIND = 'privacy' as AttemptKind;
(RATE_LIMITS as Record<string, KindPolicy>)['privacy'] ??= {
  // One link opened over and over, or someone guessing links: 20 per token per hour, 120 per IP per 10 min.
  subject: {windowSeconds: 60 * 60, free: 20, baseDelaySeconds: 60, maxDelaySeconds: 60 * 60, counts: 'all'},
  ip: {windowSeconds: 10 * 60, free: 120, baseDelaySeconds: 10, maxDelaySeconds: 10 * 60, counts: 'all'},
};

const NOT_FOUND = problem('not_found', 'This link is not valid any more.');
const gone = (c: Ctx) => c.json(NOT_FOUND, 404);

/** Every privacy answer: private, never cached. */
const live = (c: Ctx) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
};

/** Rate limit by IP and by token; the token is only ever hashed (`keysFor`). Returns the 429 or null. */
async function limited(c: Ctx, token: string): Promise<Response | null> {
  const {stop} = await attempt(c, PRIVACY_KIND, await keysFor(c, token.slice(0, 256)));
  return stop;
}

export const privacyRoutes = new Hono()
  .use('*', withAuthCore)

  .get('/consent/:token', async c => {
    const ctx = c as unknown as Ctx;
    live(ctx);
    const token = c.req.param('token');
    const stop = await limited(ctx, token);
    if (stop) return stop;
    const state = await consentState(c.var.db, token, c.var.secret, new Date());
    return state ? c.json(state) : gone(ctx);
  })

  .post('/consent/:token', async c => {
    const ctx = c as unknown as Ctx;
    live(ctx);
    const token = c.req.param('token');
    const stop = await limited(ctx, token);
    if (stop) return stop;
    const result = await confirmConsent(c.var.db, token, c.var.secret, new Date());
    if (result === 'invalid') return gone(ctx);
    return c.json({
      state: result,
      message:
        result === 'confirmed'
          ? "Thanks, you're on the list. You can unsubscribe from any update."
          : 'You are not subscribed to updates, so nothing was changed.',
    });
  })

  .get('/unsubscribe/:token', async c => {
    const ctx = c as unknown as Ctx;
    live(ctx);
    const token = c.req.param('token');
    const stop = await limited(ctx, token);
    if (stop) return stop;
    const state = await unsubscribeState(c.var.db, token);
    return state ? c.json(state) : gone(ctx);
  })

  .post('/unsubscribe/:token', async c => {
    const ctx = c as unknown as Ctx;
    live(ctx);
    const token = c.req.param('token');
    const stop = await limited(ctx, token);
    if (stop) return stop;
    const result = await unsubscribe(c.var.db, token);
    return result === 'ok' ? c.json({state: 'off', message: 'You are unsubscribed. No more updates from the host.'}) : gone(ctx);
  })

  .get('/guest/:token', async c => {
    const ctx = c as unknown as Ctx;
    live(ctx);
    const token = c.req.param('token');
    const stop = await limited(ctx, token);
    if (stop) return stop;
    const summary = await guestSummary(c.var.db, token);
    return summary ? c.json(summary) : gone(ctx);
  })

  .get('/guest/:token/export', async c => {
    const ctx = c as unknown as Ctx;
    live(ctx);
    const token = c.req.param('token');
    const stop = await limited(ctx, token);
    if (stop) return stop;
    const now = new Date();
    const doc = await guestExport(c.var.db, token, now);
    if (!doc) return gone(ctx);
    return c.body(JSON.stringify(doc, null, 2), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(doc.event.slug, now)}"`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
  })

  .post('/guest/:token/erase', async c => {
    const ctx = c as unknown as Ctx;
    live(ctx);
    const token = c.req.param('token');
    const stop = await limited(ctx, token);
    if (stop) return stop;
    const parsed = await c.req.json().catch(() => null);
    const confirm = parsed && typeof parsed.confirm === 'string' ? parsed.confirm.trim().toLowerCase() : '';
    if (confirm !== 'erase') return invalid(c, {confirm: 'Type "erase" to confirm.'});
    const result = await eraseByManageToken(c.var.db, token);
    if (result === 'not_found') return gone(ctx);
    if (result === 'checkout_in_progress') {
      return c.json(problem('checkout_in_progress', 'Your payment is still being completed. Try again once it has finished or expired.'), 409);
    }
    return c.json({message: 'Your data has been erased. This link no longer works.'});
  });
