import type {PrismaClient} from '../generated/prisma/client';
import {JobRejected, sendJob} from '../platform/background';
import {siteBase} from './jobs/shared';
import {envelope, isWebhookEvent, WEBHOOK_EVENTS, WEBHOOK_LIST, type WebhookEventName} from './webhook-delivery';
import {
  DRAIN_BATCH_ROWS,
  DRAIN_MAX_JOBS,
  MAX_BODY,
  OUTBOX_MAX_AGE_MS,
  OUTBOX_MAX_ATTEMPTS,
  outboxBackoffMs,
  packItems,
  parkRows,
  rowsOf,
  type WebhookItem,
} from './webhook-outbox';

export {WEBHOOK_EVENTS, type WebhookEventName};

/** Max endpoints per site (each event is delivered to every matching endpoint, from ONE job). */
export const MAX_ENDPOINTS = 10;

type Db = Pick<PrismaClient, 'webhookEndpoint' | 'webhookOutbox'>;
type Send = typeof sendJob;

/** The events an endpoint stored (a Json column) as a clean list. */
export const eventsOf = (value: unknown): WebhookEventName[] => (Array.isArray(value) ? value.filter(isWebhookEvent) : []);

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * Queues signed deliveries for many events at once: ONE job per ~28 KB of events (usually one job),
 * each event carrying every endpoint subscribed to it; the handler fans out. The platform allows only
 * about 10 job sends a minute, so a bulk action must not send per event or per endpoint. When a
 * send is refused (rate limit or otherwise) the deliveries are parked in the outbox and the
 * scheduler tick sends them: nothing is dropped. Never throws: a dead receiver or a refused job must
 * not break an RSVP. Returns how many events had a receiver. Call AFTER the state change, never inside
 * a transaction. Payloads: ids and the fields a Zap needs, not whole records.
 */
export async function dispatchWebhooks(
  db: Db,
  events: {event: WebhookEventName; payload: unknown}[],
  options: {requestUrl?: string; send?: Send} = {},
): Promise<number> {
  try {
    if (events.length === 0) return 0;
    const endpoints = await db.webhookEndpoint.findMany({where: {active: true}, select: {id: true, events: true}, take: 100});
    const items: WebhookItem[] = [];
    for (const {event, payload} of events) {
      const endpointIds = endpoints.filter(e => eventsOf(e.events).includes(event)).map(e => e.id);
      if (endpointIds.length === 0) continue;
      const {id, body} = envelope(event, payload);
      if (body.length > MAX_BODY) {
        console.error(`[webhooks] ${event} payload too large, skipped`);
        continue;
      }
      items.push({id, event, body, endpointIds});
    }
    const send = options.send ?? sendJob;
    const url = options.requestUrl ?? siteBase();
    for (const chunk of packItems(items)) {
      try {
        const label = chunk.length === 1 ? `Webhook · ${chunk[0].event}` : `Webhooks · ${chunk.length} events`;
        await send(url, WEBHOOK_LIST, {items: chunk}, {key: `wh-${chunk[0].id}`, label});
      } catch (error) {
        // Rate limited or refused: keep every delivery of this chunk for the scheduler tick.
        console.error(`[webhooks] job refused, kept in the outbox: ${reason(error)}`);
        try {
          await parkRows(db, rowsOf(chunk), 0);
        } catch (parkError) {
          console.error(`[webhooks] outbox write failed, ${chunk.length} events lost: ${reason(parkError)}`);
        }
      }
    }
    return items.length;
  } catch (error) {
    console.error(`[webhooks] dispatch failed: ${reason(error)}`.slice(0, 300));
    return 0;
  }
}

/** One event: `dispatchWebhooks` with a single entry. */
export const dispatchWebhook = (db: Db, event: WebhookEventName, payload: unknown, options: {requestUrl?: string; send?: Send} = {}): Promise<number> =>
  dispatchWebhooks(db, [{event, payload}], options);

export interface OutboxRun {
  /** Jobs sent. */
  sent: number;
  /** Rows given up on (too old or too many tries). */
  dropped: number;
  /** Rows still waiting after this tick. */
  waiting: boolean;
}

