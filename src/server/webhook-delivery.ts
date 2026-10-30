import type {PrismaClient} from '../generated/prisma/client';
import {DontRetry} from '../platform/background';
import {getDb} from '../platform/db';

/**
 * Outbound webhook delivery (ported from CreatorCrowdHub `webhooks/dispatch.ts`).
 *
 * Pure pieces (signing, URL validation, one attempt) plus `deliverWebhookJob`, the handler of the
 * `webhook-deliveries` background list. The platform retries (1 min, 2 min, 10 min, 1 h): the
 * handler returns when done, throws to try again, throws `DontRetry` when trying again cannot help.
 * No `node:crypto`: signing uses WebCrypto.
 */

export const WEBHOOK_LIST = 'webhook-deliveries';
export const SIGNATURE_HEADER = 'X-Ezy-Signature';
export const EVENT_HEADER = 'X-Ezy-Event';
export const DELIVERY_HEADER = 'X-Ezy-Delivery';
export const TIMEOUT_MS = 5_000;
export const MAX_URL_LENGTH = 500;

export const WEBHOOK_EVENTS = [
  'rsvp.created',
  'rsvp.updated',
  'rsvp.cancelled',
  'order.paid',
  'guest.checked_in',
  'poll.closed',
  'rsvp.removed',
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];
export const isWebhookEvent = (value: unknown): value is WebhookEventName => WEBHOOK_EVENTS.includes(value as WebhookEventName);

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

/** `sha256=<hex HMAC-SHA256(secret, exact body bytes)>`: what receivers recompute. */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))}`;
}

/** Constant-time check of a signature header (what a receiver, or a test, runs). */
export async function verifySignature(secret: string, body: string, header: string | null | undefined): Promise<boolean> {
  if (!header) return false;
  const expected = await signBody(secret, body);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

/** A fresh secret, shown to the creator once: `whsec_` + 32 random bytes in hex. */
export function newSecret(): string {
  return `whsec_${hex(crypto.getRandomValues(new Uint8Array(32)).buffer)}`;
}

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.private', '.test', '.example', '.invalid', '.arpa'];

/**
 * Why a receiver URL is not allowed, or `null` when it is fine. https only, no credentials, no IP
 * addresses (any notation), no single-label or private-looking names. The platform blocks egress to
 * its internal network too; this keeps bad URLs from being saved at all.
 */
export function webhookUrlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Enter the receiver URL.';
  if (raw.length > MAX_URL_LENGTH) return `Keep the URL under ${MAX_URL_LENGTH} characters.`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a full URL such as https://hooks.zapier.com/…';
  }
  if (url.protocol !== 'https:') return 'The URL must start with https://';
  if (url.username || url.password) return 'The URL must not contain a username or password.';
  if (url.port && url.port !== '443') return 'Use the standard HTTPS port.';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || host.includes(':')) return 'Use a domain name, not an IP address.';
  // `new URL` normalises 0x7f.1, 2130706433 and 127.1 to dotted quads; an all-numeric host is an IP.
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return 'Use a domain name, not an IP address.';
  if (!host.includes('.')) return 'Use a public domain name.';
  if (host === 'localhost' || PRIVATE_SUFFIXES.some(s => host.endsWith(s))) return 'Use a public domain name.';
  if (!/^[a-z0-9.-]+$/.test(host) && !host.includes('xn--')) return 'Use a public domain name.';
  return null;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface AttemptResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  /** Worth another try: network error, timeout, 408, 429 or 5xx. */
  retryable: boolean;
  durationMs: number;
}

/** The JSON body of a delivery. */
export function envelope(event: string, data: unknown, id: string = crypto.randomUUID(), now: Date = new Date()): {id: string; body: string} {
  return {id, body: JSON.stringify({id, event, createdAt: now.toISOString(), data})};
}

/** One signed POST. Never throws, never follows redirects (a 3xx could bounce the signed payload elsewhere). */
export async function attemptDelivery(
  endpoint: {url: string; secret: string},
  event: string,
  deliveryId: string,
  body: string,
  options: {fetch?: Fetcher; timeoutMs?: number} = {},
): Promise<AttemptResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const bad = webhookUrlProblem(endpoint.url);
  if (bad) return {ok: false, status: null, error: bad, retryable: false, durationMs: elapsed()};
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await (options.fetch ?? fetch)(endpoint.url, {
      method: 'POST',
      redirect: 'manual',
      signal,
      body,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'EzyEvents-Webhooks/1',
        [SIGNATURE_HEADER]: await signBody(endpoint.secret, body),
        [EVENT_HEADER]: event,
        [DELIVERY_HEADER]: deliveryId,
      },
    });
    await res.body?.cancel().catch(() => {});
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      status: res.status,
      error: ok ? null : `Receiver answered ${res.status}`,
      retryable: !ok && (res.status === 408 || res.status === 429 || res.status >= 500),
      durationMs: elapsed(),
    };
  } catch {
    // The error text is not kept: it can carry the URL, and Zapier/Make URLs hold a secret in the path.
    return {
      ok: false,
      status: null,
      error: signal.aborted ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : "Couldn't connect to the receiver",
      retryable: true,
      durationMs: elapsed(),
    };
  }
}

export type DeliveryJobData = {endpointId: string; event: string; deliveryId: string; body: string};

/**
 * Handler of the `webhook-deliveries` list. Register in `src/server/background.ts`:
 *   `'webhook-deliveries': (data, job) => deliverWebhookJob(data, job),`
 * Safe to run twice: the delivery id is the same on every try, so receivers dedupe.
 */
export async function deliverWebhookJob(
  data: DeliveryJobData,
  _job?: unknown,
  deps: {db?: Pick<PrismaClient, 'webhookEndpoint'> | null; fetch?: Fetcher; timeoutMs?: number} = {},
): Promise<void> {
  if (!data || typeof data.endpointId !== 'string' || typeof data.body !== 'string') throw new DontRetry('The webhook job is malformed.');
  const db = deps.db === undefined ? getDb() : deps.db;
  if (!db) throw new Error('The Site Database is off.');
  const endpoint = await db.webhookEndpoint.findUnique({where: {id: data.endpointId}, select: {url: true, secret: true, active: true}});
  if (!endpoint || !endpoint.active) return; // deleted or paused since it was queued: nothing to do
  const result = await attemptDelivery(endpoint, data.event, data.deliveryId, data.body, deps);
  if (result.ok) return;
  const message = result.error ?? 'The receiver did not accept the delivery.';
  if (!result.retryable) throw new DontRetry(message);
  throw new Error(message);
}
