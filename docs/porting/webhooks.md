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
- Signature (unchanged, kept for old receivers): `X-Ezy-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>` (WebCrypto), plus `X-Ezy-Event`, `X-Ezy-Delivery` (same id on every retry).
- Replay protection: `X-Ezy-Timestamp` (unix seconds, set on EVERY attempt) and `X-Ezy-Signature-V2: v2=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
  Receiver rules (also shown on the Integrations screen): use the raw body; reject when `|now - timestamp| > 300` s; compare the
  signature in constant time; remember `X-Ezy-Delivery` for a day and ignore repeats (delivery is at-least-once). Reference
  implementation: `verifySignatureV2` in `webhook-delivery.ts`. Example (Node):
  `const mac = "v2=" + createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex"); timingSafeEqual(Buffer.from(mac), Buffer.from(header))`
  (check the lengths match first). The old header does not protect against replay.
- URL rule: https, no credentials, port 443 only, no IP in any notation, no single-label or `.local/.internal/...` names. Re-checked before every attempt. Redirects are never followed.
- Job data (<= ~28 KB, platform cap 32 KB): `{items: [{id, event, body, endpointIds, attempt?}]}`; each body <= 16 KB (ids and Zap
  fields only), the secret is loaded from the DB in the handler. Jobs queued in the old single-delivery shape
  (`{endpointId, event, deliveryId, body}`) are still handled.

## Burst safety (platform allows ~10 job sends a minute: `E_JOBS_RATE_LIMITED`)
- `dispatchWebhooks(db, events[])` (`webhooks.ts`): one endpoints query, then ONE job for the whole emit (split only past ~28 KB). Each
  event lists the endpoints subscribed to it; the handler delivers per endpoint (own 5 s timeout, own result). `emitWebhooks`
  (`webhook-emit.ts`) is the entry for loops (waitlist promotions, cancellations, bulk guest actions); `emitWebhook` is one event.
- Durable: when `sendJob` fails (rate limit or anything), every (endpoint, delivery) of the job is written to `webhook_outbox`
  (`endpoint_id, event, delivery_id, body, attempts, next_attempt_at, created_at`; unique(endpoint_id, delivery_id); index on
  next_attempt_at; FK cascade on endpoint delete). `body` is the exact signed text, so the delivery id and body never change.
- A retryable receiver failure (network, timeout, 408, 429, 5xx) in the handler parks only that endpoint's delivery in the outbox
  (attempts + 1), so healthy receivers are not re-sent. A 4xx is final (job ends `DontRetry`, shown in the Jobs tab). The job config
  `retries: 3` still covers crashes (database down).
- Drain: `drainWebhookOutbox` runs at the end of each `event-scheduler` tick (5 min): prune rows older than 24 h or with 8 tries, read
  up to 200 due rows oldest first, group them into items (one per delivery), send at most 8 jobs. Rows are LEASED first
  (attempts + 1, next try after 1, 2, 4 ... min up to 4 h) so overlapping ticks skip them; the job deletes rows it delivered. A
  rate-limited send stops the sweep and returns the lease without using up a try. Job keys: `wh-<first delivery id>` (emit),
  `wr-<first delivery id>-<attempt>` (drain).
- Migration: `prisma/migrations/20261101150000_webhook_outbox`.
- The portal screen's CSV export link is a placeholder (`EXPORT_CSV_HREF`).
- Stripe status (source `IntegrationsTab`) is not ported: payments are the template's built-in (`payments.md`).

## Schema gaps (no change made, prisma/* untouched)
`webhook_endpoints` has only id, url, secret, events, active. Missing vs the source: a name/label, `created_at`,
and last delivery status/time (and any delivery log table). The UI therefore shows host + secret hint only, and
failure history lives in the platform's Jobs tab. If wanted: add `name text`, `created_at timestamptz default now()`,
`last_status int`, `last_delivery_at timestamptz`. The secret is stored in clear (needed to sign); same as the source.
