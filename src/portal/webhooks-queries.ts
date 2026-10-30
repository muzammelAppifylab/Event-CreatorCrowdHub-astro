import {queryOptions} from '@tanstack/react-query';

import {siteFetch} from '../platform/browser';
import {read} from './api';

/**
 * Reads and writes for outbound webhooks (`/site-api/webhook-endpoints`). Kept out of the shell's
 * `queries.ts` and typed by hand, so it works before the route is mounted. Keys: `['webhooks', …]`.
 */

export const WEBHOOK_EVENT_LABELS = {
  'rsvp.created': 'New RSVP',
  'rsvp.updated': 'RSVP changed',
  'rsvp.cancelled': 'RSVP cancelled',
  'order.paid': 'Ticket paid',
  'guest.checked_in': 'Guest checked in',
  'poll.closed': 'Poll closed',
  'rsvp.removed': 'Guest removed',
} as const;
export type WebhookEventName = keyof typeof WEBHOOK_EVENT_LABELS;
export const WEBHOOK_EVENT_NAMES = Object.keys(WEBHOOK_EVENT_LABELS) as WebhookEventName[];

export type WebhookEndpoint = {id: string; url: string; events: WebhookEventName[]; active: boolean; secretHint: string};
export type WebhookTestResult = {ok: boolean; status: number | null; durationMs: number; error: string | null};
export type WebhookInput = {url: string; events: WebhookEventName[]};

const BASE = '/site-api/webhook-endpoints';

const send = <T>(path: string, method: string, body?: unknown) =>
  read<T>(
    siteFetch(`${BASE}${path}`, {
      method,
      ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}),
    })
  );

export const webhooksQuery = queryOptions({
  queryKey: ['webhooks', 'list'],
  queryFn: () => send<{endpoints: WebhookEndpoint[]}>('', 'GET'),
});

export const createWebhook = (input: WebhookInput) => send<{endpoint: WebhookEndpoint; secret: string}>('', 'POST', input);
export const updateWebhook = (id: string, patch: Partial<WebhookInput> & {active?: boolean}) =>
  send<{endpoint: WebhookEndpoint}>(`/${encodeURIComponent(id)}`, 'PATCH', patch);
/** A 204 has no body: `read` tolerates that and only throws on a non-ok status. */
export const deleteWebhook = (id: string) => send<null>(`/${encodeURIComponent(id)}`, 'DELETE');
export const testWebhook = (id: string) => send<WebhookTestResult>(`/${encodeURIComponent(id)}/test`, 'POST');
