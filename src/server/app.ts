import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';

import {isPreview} from '../platform/api';
import {adminRoutes, authRoutes, getAccess, getViewer} from '../platform/auth';
import {config} from '../platform/config';
import {csrf, previewCookies, problem, requireAuth, sameOrigin, withViewer} from '../platform/guards';
import {syncPermissions} from '../platform/permission-sync';
import {authSettings} from './auth-settings';
import {adminAnalyticsRoutes} from './routes/admin-analytics';
import {adminCheckinRoutes} from './routes/admin-checkin';
import {adminEventRoutes} from './routes/admin-events';
import {adminGuestRoutes} from './routes/admin-guests';
import {adminInviteRoutes} from './routes/admin-invites';
import {adminMessageRoutes} from './routes/admin-messages';
import {adminOverviewRoutes} from './routes/admin-overview';
import {adminPollRoutes} from './routes/admin-polls';
import {adminRefundRoutes} from './routes/admin-refunds';
import {adminWebhookRoutes} from './routes/admin-webhooks';
import {eventCheckoutRoutes} from './routes/event-checkout';
import {eventSettingsRoutes} from './routes/event-settings';
import {pageViewRoutes} from './routes/pageviews';
import {pollPublicRoutes} from './routes/polls-public';
import {privacyRoutes} from './routes/privacy';
import {rsvpRoutes, setPaidCheckoutHook} from './routes/rsvp';
import {startTicketCheckout} from './ticket-checkout';
import {getDb} from '../platform/db';
import {checkoutRoutes, membershipRoutes} from './routes/checkout';
import {abilitiesFor, CATALOGUE} from './permissions';
import {eventRoutes} from './routes/events';
import {siteRoutes} from './routes/site';
import {inputGuard, onSiteApiError} from './validate';

// Paid tickets: the RSVP route holds the seat, the platform checkout takes the money. ONE path:
// `startTicketCheckout` here, then `confirmPaidTicket` / `releaseHold` from payments-hooks.ts
// (they also keep `ticket_orders` in step, which `confirmRsvpPayment` does not).
setPaidCheckoutHook(async ({origin, rsvp, manageToken}) => {
  const db = getDb();
  if (!db) return null;
  const started = await startTicketCheckout(db, rsvp.id, {requestUrl: origin, cancelPath: `/r/${manageToken}/`});
  return started.ok ? {checkoutUrl: started.redirectUrl} : null;
});

/** `/health/deep`: whether the Site Database answers within 3 s (a public boolean, cached ~10 s). */
const HEALTH_TTL_MS = 10_000;
let lastHealth: {at: number; ok: boolean} | null = null;
async function databaseReachable(): Promise<boolean> {
  if (lastHealth && Date.now() - lastHealth.at < HEALTH_TTL_MS) return lastHealth.ok;
  const db = getDb();
  let ok = false;
  if (db) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      ok = await Promise.race([
        db.$queryRaw`SELECT 1`.then(() => true),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), 3000);
        }),
      ]);
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
  }
  lastHealth = {at: Date.now(), ok};
  return ok;
}

/**
 * The Site API: this site's ONLY backend, one Hono app at `/site-api/*`.
 *
 * Everything reads and writes through it: the Astro pages call it IN-PROCESS
 * (`src/server/backend.ts`), the portal and the `/account` pages call it from
 * the browser (`siteFetch` / the typed `hc` client, `src/portal/api.ts`).
 * Mounted by ONE catch-all page, `src/pages/site-api/[...path].ts`.
 *
 *   GET  /health        what this site has been given (booleans only)
 *   GET  /health/deep   200 when the Site Database answers, else 503 (uptime monitors)
 *   GET  /me            the visitor + what the UI may show them
 *   *    /auth/...      sign-up, sign-in, sessions, passwords   platform/auth/routes.ts
 *   *    /admin/...     users, roles, audit log (admins)        platform/auth/admin.ts
 *   GET  /site          the site's brand                        routes/site.ts
 *   *    /checkout/...  start and confirm a payment             routes/checkout.ts
 *   *    /memberships/... the member's memberships               routes/checkout.ts
 *
 * Add a feature as a new `routes/<name>.ts` and one `.route()` line below,
 * CHAINED so `AppType` carries every route to the typed client. Errors are
 * JSON `{error, message}`. `sameOrigin` + `csrf` refuse every cross-site or
 * token-less write; keep them, with `previewCookies` before them (a webhook
 * that must accept a cross-site write gets its own app, mounted before them,
 * with its own authentication).
 */
