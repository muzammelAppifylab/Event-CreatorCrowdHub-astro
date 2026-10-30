import type {Context} from 'hono';

import type {PrismaClient} from '../generated/prisma/client';
import {dispatchWebhook, type WebhookEventName} from './webhooks';

/**
 * Call sites for outbound webhooks. Payloads are ids and non-PII fields only (as the source app's
 * `onRsvpChanged` defines them): no name, email, token or secret. Call AFTER the DB commit.
 */
type Db = Pick<PrismaClient, 'webhookEndpoint'>;

export const rsvpPayload = (r: {id: string; eventId: string; status: string; response?: string | null}) => ({
  eventId: r.eventId,
  rsvpId: r.id,
  status: r.status,
  response: r.response ?? null,
});

export const checkedInPayload = (r: {id: string; eventId: string; checkedInAt: Date | string | null}) => ({
  eventId: r.eventId,
  rsvpId: r.id,
  checkedInAt: r.checkedInAt instanceof Date ? r.checkedInAt.toISOString() : r.checkedInAt,
});

export const pollClosedPayload = (p: {id: string; eventId: string}) => ({eventId: p.eventId, pollId: p.id});

export const orderPaidPayload = (r: {id: string; eventId: string}) => ({eventId: r.eventId, rsvpId: r.id});

/**
 * Fire and forget: runs after the answer (`waitUntil`) when there is a request context, otherwise
 * the promise just runs on. `dispatchWebhook` never throws; the catch is belt and braces.
 */
export function emitWebhook(c: Context | null, db: Db, event: WebhookEventName, payload: unknown): void {
  const work = dispatchWebhook(db, event, payload, c ? {requestUrl: c.req.url} : {}).catch(() => 0);
  try {
    c?.executionCtx.waitUntil(work);
  } catch {
    // No execution context (tests, in-process calls): it simply runs on.
  }
}

/** Waitlist guests promoted to a seat by a cancellation or edit: reported as `rsvp.updated`. */
export function emitPromoted(c: Context | null, db: Db, promoted: {rsvp: Parameters<typeof rsvpPayload>[0]}[]): void {
  for (const p of promoted) emitWebhook(c, db, 'rsvp.updated', rsvpPayload(p.rsvp));
}
