import type {PrismaClient} from '../generated/prisma/client';

/**
 * The webhook outbox: deliveries that must not be lost when the platform refuses a job (the
 * default is ~10 job sends a minute, `E_JOBS_RATE_LIMITED`) or a receiver is down. One row per
 * (endpoint, delivery id); `body` is the exact signed bytes, so the delivery id and the body stay
 * the same on every retry (only the timestamp and its signature are fresh). The `event-scheduler`
 * tick drains it (`drainWebhookOutbox` in `webhooks.ts`). Pure helpers only: no platform imports.
 */
export type OutboxDb = Pick<PrismaClient, 'webhookOutbox'>;

/** One emitted event, to deliver to every endpoint in `endpointIds`. `attempt` = tries already made. */
export type WebhookItem = {id: string; event: string; body: string; endpointIds: string[]; attempt?: number};
export type BatchJobData = {items: WebhookItem[]};

export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_MAX_AGE_MS = 24 * 3600_000;
/** Most jobs one scheduler tick may send for the outbox (the platform allows ~10 a minute in all). */
export const DRAIN_MAX_JOBS = 8;
/** Most rows one tick reads. */
export const DRAIN_BATCH_ROWS = 200;
/** A job's data is capped at 32 KB by the platform; stay inside it (escaping grows the body a little). */
export const MAX_JOB_BYTES = 28_000;
/** One event body (ids and non-PII fields are ~300 bytes: this is a ceiling, not a target). */
export const MAX_BODY = 16_000;

/** Wait before try number `attempts + 1`: 1, 2, 4, 8 … minutes, at most 4 hours. */
export const outboxBackoffMs = (attempts: number): number => Math.min(60_000 * 2 ** Math.max(0, attempts), 4 * 3600_000);

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Splits items into job payloads that each fit `maxBytes` (an item bigger than that goes alone). */
export function packItems(items: WebhookItem[], maxBytes = MAX_JOB_BYTES): WebhookItem[][] {
  const jobs: WebhookItem[][] = [];
  let current: WebhookItem[] = [];
  let size = 12; // {"items":[]}
  for (const item of items) {
    const n = bytes(item) + 1;
    if (current.length > 0 && size + n > maxBytes) {
      jobs.push(current);
      current = [];
      size = 12;
    }
    current.push(item);
    size += n;
  }
  if (current.length > 0) jobs.push(current);
  return jobs;
}

export type ParkRow = {endpointId: string; event: string; deliveryId: string; body: string};

/**
 * Persists deliveries for a later try: `attempts` tries already made, so the next one is due after
 * the backoff. Rows past the attempt cap are dropped. An existing row (same endpoint + delivery) is
 * kept as is. Returns how many rows were dropped.
 */
export async function parkRows(db: OutboxDb, rows: ParkRow[], attempts: number, now: Date = new Date()): Promise<number> {
  if (rows.length === 0) return 0;
  if (attempts >= OUTBOX_MAX_ATTEMPTS) return rows.length;
  const nextAttemptAt = new Date(now.getTime() + outboxBackoffMs(attempts));
  for (let i = 0; i < rows.length; i += 200) {
    await db.webhookOutbox.createMany({
      data: rows.slice(i, i + 200).map(r => ({...r, attempts, nextAttemptAt})),
      skipDuplicates: true,
    });
  }
  return 0;
}

/** Items to rows: one per endpoint. */
export const rowsOf = (items: WebhookItem[]): ParkRow[] =>
  items.flatMap(item => item.endpointIds.map(endpointId => ({endpointId, event: item.event, deliveryId: item.id, body: item.body})));
