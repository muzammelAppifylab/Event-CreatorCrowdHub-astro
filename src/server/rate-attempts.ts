import type {Context} from 'hono';

import {Prisma, type PrismaClient} from '../generated/prisma/client';
import {background, clientIp, rateLimitIp} from '../platform/auth/kit';
import {subjectHash} from '../platform/auth/keys';
import {tableMissing} from '../platform/background';
import {config} from '../platform/config';

/**
 * Abuse limits for PUBLIC routes, in the site's own `rate_attempts` table (shared by every Worker
 * isolate, unlike module memory). The managed limiter's kinds are a closed list (audit L-40), so this
 * follows the `privacy_attempts` / `poll_attempts` pattern, generalised by `kind`:
 *
 *   - every key is a keyed hash (`subjectHash` under JWT_SECRET) of the IP (`rateLimitIp(clientIp(c))`,
 *     never `x-forwarded-for`), the email or the event: no raw email or IP is ever stored;
 *   - ONE statement per request: bounded counts (each stops at its max) for every check, and only when
 *     all are under their max, one row per check is inserted. Two requests at the same instant may
 *     both pass at max - 1 (best effort by design, never a lock on a public route);
 *   - rows older than a day (the longest window) are swept now and then, in bounded batches.
 *
 * No JWT_SECRET (no hash key) or no table yet (a database between this release and its migration):
 * no limit, rather than a broken RSVP form.
 */

export type Limit = {kind: string; windowMs: number; max: number};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RATE_LIMITS = {
  /** RSVP submits and edits from one network. */
  rsvpIp: {kind: 'rsvp_ip', windowMs: MINUTE, max: 10},
  /** "Lost my link" requests from one network. */
  linkIp: {kind: 'link_ip', windowMs: MINUTE, max: 10},
  /** RSVP submits for one event, from everyone: a flood of fake guests stops here (a real launch is well below). */
  rsvpEvent: {kind: 'rsvp_event', windowMs: 10 * MINUTE, max: 600},
  /** Guest emails a public route triggers, per (event, address). */
  mailEventEmail: {kind: 'mail_event_email', windowMs: HOUR, max: 3},
  /** The same, per address across every event: nobody's inbox is bombed through many events. */
  mailEmail: {kind: 'mail_email', windowMs: 24 * HOUR, max: 10},
  /** Page-view beacons per network and per event. */
  beaconIp: {kind: 'beacon_ip', windowMs: MINUTE, max: 60},
  beaconEvent: {kind: 'beacon_event', windowMs: MINUTE, max: 500},
} as const satisfies Record<string, Limit>;

export type Check = {limit: Limit; key: string};

/** The network a request counts as (the platform's rule: one IPv6 /56 is one network). */
export const ipKey = (c: Context) => rateLimitIp(clientIp(c));

async function keyHash(secret: string, check: Check): Promise<string> {
  return subjectHash(secret, 'email', `rate:${check.limit.kind}:${check.key.slice(0, 600)}`);
}

export type AttemptResult = {allowed: boolean; over: Limit | null};

const ALLOWED: AttemptResult = {allowed: true, over: null};

/**
 * Counts `checks` and, when every one is under its max, records one attempt for each, in ONE
 * statement. `over` is the first limit that refused (for the 429's wording and Retry-After).
 */
export async function takeAttempt(db: PrismaClient, checks: readonly Check[], now = new Date()): Promise<AttemptResult> {
  const secret = config.jwtSecret;
  if (!secret || checks.length === 0) return ALLOWED;
  const hashes = await Promise.all(checks.map(check => keyHash(secret, check)));
  const counts = checks.map(
    ({limit}, i) => Prisma.sql`(SELECT count(*)::int FROM (SELECT 1 FROM rate_attempts
      WHERE kind = ${limit.kind} AND key_hash = ${hashes[i]!} AND created_at > ${new Date(now.getTime() - limit.windowMs)}
      LIMIT ${limit.max}::int) s)`
  );
  const under = checks.map(({limit}, i) => Prisma.sql`counts.n[${i + 1}::int] < ${limit.max}::int`);
  const values = checks.map(({limit}, i) => Prisma.sql`(${limit.kind}::varchar, ${hashes[i]!}::char(64))`);
  try {
    const rows = await db.$queryRaw<{n: number[]}[]>`
      WITH counts AS (SELECT ARRAY[${Prisma.join(counts)}]::int[] AS n),
      ins AS (
        INSERT INTO rate_attempts (kind, key_hash, created_at)
        SELECT v.kind, v.key_hash, ${now} FROM (VALUES ${Prisma.join(values)}) AS v(kind, key_hash), counts
        WHERE ${Prisma.join(under, ' AND ')}
        RETURNING 1
      )
      SELECT n FROM counts`;
    const n = rows[0]?.n ?? [];
    const index = checks.findIndex(({limit}, i) => Number(n[i] ?? 0) >= limit.max);
    return index === -1 ? ALLOWED : {allowed: false, over: checks[index]!.limit};
  } catch (error) {
    if (tableMissing(error)) return ALLOWED;
    throw error;
  }
}

/** Now and then (1 in 50 calls), after the answer: drops up to 500 rows older than a day. */
export function sweepAttempts(c: Context, db: PrismaClient, now = Date.now()) {
  if (Math.random() >= 0.02) return;
  const before = new Date(now - 24 * HOUR);
  background(
    c,
    db.$executeRaw`DELETE FROM rate_attempts WHERE id IN (SELECT id FROM rate_attempts WHERE created_at < ${before} ORDER BY created_at LIMIT 500)`.catch(
      (error: unknown) => {
        if (!tableMissing(error)) throw error;
      }
    )
  );
}

/** Request-level limits: the 429 to answer (with Retry-After), or null to go on. */
export async function limitRequest(c: Context, db: PrismaClient, checks: readonly Check[], message: string): Promise<Response | null> {
  const result = await takeAttempt(db, checks);
  sweepAttempts(c, db);
  if (result.allowed) return null;
  c.header('Retry-After', String(Math.ceil(result.over!.windowMs / 1000)));
  return c.json({error: 'rate_limited', message}, 429);
}

/**
 * May a PUBLIC route send one more guest email to `email` about `eventId`? Counts (and records)
 * against both the per-(event, address) and the per-address cap. Call it right before EVERY guest email
 * a public route triggers (confirmation, consent, manage link); false = skip the email quietly.
 */
export async function guestMailAllowed(db: PrismaClient, eventId: string, email: string): Promise<boolean> {
  const address = email.trim().toLowerCase();
  const result = await takeAttempt(db, [
    {limit: RATE_LIMITS.mailEventEmail, key: `${eventId}:${address}`},
    {limit: RATE_LIMITS.mailEmail, key: address},
  ]);
  return result.allowed;
}
