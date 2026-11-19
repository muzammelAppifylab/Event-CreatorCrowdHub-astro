import {Hono} from 'hono';

import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {audit} from '../../platform/auth';
import {PERMISSIONS} from '../permissions';
import {holdsPermission, requireReadOrWrite} from '../guards-ext';
import {attemptDelivery, envelope, isWebhookEvent, newSecret, webhookUrlProblem, WEBHOOK_EVENTS, type WebhookEventName} from '../webhook-delivery';
import {eventsOf, MAX_ENDPOINTS} from '../webhooks';
import {isUuid, notFound} from '../validate';

/**
 * Outbound webhooks, admin side (ported from CreatorCrowdHub `team.ts`). Holders of `site:event:integrations` (owner only by default).
 * Mount: `.route('/webhook-endpoints', adminWebhookRoutes)` (NOT under `/webhooks`: that prefix is for inbound calls).
 *
 *   GET    /webhook-endpoints            list (secret never returned, only its last 4 characters)
 *   POST   /webhook-endpoints            {url, events}  -> 201 {endpoint, secret}  (the secret is shown ONCE)
 *   PATCH  /webhook-endpoints/:id        {url?, events?, active?}
 *   DELETE /webhook-endpoints/:id
 *   POST   /webhook-endpoints/:id/test   one signed `webhook.test` POST, answered at once, no retries
 *
 * Schema note: these routes read and write url, secret, events and active only; the delivery worker owns lastStatus/lastDeliveryAt.
 */


const select = {id: true, url: true, secret: true, events: true, active: true} as const;
/** The advisory lock every endpoint create takes. */
const WEBHOOK_LIMIT_LOCK = 'webhook-endpoint-limit';
type Row = {id: string; url: string; secret: string; events: unknown; active: boolean};

export const toEndpoint = (r: Row) => ({
  id: r.id,
  url: r.url,
  events: eventsOf(r.events),
  active: r.active,
  secretHint: r.secret.slice(-4),
});

/** For viewers without `site:event:integrations`: the host only, no secret hint. */
export const toRedactedEndpoint = (r: Row) => {
  let host = '';
  try {
    host = new URL(r.url).host;
  } catch {
    // A stored URL always parses (validated on save); show nothing if not.
  }
  return {id: r.id, url: host ? `https://${host}/…` : '', events: eventsOf(r.events), active: r.active, secretHint: ''};
};

const invalid = (field: string, message: string) => ({...problem('invalid_webhook', message), fields: {[field]: message}});

type Parsed = {url?: string; events?: WebhookEventName[]; active?: boolean} | {field: string; message: string};

/** Validates a create (`partial` false: url and events required) or update body. */
export function parseEndpointInput(value: unknown, partial: boolean): Parsed {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out: {url?: string; events?: WebhookEventName[]; active?: boolean} = {};
  if (!partial || v.url !== undefined) {
    const url = typeof v.url === 'string' ? v.url.trim() : '';
    const bad = webhookUrlProblem(url);
    if (bad) return {field: 'url', message: bad};
    out.url = url;
  }
  if (!partial || v.events !== undefined) {
    if (!Array.isArray(v.events) || v.events.length === 0) return {field: 'events', message: 'Pick at least one event.'};
    if (!v.events.every(isWebhookEvent)) return {field: 'events', message: 'Unknown event.'};
    out.events = WEBHOOK_EVENTS.filter(e => (v.events as unknown[]).includes(e));
  }
  if (v.active !== undefined) {
    if (typeof v.active !== 'boolean') return {field: 'active', message: 'Must be true or false.'};
    out.active = v.active;
  }
  return out;
}

const body = (c: {req: {json: () => Promise<unknown>}}) => c.req.json().catch(() => null);

export const adminWebhookRoutes = new Hono()
  .use('*', withViewer, requireAuth, requireReadOrWrite([PERMISSIONS.EVENT_INTEGRATIONS, PERMISSIONS.EVENT_READ], [PERMISSIONS.EVENT_INTEGRATIONS]), withDb)

  .get('/', async c => {
    const rows = await c.var.db.webhookEndpoint.findMany({select, orderBy: {id: 'asc'}, take: MAX_ENDPOINTS + 1});
    // See-only admins (the store's demo) see THAT endpoints exist, never a credential: a hook URL's
    // path is often its secret (Zapier, Slack), so only its host is shown, and no secret hint.
    const full = await holdsPermission(c, PERMISSIONS.EVENT_INTEGRATIONS);
    return c.json({endpoints: rows.map(full ? toEndpoint : toRedactedEndpoint), events: WEBHOOK_EVENTS});
  })

  .post('/', async c => {
    const parsed = parseEndpointInput(await body(c), false);
    if ('message' in parsed) return c.json(invalid(parsed.field, parsed.message), 422);
    const secret = newSecret();
    // Count and insert under one transaction-scoped advisory lock (a fixed key: the cap is site-wide),
    // so two creates at once can't both pass the cap.
    const row = await c.var.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${WEBHOOK_LIMIT_LOCK}, 0))`;
      if ((await tx.webhookEndpoint.count()) >= MAX_ENDPOINTS) return null;
      return tx.webhookEndpoint.create({data: {url: parsed.url!, events: parsed.events!, secret, active: true}, select});
    });
    if (!row) return c.json(problem('too_many_webhooks', `You can have at most ${MAX_ENDPOINTS} webhook endpoints.`), 409);
    await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'webhook_created', target: ['webhook', row.id]});
    return c.json({endpoint: toEndpoint(row), secret}, 201);
  })

  .patch('/:id', async c => {
    const id = c.req.param('id');
    if (!isUuid(id)) return notFound(c, 'Webhook');
    const parsed = parseEndpointInput(await body(c), true);
    if ('message' in parsed) return c.json(invalid(parsed.field, parsed.message), 422);
    if (Object.keys(parsed).length === 0) return c.json(invalid('url', 'Nothing to change.'), 422);
    const res = await c.var.db.webhookEndpoint.updateMany({where: {id}, data: parsed});
    if (res.count === 0) return notFound(c, 'Webhook');
    await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'webhook_updated', target: ['webhook', id], meta: {fields: Object.keys(parsed)}});
    const row = await c.var.db.webhookEndpoint.findUnique({where: {id}, select});
    return row ? c.json({endpoint: toEndpoint(row)}) : notFound(c, 'Webhook');
  })

  .delete('/:id', async c => {
    const id = c.req.param('id');
    if (!isUuid(id)) return notFound(c, 'Webhook');
    const res = await c.var.db.webhookEndpoint.deleteMany({where: {id}});
    if (res.count === 0) return notFound(c, 'Webhook');
    await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'webhook_deleted', target: ['webhook', id]});
    return c.body(null, 204);
  })

  .post('/:id/test', async c => {
    const id = c.req.param('id');
    if (!isUuid(id)) return notFound(c, 'Webhook');
    const endpoint = await c.var.db.webhookEndpoint.findUnique({where: {id}, select: {url: true, secret: true}});
    if (!endpoint) return notFound(c, 'Webhook');
    const {id: deliveryId, body: payload} = envelope('webhook.test', {message: 'Test event from Ezy Events. Your endpoint is connected.'});
    const r = await attemptDelivery(endpoint, 'webhook.test', deliveryId, payload);
    await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'webhook_tested', target: ['webhook', id], meta: {ok: r.ok}});
    return c.json({ok: r.ok, status: r.status, durationMs: r.durationMs, error: r.error});
  });