export const app = new Hono()
  .basePath('/site-api')
  // The editor Preview only: auth cookies carried in headers (its gateway drops cookies).
  .use(previewCookies)
  .use(sameOrigin)
  // The Buy button posts here as a plain form too (no JavaScript): BEFORE `csrf`, with its own
  // `formCsrf` (the token, or a same-origin form post). Keep it here (docs/agent/payments.md).
  .route('/checkout', checkoutRoutes)
  .use(csrf)
  // No route here takes a big body; uploads never pass through the Worker.
  .use(bodyLimit({maxSize: 64 * 1024, onError: c => c.json(problem('too_large', 'That request is too large.'), 413)}))
  // Events organiser routes (site:event:manage / site:event:checkin): signed-in first, before
  // `inputGuard` and any route's validator, so an anonymous caller gets 401, never 404/415/422
  // (getViewer is memoised per request; each route still runs its own full guard chain).
  .use('/event-admin/*', withViewer, requireAuth)
  .use('/checkin/*', withViewer, requireAuth)
  .use('/admin-events/*', withViewer, requireAuth)
  .use('/overview/*', withViewer, requireAuth)
  .use('/analytics/*', withViewer, requireAuth)
  .use('/polls/*', withViewer, requireAuth)
  .use('/refunds/*', withViewer, requireAuth)
  .use('/webhook-endpoints/*', withViewer, requireAuth)
  // Not /event-settings (its /brand route is public) nor /polls-public.
  // JSON bodies only on writes (415), no NUL in the URL or body (422): src/server/validate.ts.
  .use(inputGuard)
  // New catalogue codenames reach the `permissions` table (once per isolate; no migration).
  .use(syncPermissions(CATALOGUE))

  .get('/health', c =>
    c.json({
      ok: true,
      preview: isPreview(),
      database: Boolean(config.databaseUrl),
      auth: Boolean(config.jwtSecret && config.databaseUrl),
      siteKey: Boolean(config.siteKey),
    })
  )
  // For uptime monitors: 200 only when the Site Database answers (503 otherwise). One `SELECT 1`
  // with a short timeout, remembered per isolate for a few seconds so a busy monitor costs little.
  .get('/health/deep', async c => {
    c.header('Cache-Control', 'no-store');
    const database = await databaseReachable();
    return c.json({ok: database, database}, database ? 200 : 503);
  })

  // `abilities` only decides what the UI SHOWS; every guarded route checks again.
  .get('/me', async c => {
    const [viewer, access] = await Promise.all([getViewer(c.req.raw), getAccess(c.req.raw)]);
    c.header('Cache-Control', 'private, no-store');
    // One flag per catalogue entry with an `ability` (src/server/permissions.ts).
    const abilities = abilitiesFor(new Set(access.permissions));
    return c.json({viewer, roles: access.roles, abilities});
  })

  .route('/auth', authRoutes(authSettings))
  .route('/admin', adminRoutes)
  .route('/site', siteRoutes)
  .route('/events', eventRoutes)
  .route('/memberships', membershipRoutes)
  // Events: organiser routes (their 401 gates are mounted above, before inputGuard) ...
  .route('/admin-events', adminEventRoutes)
  .route('/event-admin', adminGuestRoutes)
  .route('/event-admin', adminInviteRoutes)
  .route('/event-admin', adminMessageRoutes)
  .route('/event-settings', eventSettingsRoutes)
  .route('/overview', adminOverviewRoutes)
  .route('/checkin', adminCheckinRoutes)
  .route('/analytics', adminAnalyticsRoutes)
  .route('/polls', adminPollRoutes)
  .route('/refunds', adminRefundRoutes)
  .route('/webhook-endpoints', adminWebhookRoutes)
  // ... and the guest-facing ones (token in the path / body; all after csrf).
  .route('/rsvp', rsvpRoutes)
  .route('/event-checkout', eventCheckoutRoutes)
  .route('/polls-public', pollPublicRoutes)
  .route('/privacy', privacyRoutes)
  .route('/pageviews', pageViewRoutes)

  .notFound(c => c.json(problem('not_found', 'No such Site API route.'), 404))
  // Hono's own client errors keep their status; anything else is a logged 500 (tokens redacted).
  .onError(onSiteApiError);

export type AppType = typeof app;
