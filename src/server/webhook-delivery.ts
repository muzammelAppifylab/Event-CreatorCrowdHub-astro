import type {PrismaClient} from '../generated/prisma/client';
import {DontRetry} from '../platform/background';
import {getDb} from '../platform/db';
import {type BatchJobData, OUTBOX_MAX_ATTEMPTS, type ParkRow, parkRows, type WebhookItem} from './webhook-outbox';

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
export const SIGNATURE_V2_HEADER = 'X-Ezy-Signature-V2';
export const TIMESTAMP_HEADER = 'X-Ezy-Timestamp';
/** Receivers should refuse a delivery whose timestamp is further than this from their clock. */
export const TIMESTAMP_TOLERANCE_SEC = 300;
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

/** `v2=<hex HMAC-SHA256(secret, "<unix seconds>.<exact body>")>`: binds the signature to its timestamp (replay protection). */
export async function signBodyV2(secret: string, timestamp: number | string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return `v2=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)))}`;
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Constant-time check of a signature header (what a receiver, or a test, runs). */
export async function verifySignature(secret: string, body: string, header: string | null | undefined): Promise<boolean> {
  if (!header) return false;
  return sameText(await signBody(secret, body), header);
}

/**
 * What a receiver runs for the replay-protected scheme: the timestamp must be within the tolerance of
 * `nowSec`, and the V2 signature must match (constant time). Dedupe on `X-Ezy-Delivery` as well.
 */
export async function verifySignatureV2(
  secret: string,
  body: string,
  timestamp: string | null | undefined,
  header: string | null | undefined,
  options: {nowSec?: number; toleranceSec?: number} = {},
): Promise<boolean> {
  if (!header || !timestamp || !/^[0-9]{1,12}$/.test(timestamp)) return false;
  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > (options.toleranceSec ?? TIMESTAMP_TOLERANCE_SEC)) return false;
  return sameText(await signBodyV2(secret, timestamp, body), header);
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
  options: {fetch?: Fetcher; timeoutMs?: number; nowMs?: () => number} = {},
): Promise<AttemptResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const bad = webhookUrlProblem(endpoint.url);
  if (bad) return {ok: false, status: null, error: bad, retryable: false, durationMs: elapsed()};
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    // Set per attempt (a retry is signed fresh), so a receiver's freshness window holds for retries.
    const timestamp = Math.floor((options.nowMs ?? Date.now)() / 1000);
    const res = await (options.fetch ?? fetch)(endpoint.url, {
      method: 'POST',
      redirect: 'manual',
      signal,
      body,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'EzyEvents-Webhooks/1',
        [SIGNATURE_HEADER]: await signBody(endpoint.secret, body),
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_V2_HEADER]: await signBodyV2(endpoint.secret, timestamp, body),
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

/** The single-delivery job shape (still handled: jobs queued before batching may be waiting). */
export type DeliveryJobData = {endpointId: string; event: string; deliveryId: string; body: string};

type HandlerDb = Pick<PrismaClient, 'webhookEndpoint' | 'webhookOutbox'>;
type HandlerDeps = {db?: HandlerDb | null; fetch?: Fetcher; timeoutMs?: number; nowMs?: () => number; budgetMs?: number};

/** Stop starting new deliveries after this (a run may take 60 s); the rest go back to the outbox. */
export const BATCH_BUDGET_MS = 45_000;

const isItem = (x: unknown): x is WebhookItem => {
  const i = x as WebhookItem;
  return !!i && typeof i.id === 'string' && typeof i.event === 'string' && typeof i.body === 'string' && Array.isArray(i.endpointIds) && i.endpointIds.every(e => typeof e === 'string');
};

/**
 * The batch job: many events, each fanned out to its endpoints, every endpoint with its own
 * timeout and result. A receiver that answered with a retryable failure does NOT make the job
 * repeat everyone else's deliveries: that pair goes to the outbox (exponential backoff, same
 * delivery id), and the scheduler tick sends it again. A refused (4xx) delivery is final and is
 * reported by failing the job once the rest is done. Rows of the outbox that were delivered are deleted.
 */
async function deliverBatch(items: unknown[], db: HandlerDb, deps: HandlerDeps): Promise<void> {
  if (items.length === 0 || !items.every(isItem)) throw new DontRetry('The webhook job is malformed.');
  const ids = [...new Set(items.flatMap(i => i.endpointIds))];
  const rows = await db.webhookEndpoint.findMany({where: {id: {in: ids}}, select: {id: true, url: true, secret: true, active: true}, take: 100});
  const endpoints = new Map(rows.map(r => [r.id, r]));
  const deadline = Date.now() + (deps.budgetMs ?? BATCH_BUDGET_MS);
  const now = new Date();
  const retry = new Map<number, ParkRow[]>(); // attempts made so far -> rows to try again
  const done: {deliveryId: string; endpointId: string}[] = [];
  const refused = new Set<string>();
  let dropped = 0;
  const park = (attempts: number, row: ParkRow) => retry.set(attempts, [...(retry.get(attempts) ?? []), row]);

  for (const item of items) {
    const made = Math.max(0, Math.floor(item.attempt ?? 0));
    const late = Date.now() >= deadline;
    await Promise.all(
      item.endpointIds.map(async endpointId => {
        const row = {endpointId, event: item.event, deliveryId: item.id, body: item.body};
        const endpoint = endpoints.get(endpointId);
        if (!endpoint || !endpoint.active) return void done.push({deliveryId: item.id, endpointId}); // deleted or paused since it was queued
        if (late) return park(made, row); // out of time, not tried: no attempt used
        const result = await attemptDelivery(endpoint, item.event, item.id, item.body, deps);
        if (result.ok) done.push({deliveryId: item.id, endpointId});
        else if (result.retryable) park(made + 1, row);
        else {
          done.push({deliveryId: item.id, endpointId});
          refused.add(result.error ?? 'The receiver did not accept the delivery.');
        }
      }),
    );
  }

  for (const [attempts, list] of retry) dropped += await parkRows(db, list, attempts, now);
  // Rows the outbox sent us: delivered (or final) ones are removed; failed ones keep their leased time.
  for (const d of done) {
    const item = items.find(i => i.id === d.deliveryId);
    if (item && (item.attempt ?? 0) > 0) await db.webhookOutbox.deleteMany({where: {endpointId: d.endpointId, deliveryId: d.deliveryId}});
  }
  if (dropped > 0) console.error(`[webhooks] gave up on ${dropped} deliveries after ${OUTBOX_MAX_ATTEMPTS} tries`);
  if (refused.size > 0) throw new DontRetry([...refused].slice(0, 3).join('; ').slice(0, 300));
}

/**
 * Handler of the `webhook-deliveries` list. Register in `src/server/background.ts`:
 *   `'webhook-deliveries': (data, job) => deliverWebhookJob(data, job),`
 * Safe to run twice: the delivery id is the same on every try, so receivers dedupe.
 */
export async function deliverWebhookJob(data: DeliveryJobData | BatchJobData, _job?: unknown, deps: Omit<HandlerDeps, 'db'> & {db?: Partial<HandlerDb> | null} = {}): Promise<void> {
  const batch = (data as BatchJobData | undefined)?.items;
  const legacy = data as DeliveryJobData | undefined;
  if (!Array.isArray(batch) && (!legacy || typeof legacy.endpointId !== 'string' || typeof legacy.body !== 'string')) throw new DontRetry('The webhook job is malformed.');
  const db = (deps.db === undefined ? getDb() : deps.db) as HandlerDb | null;
  if (!db) throw new Error('The Site Database is off.');
  if (Array.isArray(batch)) return deliverBatch(batch, db, deps);
  const endpoint = await db.webhookEndpoint.findUnique({where: {id: legacy!.endpointId}, select: {url: true, secret: true, active: true}});
  if (!endpoint || !endpoint.active) return; // deleted or paused since it was queued: nothing to do
  const result = await attemptDelivery(endpoint, legacy!.event, legacy!.deliveryId, legacy!.body, deps);
  if (result.ok) return;
  const message = result.error ?? 'The receiver did not accept the delivery.';
  if (!result.retryable) throw new DontRetry(message);
  throw new Error(message);
}
