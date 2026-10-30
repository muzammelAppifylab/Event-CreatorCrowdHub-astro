# Porting: outbound webhooks + integrations

Files: `src/server/webhook-delivery.ts` (sign, SSRF URL check, one attempt, `deliverWebhookJob`),
`src/server/webhooks.ts` (`dispatchWebhook`), `src/server/routes/admin-webhooks.ts` (`adminWebhookRoutes`),
`src/portal/webhooks-queries.ts`, `src/portal/screens/integrations.tsx`, `tests/webhooks.test.ts`.

## Wiring (not done: files owned by others)
1. `src/server/app.ts`: `import {adminWebhookRoutes} from './routes/admin-webhooks';` and
   `.route('/webhook-endpoints', adminWebhookRoutes)` (not under `/webhooks`: reserved for inbound calls).
2. `src/server/background.ts` (one line in `defineBackground`):
   `'webhook-deliveries': (data, job) => deliverWebhookJob(data, job),`
   with `import {deliverWebhookJob} from './webhook-delivery';`. Retries come from the platform
   (1 min, 2 min, 10 min, 1 h). Optional `background.json`: `"lists": {"webhook-deliveries": {"retries": 4, "concurrency": 5}}`.
3. `src/portal/routes.tsx`:
   ```ts
   const integrationsRoute = createRoute({
     getParentRoute: () => rootRoute,
     path: '/integrations',
     staticData: {title: 'Integrations'},
     loader: ({context: {queryClient}}) => warm(queryClient.ensureQueryData(webhooksQuery)), // from './webhooks-queries'
     component: lazyRouteComponent(() => import('./screens/integrations'), 'Integrations'),
   });
   ```
   add it to the route tree, and a NAV item in "Manage":
   `{to: '/integrations', label: 'Integrations', icon: 'zap', ability: 'manageEvents'}` (use whichever
   ability maps to `site:event:manage`).
4. Emit events after the state change (never inside a transaction):
   `await dispatchWebhook(db, 'rsvp.created', {rsvpId, eventId, ...})`. It never throws and returns the number queued.

## Behaviour
- Routes (`site:event:manage`): GET list, POST create (201 `{endpoint, secret}`, secret shown once),
  PATCH `{url?, events?, active?}`, DELETE (204), POST `/:id/test` (one attempt, no retries). Max 10 endpoints.
- Signature: `X-Ezy-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>` (WebCrypto), plus `X-Ezy-Event`, `X-Ezy-Delivery` (same id on every retry).
- URL rule: https, no credentials, port 443 only, no IP in any notation, no single-label or `.local/.internal/...` names. Re-checked before every attempt. Redirects are never followed.
- Job data carries the JSON body (<= 24 KB, ids and Zap fields only); the secret is loaded from the DB in the handler.
- The portal screen's CSV export link is a placeholder (`EXPORT_CSV_HREF`).
- Stripe status (source `IntegrationsTab`) is not ported: payments are the template's built-in (`payments.md`).

## Schema gaps (no change made, prisma/* untouched)
`webhook_endpoints` has only id, url, secret, events, active. Missing vs the source: a name/label, `created_at`,
and last delivery status/time (and any delivery log table). The UI therefore shows host + secret hint only, and
failure history lives in the platform's Jobs tab. If wanted: add `name text`, `created_at timestamptz default now()`,
`last_status int`, `last_delivery_at timestamptz`. The secret is stored in clear (needed to sign); same as the source.
