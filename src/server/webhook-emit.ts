import type {Context} from 'hono';

import type {PrismaClient} from '../generated/prisma/client';
import {dispatchWebhook, dispatchWebhooks, type WebhookEventName} from './webhooks';

/**
 * Call sites for outbound webhooks. Payloads are ids and non-PII fields only (as the source app's
 * `onRsvpChanged` defines them): no name, email, token or secret. Call AFTER the DB commit.
 */
type Db = Pick<PrismaClient, 'webhookEndpoint' | 'webhookOutbox'>;

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
 * With a request context the work runs after the answer (`waitUntil`) and the caller need not wait.
 * WITHOUT one (a background job, a payment hook) nothing keeps the Worker alive for it: the caller
 * MUST `await` the returned promise, or the send is cut off when the handler returns (L-19).
 * The promise never rejects (`dispatchWebhooks` never throws; the catch is belt and braces).
 * ONE call = ONE job (platform job sends are rate limited): code that emits in a loop collects the
 * events and calls `emitWebhooks` once.
 */
export function emitWebhooks(c: Context | null, db: Db, events: {event: WebhookEventName; payload: unknown}[]): Promise<void> {
  if (events.length === 0) return Promise.resolve();
  const options = c ? {requestUrl: c.req.url} : {};
  const work = (events.length === 1 ? dispatchWebhook(db, events[0].event, events[0].payload, options) : dispatchWebhooks(db, events, options)).then(
    () => undefined,
    () => undefined
  );
  if (c) {
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      // No execution context (in-process calls): the caller's await is what keeps it.
    }
  }
  return work;
}

export function emitWebhook(c: Context | null, db: Db, event: WebhookEventName, payload: unknown): Promise<void> {
  return emitWebhooks(c, db, [{event, payload}]);
}

/** Waitlist guests promoted to a seat by a cancellation or edit: reported as `rsvp.updated`. */
export function emitPromoted(c: Context | null, db: Db, promoted: {rsvp: Parameters<typeof rsvpPayload>[0]; claim?: boolean}[]): Promise<void> {
  // A paid-event claim offer changes no status (the guest stays waitlisted): nothing to report yet.
  return emitWebhooks(c, db, promoted.filter(p => !p.claim).map(p => ({event: 'rsvp.updated' as const, payload: rsvpPayload(p.rsvp)})));
}

/** Most webhooks one background step may queue (a lapse or release can touch a long waitlist). */
export const JOB_EMIT_CAP = 100;

/** Background paths (scheduler, payment hooks): guests the code cancelled. `await` it: no request context. */
export function emitCancelledIds(db: Db, eventId: string, rsvpIds: string[]): Promise<void> {
  return emitWebhooks(null, db, rsvpIds.slice(0, JOB_EMIT_CAP).map(id => ({event: 'rsvp.cancelled' as const, payload: rsvpPayload({id, eventId, status: 'cancelled', response: 'going'})})));
}

/** Background paths: waitlist guests the code seated (`confirm`); claim offers change no status. `await` it. */
export function emitSeated(db: Db, eventId: string, promotions: {rsvpId: string; kind: string}[]): Promise<void> {
  const seated = promotions.filter(x => x.kind === 'confirm').slice(0, JOB_EMIT_CAP);
  return emitWebhooks(null, db, seated.map(p => ({event: 'rsvp.updated' as const, payload: rsvpPayload({id: p.rsvpId, eventId, status: 'confirmed', response: 'going'})})));
}