/**
 * Drains the outbox, called by the `event-scheduler` tick: prunes rows past 24 h or 8 tries, then
 * sends at most `maxJobs` jobs (oldest first, rows of one delivery share an item). Each row is
 * LEASED first (attempts + 1, next try after the backoff), so an overlapping tick skips it and a
 * lost job is simply retried; the job handler deletes the rows it delivered. A refused send stops
 * the sweep; a rate limit does not use up the rows' tries. Never throws.
 */
export async function drainWebhookOutbox(
  db: Pick<PrismaClient, 'webhookOutbox'>,
  now: Date = new Date(),
  options: {send?: Send; maxJobs?: number; requestUrl?: string} = {},
): Promise<OutboxRun> {
  const run: OutboxRun = {sent: 0, dropped: 0, waiting: false};
  if (!db.webhookOutbox) return run;
  try {
    const stale = await db.webhookOutbox.deleteMany({
      where: {OR: [{createdAt: {lt: new Date(now.getTime() - OUTBOX_MAX_AGE_MS)}}, {attempts: {gte: OUTBOX_MAX_ATTEMPTS}}]},
    });
    run.dropped = stale.count;
    const rows = await db.webhookOutbox.findMany({
      where: {nextAttemptAt: {lte: now}},
      orderBy: [{nextAttemptAt: 'asc'}, {id: 'asc'}],
      take: DRAIN_BATCH_ROWS,
      select: {id: true, endpointId: true, event: true, deliveryId: true, body: true, attempts: true},
    });
    if (rows.length === 0) return run;

    // One item per (delivery, tries so far): all endpoints still owed that delivery.
    const groups = new Map<string, {item: WebhookItem; rowIds: string[]}>();
    for (const r of rows) {
      const key = `${r.deliveryId}|${r.attempts}`;
      const g = groups.get(key) ?? {item: {id: r.deliveryId, event: r.event, body: r.body, endpointIds: [], attempt: r.attempts + 1}, rowIds: []};
      g.item.endpointIds.push(r.endpointId);
      g.rowIds.push(r.id);
      groups.set(key, g);
    }
    const byItem = new Map<WebhookItem, string[]>([...groups.values()].map(g => [g.item, g.rowIds]));
    const jobs = packItems([...byItem.keys()]);
    const send = options.send ?? sendJob;
    const url = options.requestUrl ?? siteBase();
    for (const chunk of jobs.slice(0, options.maxJobs ?? DRAIN_MAX_JOBS)) {
      // One write per distinct try count in the chunk (usually one), not one per event.
      const byMade = new Map<number, string[]>();
      for (const item of chunk) {
        const made = (item.attempt ?? 1) - 1;
        byMade.set(made, [...(byMade.get(made) ?? []), ...(byItem.get(item) ?? [])]);
      }
      const leased = async (undo: boolean) => {
        for (const [made, ids] of byMade) {
          await db.webhookOutbox.updateMany({
            where: {id: {in: ids}},
            data: undo ? {attempts: made, nextAttemptAt: now} : {attempts: made + 1, nextAttemptAt: new Date(now.getTime() + outboxBackoffMs(made + 1))},
          });
        }
      };
      await leased(false);
      try {
        const label = `Webhooks retry · ${chunk.length} event${chunk.length === 1 ? '' : 's'}`;
        await send(url, WEBHOOK_LIST, {items: chunk}, {key: `wr-${chunk[0].id}-${chunk[0].attempt}`, label});
        run.sent++;
      } catch (error) {
        const limited = error instanceof JobRejected && error.code === 'E_JOBS_RATE_LIMITED';
        if (limited) await leased(true); // the platform's limit is not the receiver's fault
        console.error(`[webhooks] outbox send stopped: ${reason(error)}`);
        run.waiting = true;
        return run;
      }
    }
    run.waiting = jobs.length > (options.maxJobs ?? DRAIN_MAX_JOBS) || rows.length >= DRAIN_BATCH_ROWS;
    return run;
  } catch (error) {
    console.error(`[webhooks] outbox drain failed: ${reason(error)}`.slice(0, 300));
    return run;
  }
}
