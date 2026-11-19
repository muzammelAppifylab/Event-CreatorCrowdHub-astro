import {type Context, Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import {audit} from '../../platform/auth';
import {config} from '../../platform/config';
import {can, problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {isProvider, keyStatus, PAYPAL_MODE_NAME, type Provider, PROVIDER_NAMES, PROVIDERS, providerReady} from '../../platform/payment-providers';
import {siteBase} from '../jobs/shared';
import {pickedProvider} from '../payments/provider-tickets';
import {PERMISSIONS} from '../permissions';

/**
 * How ticket payments are taken (docs/agent/payments-providers.md "1. The admin"; the store asks
 * for this choice: docs/agent/store-apps.md "An app that sells"). Mounted at `/site-api/payment-settings`:
 *
 *   GET  /payment-settings   `site:payments:read` or `:manage`: the pick, and for each provider which
 *                            secret NAMES are set (booleans only, never a value), its mode, what
 *                            looks wrong, the webhook URL to paste and the events to send
 *   PUT  /payment-settings   `site:payments:manage`: {provider: 'ezypay' | 'stripe' | 'paypal' | null}.
 *                            Only a ready provider (every secret set, a usable mode) may be saved;
 *                            null goes back to the built-in checkout. Audited.
 *
 * The read-only demo role holds only `site:payments:read`: it sees the choice, the PUT answers 403.
 */

/** The webhook events this app handles, per provider (routes/provider-webhooks.ts). */
export const WEBHOOK_EVENTS: Record<Provider, string[]> = {
  ezypay: ['payment.succeeded', 'payment.failed', 'payment.refunded'],
  stripe: ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired', 'charge.refunded'],
  paypal: ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'],
};

/** Where the owner gets each provider's keys (shown on the screen). */
const KEY_SOURCES: Record<Provider, string> = {
  ezypay: 'Your Ezypay dashboard (ezypay.ezycourse.com): API keys, in Test and in Live. The webhook secret is shown once when you add the webhook.',
  stripe: 'Stripe Dashboard: Developers, API keys (Test mode on for the sandbox). The signing secret is on the webhook endpoint\'s page.',
  paypal: 'developer.paypal.com: Apps & Credentials (Sandbox and Live tabs). The webhook id is on the app\'s Webhooks list.',
};

export type ProviderStatus = {
  provider: Provider;
  name: string;
  secrets: {name: string; set: boolean}[];
  /** PayPal only: PAYPAL_MODE (`live` under Production only; not a secret, never required). */
  modeSetting: string | null;
  mode: 'test' | 'live' | null;
  ready: boolean;
  keyLooksWrong: boolean;
  modesDiffer: boolean;
  liveInPreview: boolean;
  webhookUrl: string;
  webhookEvents: string[];
  keySource: string;
};

export type PaymentSettingsDto = {provider: Provider | null; preview: boolean; providers: ProviderStatus[]};

function statusOf(origin: string): ProviderStatus[] {
  return PROVIDERS.map(p => {
    const s = keyStatus(p);
    return {
      provider: p,
      name: PROVIDER_NAMES[p],
      secrets: s.secrets.map(x => ({name: x.name, set: x.set})),
      modeSetting: p === 'paypal' ? PAYPAL_MODE_NAME : null,
      mode: s.mode,
      ready: s.ready,
      keyLooksWrong: s.keyLooksWrong,
      modesDiffer: s.modesDiffer,
      liveInPreview: s.liveInPreview,
      webhookUrl: `${origin}/site-api/payment-webhooks/${p}`,
      webhookEvents: WEBHOOK_EVENTS[p],
      keySource: KEY_SOURCES[p],
    };
  });
}

/** The site's own address (where providers post), else this request's. */
const originOf = (c: Context) => (config.siteUrl ? siteBase() : new URL(c.req.url).origin);

/** Read OR manage: a viewer who may change the pick may see it too. */
const canSee = createMiddleware(async (c, next) => {
  if ((await can(c as never, PERMISSIONS.PAYMENTS_READ)) || (await can(c as never, PERMISSIONS.PAYMENTS_MANAGE))) return next();
  return c.json(problem('forbidden', 'You do not have permission to do that.'), 403);
});

const putBody = validator('json', (value, c) => {
  const provider = (value as {provider?: unknown} | null)?.provider;
  if (provider === null || isProvider(provider)) return {provider: provider as Provider | null};
  return c.json({...problem('invalid_input', 'Choose Ezypay, Stripe, PayPal or the built-in payments.'), fields: {provider: 'Choose Ezypay, Stripe, PayPal or the built-in payments.'}}, 422);
});

export const providerAdminRoutes = new Hono()
  .get('/', withViewer, requireAuth, canSee, withDb, async c => {
    const provider = await pickedProvider(c.var.db);
    c.header('Cache-Control', 'private, no-store');
    return c.json({provider, preview: config.preview, providers: statusOf(originOf(c))} satisfies PaymentSettingsDto);
  })

  .put('/', withViewer, requireAuth, requirePermission(PERMISSIONS.PAYMENTS_MANAGE), putBody, withDb, async c => {
    const {provider} = c.req.valid('json');
    if (provider && !providerReady(provider)) {
      const missing = keyStatus(provider).secrets.filter(s => !s.set).map(s => s.name);
      const message = missing.length
        ? `${PROVIDER_NAMES[provider]} can't be chosen yet: add ${missing.join(', ')} on the Secrets page.`
        : `${PROVIDER_NAMES[provider]} can't be chosen yet: check its keys on the Secrets page.`;
      return c.json({...problem('provider_not_ready', message), fields: {provider: message}}, 409);
    }
    const db = c.var.db;
    const before = await pickedProvider(db);
    await db.providerSettings.upsert({where: {id: 1}, create: {id: 1, provider}, update: {provider}});
    await audit(db, {actorUserId: c.var.viewer.id, action: 'payment_provider_changed', target: ['provider_settings', 1], meta: {from: before, to: provider}});
    c.header('Cache-Control', 'private, no-store');
    return c.json({provider, preview: config.preview, providers: statusOf(originOf(c))} satisfies PaymentSettingsDto);
  });
