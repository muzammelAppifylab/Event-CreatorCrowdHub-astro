import type {PrismaClient} from '../generated/prisma/client';
import {sendJob} from '../platform/background';
import {siteBase} from './jobs/shared';
import {envelope, isWebhookEvent, WEBHOOK_EVENTS, WEBHOOK_LIST, type DeliveryJobData, type WebhookEventName} from './webhook-delivery';

export {WEBHOOK_EVENTS, type WebhookEventName};

/** Max endpoints per site (each event queues one job per matching endpoint). */
export const MAX_ENDPOINTS = 10;
/** A job's data is capped at 32 KB by the platform; stay well inside it. */
const MAX_BODY = 24_000;

type Db = Pick<PrismaClient, 'webhookEndpoint'>;

/** The events an endpoint stored (a Json column) as a clean list. */
export const eventsOf = (value: unknown): WebhookEventName[] => (Array.isArray(value) ? value.filter(isWebhookEvent) : []);

/**
 * Queues a signed delivery to every active endpoint subscribed to `eventType`. Never throws:
 * a dead receiver or a refused job must not break an RSVP. Returns how many deliveries were queued.
 * Call it AFTER the state change, never inside a transaction. Payloads should be small: ids and
 * the fields a Zap needs, not whole records.
 */
export async function dispatchWebhook(db: Db, eventType: WebhookEventName, payload: unknown, options: {requestUrl?: string} = {}): Promise<number> {
  try {
    const endpoints = await db.webhookEndpoint.findMany({where: {active: true}, select: {id: true, events: true}, take: 100});
    const targets = endpoints.filter(e => eventsOf(e.events).includes(eventType));
    let queued = 0;
    for (const endpoint of targets) {
      const {id, body} = envelope(eventType, payload);
      if (body.length > MAX_BODY) {
        console.error(`[webhooks] ${eventType} payload too large, skipped`);
        break;
      }
      const data: DeliveryJobData = {endpointId: endpoint.id, event: eventType, deliveryId: id, body};
      await sendJob(options.requestUrl ?? siteBase(), WEBHOOK_LIST, data, {key: `wh-${id}`, label: `Webhook · ${eventType}`});
      queued++;
    }
    return queued;
  } catch (error) {
    console.error(`[webhooks] dispatch failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    return 0;
  }
}
