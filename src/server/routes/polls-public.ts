import {Hono, type Context} from 'hono';
import {getCookie, setCookie} from 'hono/cookie';

import {
  applyVote,
  canVote,
  largestRemainderPercents,
  type PollResults,
  type PollType,
  RATING_MAX,
  RATING_MIN,
  TEXT_ANSWERS_SHOWN,
  type VoteError,
} from '../../domain/polls';
import {CODE_ALPHABET, POLL_JOIN_CODE_LENGTH} from '../../domain/codes';
import {hashToken} from '../../domain/secureToken';
import {POLL_GUEST_PREFIX, verifyPollGuestToken} from '../../domain/tokens';
import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {background, clientIp, rateLimitIp, tooMany} from '../../platform/auth/kit';
import {hmacKey, subjectHash} from '../../platform/auth/keys';
import {tableMissing} from '../../platform/background';
import {config} from '../../platform/config';
import {problem, withAuthCore, withDb} from '../../platform/guards';
import {isUuid} from '../../lib/text';
import {notFound} from '../validate';

/**
 * Guest polls, public side (ported from CreatorCrowdHub `polls-public.ts`). No sign-in:
 * a voter is a DEVICE, named by a random UUID in an HttpOnly cookie scoped to this route.
 * Nothing here returns voter tokens or anyone else's vote.
 *
 *   GET  /site-api/polls-public/:code/active    the current poll (open, else the last opened) + my vote
 *   POST /site-api/polls-public/:code/votes     cast or change my vote
 *   GET  /site-api/polls-public/:code/results   the current poll's results (if the host shows them)
 *
 * Abuse limits live in the site's OWN table `poll_attempts` (the managed limiter's kinds are fixed,
 * `security.md`), checked with bounded counts (LIMIT N+1, indexed) and NEVER under a lock: a room on
 * one venue Wi-Fi votes in the same second, and a per-IP lock refused most of it (audit M-3). Without
 * a lock a burst can pass a ceiling by at most its own size, which is fine for these generous limits.
 * One answer per device per poll is the unique (poll_id, voter_token) index's job, never a limit's.
 *   per IP, every vote               600 per 10 minutes (the whole room's volume)
 *   per IP, NEW devices              200 per 10 minutes: a vote without a valid signed voter cookie is a
 *                                    fresh ballot (a new phone, or one that dropped or forged its
 *                                    cookie to vote again, audit L-9)
 *   per device (signed cookie)       30 a minute
 *   per IP, join-code lookup MISSES  30 per 10 minutes (code enumeration); hits cost nothing
 * IP and device are stored only as keyed hashes (`subjectHash`). Rows older than a day are swept.
 */

export const VOTER_COOKIE = 'site_voter';
export const VOTER_COOKIE_PATH = '/site-api/polls-public';
const VOTER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

export const POLL_LIMITS = {
  ipVotes: {windowSeconds: 10 * 60, max: 600, retryAfter: 30},
  newDevices: {windowSeconds: 10 * 60, max: 200, retryAfter: 30},
  deviceVotes: {windowSeconds: 60, max: 30, retryAfter: 10},
  lookupMisses: {windowSeconds: 10 * 60, max: 30, retryAfter: 60},
} as const;

/* ── helpers shared with the admin routes ───────────────────────────────── */

export {isUuid};

const UNSAFE_IN_SCRIPT = new RegExp('[<>&' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
/**
 * JSON that is safe inside a <script type="application/json"> block: `<`, `>`, `&` and the JS
 * line separators become unicode escapes (still valid JSON), so no value can close the tag.
 * (The type is non-executable, so the CSP needs no allowance for it.)
 */
export function jsonForScript(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(UNSAFE_IN_SCRIPT, ch => String.fromCharCode(92) + 'u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Codes are typed by guests: accept "k7q 42x" or "K7Q-42X". Null when it can't be a code. */
export function normalizeJoinCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== POLL_JOIN_CODE_LENGTH) return null;
  return [...code].every(ch => CODE_ALPHABET.includes(ch)) ? code : null;
}

/**
 * The schema has no sort column, so ORDER IS CARRIED BY THE ID: a new uuid whose first group
 * is `position` (options: their index; polls: the creation time in seconds). The rest stays
 * random, so ids remain unique and unguessable; `orderBy: {id: 'asc'}` reads them in order.
 */
export function orderedUuid(position: number): string {
  const head = Math.max(0, Math.floor(position)).toString(16).padStart(8, '0').slice(-8);
  return `${head}${crypto.randomUUID().slice(8)}`;
}

export const pollSelect = {
  id: true,
  eventId: true,
  question: true,
  type: true,
  status: true,
  anonymous: true,
  showResultsToVoters: true,
  openedAt: true,
  closedAt: true,
  sortOrder: true,
} as const;

export type PollRow = {
  id: string;
  eventId: string;
  question: string;
  type: PollType;
  status: 'draft' | 'open' | 'closed';
  anonymous: boolean;
  showResultsToVoters: boolean;
  openedAt: Date | null;
  closedAt: Date | null;
  sortOrder?: number;
};

export type ResultsDto = {
  pollId: string;
  type: PollType;
  totalVoters: number;
  options: PollResults['options'];
  rating: {average: number | null; count: number; distribution: {value: number; count: number}[]} | null;
  textAnswers: {text: string; at: string}[];
};

export function toResultsDto(r: PollResults): ResultsDto {
  return {
    pollId: r.pollId,
    type: r.type,
    totalVoters: r.totalVoters,
    options: r.options,
    rating: r.rating
      ? {
          average: r.rating.average,
          count: r.rating.count,
          distribution: Object.entries(r.rating.distribution).map(([value, count]) => ({value: Number(value), count})),
        }
      : null,
    textAnswers: r.textAnswers.map(t => ({text: t.text, at: t.at.toISOString()})),
  };
}

/** Options of the given polls in order (`orderedUuid`), with their position as `sortOrder`. */
export async function optionsOf(db: PrismaClient, pollIds: string[]) {
  if (pollIds.length === 0) return [];
  const rows = await db.pollOption.findMany({
    where: {pollId: {in: pollIds}},
    select: {id: true, pollId: true, label: true, sortOrder: true},
    orderBy: [{sortOrder: 'asc'}, {id: 'asc'}],
  });
  return rows.map(o => ({...o}));
}

/** The current poll for guests: the open one, else the most recently opened (closed) one. */
export async function currentPollOf(db: PrismaClient, eventId: string): Promise<PollRow | null> {
  const open = await db.poll.findFirst({where: {eventId, status: 'open'}, select: pollSelect});
  if (open) return open as PollRow;
  const last = await db.poll.findFirst({
    where: {eventId, status: 'closed', openedAt: {not: null}},
    orderBy: {openedAt: 'desc'},
    select: pollSelect,
  });
  return last as PollRow | null;
}

/* ── results: counted by the database, cached per isolate for a moment ── */

/** Which polls one aggregate covers. Fixed SQL fragments only: never built from input. */
export type PollScope = {pollIds: string[]} | {eventId: string} | {joinCode: string};

/** One aggregate row: `o` an option's voters, `v` a choice poll's voters, `r` a rating's count, `tn` a text poll's answers, `t` one recent text. */
export type AggRow = {kind: 'o' | 'v' | 'r' | 'tn' | 't'; poll_id: string; key: string | null; n: number | bigint; text: string | null; at: Date | string | null};

/** Postgres regex for what JS `String.prototype.trim()` strips at both ends (btrim strips only spaces). */
const WS = String.raw`[\s   -     　﻿]`;
const JS_TRIM = `^${WS}+|${WS}+$`;

function scopeSql(scope: PollScope): Prisma.Sql {
  if ('pollIds' in scope) return Prisma.sql`v.poll_id = ANY(${scope.pollIds}::uuid[])`;
  if ('eventId' in scope) return Prisma.sql`v.poll_id IN (SELECT p.id FROM polls p WHERE p.event_id = ${scope.eventId}::uuid)`;
  return Prisma.sql`v.poll_id IN (SELECT p.id FROM polls p JOIN events e ON e.id = p.event_id WHERE e.poll_join_code = ${scope.joinCode} AND e.deleted_at IS NULL)`;
}

/**
 * Every count the results show, for every poll in `scope`, in ONE statement: the database groups
 * the votes (through the unique (poll_id, voter_token) index) and sends back a few rows per poll,
 * never the votes themselves. Same rules as `aggregateResults` (domain/polls.ts): unknown options
 * and empty answers don't count, a choice voter counts once, the 20 newest text answers.
 */
export async function aggregateRows(db: PrismaClient, scope: PollScope): Promise<AggRow[]> {
  if ('pollIds' in scope && scope.pollIds.length === 0) return [];
  return db.$queryRaw<AggRow[]>`
    WITH v AS (
      SELECT v.id, v.poll_id, v.voter_token, v.option_ids, v.rating_value, regexp_replace(v.text_value, ${JS_TRIM}, '', 'g') AS text_value, v.updated_at, p.type::text AS type
      FROM poll_votes v JOIN polls p ON p.id = v.poll_id
      WHERE ${scopeSql(scope)}
    ), known AS (
      SELECT v.poll_id, v.voter_token, v.type, o.id AS option_id, e.ord
      FROM v
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(v.option_ids) = 'array' THEN v.option_ids ELSE '[]'::jsonb END) WITH ORDINALITY AS e(opt, ord)
      JOIN poll_options o ON o.poll_id = v.poll_id AND o.id::text = e.opt
      WHERE v.type IN ('single_choice', 'multi_choice')
    ), picked AS (
      SELECT DISTINCT poll_id, voter_token, option_id FROM known WHERE type = 'multi_choice'
      UNION ALL
      (SELECT DISTINCT ON (poll_id, voter_token) poll_id, voter_token, option_id FROM known WHERE type = 'single_choice'
        ORDER BY poll_id, voter_token, ord)
    )
    SELECT 'o' AS kind, poll_id::text AS poll_id, option_id::text AS key, COUNT(*)::int AS n, NULL::text AS text, NULL::timestamptz AS at
      FROM picked GROUP BY poll_id, option_id
    UNION ALL
    SELECT 'v', poll_id::text, NULL, COUNT(DISTINCT voter_token)::int, NULL, NULL FROM picked GROUP BY poll_id
    UNION ALL
    SELECT 'r', poll_id::text, rating_value::text, COUNT(*)::int, NULL, NULL
      FROM v WHERE type = 'rating' AND rating_value BETWEEN ${RATING_MIN}::int AND ${RATING_MAX}::int GROUP BY poll_id, rating_value
    UNION ALL
    SELECT 'tn', poll_id::text, NULL, COUNT(*)::int, NULL, NULL FROM v WHERE type = 'short_text' AND text_value <> '' GROUP BY poll_id
    UNION ALL
    SELECT 't', poll_id::text, NULL, 0, text_value, updated_at FROM (
      SELECT poll_id, text_value, updated_at, row_number() OVER (PARTITION BY poll_id ORDER BY updated_at DESC, id DESC) AS rn
      FROM v WHERE type = 'short_text' AND text_value <> ''
    ) newest WHERE rn <= ${TEXT_ANSWERS_SHOWN}::int`;
}

type ResultsPoll = Pick<PollRow, 'id' | 'type'> & {options: {id: string; label: string; sortOrder?: number}[]};

/** Results for each poll from the aggregate rows (options in their order, percents adding up to 100). */
export function resultsFromRows(polls: ResultsPoll[], rows: AggRow[]): Map<string, ResultsDto> {
  const byPoll = new Map<string, AggRow[]>();
  for (const row of rows) {
    const list = byPoll.get(row.poll_id);
    if (list) list.push(row);
    else byPoll.set(row.poll_id, [row]);
  }
  const out = new Map<string, ResultsDto>();
  for (const poll of polls) {
    const mine = byPoll.get(poll.id) ?? [];
    const n = (kind: AggRow['kind'], key: string | null = null) =>
      Number(mine.find(r => r.kind === kind && (key === null || r.key === key))?.n ?? 0);
    const isChoice = poll.type === 'single_choice' || poll.type === 'multi_choice';
    const options = [...poll.options].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const counts = isChoice ? options.map(o => n('o', o.id)) : [];
    const percents = largestRemainderPercents(counts);
    let rating: ResultsDto['rating'] = null;
    let totalVoters: number;
    if (isChoice) totalVoters = n('v');
    else if (poll.type === 'rating') {
      const distribution: {value: number; count: number}[] = [];
      let sum = 0;
      let count = 0;
      for (let value = RATING_MIN; value <= RATING_MAX; value++) {
        const c = n('r', String(value));
        distribution.push({value, count: c});
        sum += value * c;
        count += c;
      }
      rating = {average: count ? Math.round((sum / count) * 10) / 10 : null, count, distribution};
      totalVoters = count;
    } else totalVoters = n('tn');
    const textAnswers =
      poll.type === 'short_text'
        ? mine
            .filter(r => r.kind === 't' && r.text && r.at)
            .map(r => ({text: r.text!, at: new Date(r.at!)}))
            .sort((a, b) => b.at.getTime() - a.at.getTime())
            .slice(0, TEXT_ANSWERS_SHOWN)
            .map(t => ({text: t.text, at: t.at.toISOString()}))
        : [];
    out.set(poll.id, {
      pollId: poll.id,
      type: poll.type,
      totalVoters,
      options: isChoice ? options.map((o, i) => ({id: o.id, label: o.label, count: counts[i]!, percent: percents[i]!})) : [],
      rating,
      textAnswers,
    });
  }
  return out;
}

/** Results of the given polls (their options already read) with ONE aggregate query over `scope`. */
export async function resultsOfPolls(db: PrismaClient, polls: ResultsPoll[], scope: PollScope = {pollIds: polls.map(p => p.id)}) {
  return resultsFromRows(polls, polls.length ? await aggregateRows(db, scope) : []);
}

const RESULTS_TTL_MS = 1000;
const CACHE_MAX = 200;
const cache = new Map<string, {at: number; value: Promise<ResultsDto>}>();

/** Drops a poll's cached results on THIS isolate (other isolates age out within a second). */
export const invalidateResults = (pollId: string) => void cache.delete(pollId);

/**
 * Aggregated results. Concurrent callers on one isolate share one query and an answer lives
 * ~1s: a room of 300 phones polling every 3s costs a handful of queries, not hundreds. Another
 * isolate may serve a second-old answer, which is fine for live counts. Pass `options` when the
 * caller already read them (the vote route): then it is the aggregate alone.
 */
export function resultsFor(
  db: PrismaClient,
  poll: Pick<PollRow, 'id' | 'type' | 'status'>,
  now = Date.now(),
  options?: {id: string; label: string; sortOrder?: number}[]
): Promise<ResultsDto> {
  const hit = cache.get(poll.id);
  if (hit && now - hit.at < RESULTS_TTL_MS) return hit.value;
  const value = (async () => {
    const [opts, rows] = await Promise.all([options ?? optionsOf(db, [poll.id]), aggregateRows(db, {pollIds: [poll.id]})]);
    return resultsFromRows([{id: poll.id, type: poll.type, options: opts}], rows).get(poll.id)!;
  })();
  cache.set(poll.id, {at: now, value});
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  // A failed load must not stick for a second.
  value.catch(() => {
    if (cache.get(poll.id)?.value === value) cache.delete(poll.id);
  });
  return value;
}

/* ── the routes ─────────────────────────────────────────────────────────── */

const FIELD_OF: Record<Exclude<VoteError, "You've already answered">, string> = {
  'Choose one option': 'optionIds',
  'Choose at least one option': 'optionIds',
  'Unknown option': 'optionIds',
  'Rating must be 1–5': 'ratingValue',
  "Answer can't be empty": 'textValue',
  'Answer is too long': 'textValue',
};

const isUniqueViolation = (err: unknown): boolean => (err as {code?: unknown} | null)?.code === 'P2002';

const invalid = (c: Context, message: string, field: string) =>
  c.json({...problem('invalid_vote', message), fields: {[field]: message}}, 422);

/**
 * The voter cookie is `<uuid>.<tag>`: the tag is a keyed HMAC of the uuid (the `subject-hash` key,
 * its own `poll-voter:` domain), so only a token THIS server minted counts as a known device. A
 * made-up uuid is treated like no cookie at all, and goes through the new-device limit (audit L-9).
 */
const VOTER_TAG_HEX = 32;
async function voterTag(secret: string, token: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'subject-hash'), new TextEncoder().encode(`poll-voter:${token}`)));
  return [...mac.slice(0, VOTER_TAG_HEX / 2)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The keyed hash a device's limits are counted by (never the token itself). */
const deviceHashOf = (secret: string, token: string) => subjectHash(secret, 'email', `poll-voter:${token}`);

/** The device's voter token, only when its cookie carries a valid tag; else null. */
export async function readVoterToken(c: Context, secret: string | null | undefined): Promise<string | null> {
  const raw = getCookie(c, VOTER_COOKIE);
  if (!raw || !secret || raw.length > 36 + 1 + VOTER_TAG_HEX) return null;
  const [token, tag] = raw.split('.');
  if (!isUuid(token) || !tag || tag.length !== VOTER_TAG_HEX) return null;
  const expected = await voterTag(secret, token);
  let diff = 0;
  for (let i = 0; i < VOTER_TAG_HEX; i++) diff |= expected.charCodeAt(i) ^ tag.charCodeAt(i);
  return diff === 0 ? token : null;
}

/** A new voter token for this device, with its signed cookie. */
export async function mintVoterToken(c: Context, secret: string): Promise<string> {
  const token = crypto.randomUUID();
  setCookie(c, VOTER_COOKIE, `${token}.${await voterTag(secret, token)}`, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: VOTER_COOKIE_PATH,
    maxAge: VOTER_COOKIE_MAX_AGE,
  });
  return token;
}

const myVoteOf = (v: {optionIds: unknown; ratingValue: number | null; textValue: string | null}) => ({
  optionIds: Array.isArray(v.optionIds) ? (v.optionIds as string[]) : [],
  ratingValue: v.ratingValue,
  textValue: v.textValue,
});

/** Only PUBLISHED events resolve (not draft, cancelled or deleted): a draft's code is as good as missing. */
export async function eventByCode(db: PrismaClient, raw: string) {
  const code = normalizeJoinCode(raw);
  if (!code) return null;
  return db.event.findFirst({
    where: {pollJoinCode: code, deletedAt: null, status: 'published'},
    select: {id: true, title: true, pollJoinCode: true},
  });
}

/* ── abuse limits on poll_attempts (see the top of this file) ────────────── */

const since = (seconds: number, now: number) => new Date(now - seconds * 1000);
const ipHashOf = (c: Context, secret: string) => subjectHash(secret, 'ip', rateLimitIp(clientIp(c)));

/** A site between this release and its migration has no `poll_attempts` yet: no limit, rather than no voting. */
async function orNoTable<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (tableMissing(error)) return fallback;
    throw error;
  }
}

/** Now and then (1 in 50 writes), after the answer: drops up to 500 rows older than a day. */
function maybeSweep(c: Context, db: PrismaClient, now: number) {
  if (Math.random() >= 0.02) return;
  background(c, db.$executeRaw`DELETE FROM poll_attempts WHERE id IN (SELECT id FROM poll_attempts WHERE created_at < ${since(86_400, now)} LIMIT 500)`);
}

export type VoteCounts = {ip: number; fresh: number; device: number};

/** The three vote counts in ONE statement, each bounded at its limit + 1 (indexes (kind, ip_hash, created_at) and (device_hash, created_at)). */
export async function voteCounts(db: PrismaClient, ipHash: string, deviceHash: string | null, now = Date.now()): Promise<VoteCounts> {
  const L = POLL_LIMITS;
  const [row] = await orNoTable(
    db.$queryRaw<VoteCounts[]>`
      SELECT
        (SELECT COUNT(*)::int FROM (SELECT 1 FROM poll_attempts WHERE kind = 'vote' AND ip_hash = ${ipHash}
           AND created_at > ${since(L.ipVotes.windowSeconds, now)} LIMIT ${L.ipVotes.max + 1}::int) a) AS ip,
        (SELECT COUNT(*)::int FROM (SELECT 1 FROM poll_attempts WHERE kind = 'vote' AND ip_hash = ${ipHash} AND new_device
           AND created_at > ${since(L.newDevices.windowSeconds, now)} LIMIT ${L.newDevices.max + 1}::int) f) AS fresh,
        (SELECT COUNT(*)::int FROM (SELECT 1 FROM poll_attempts WHERE device_hash = ${deviceHash}::char(64)
           AND created_at > ${since(L.deviceVotes.windowSeconds, now)} LIMIT ${L.deviceVotes.max + 1}::int) d) AS device`,
    [] as VoteCounts[]
  );
  return {ip: Number(row?.ip ?? 0), fresh: Number(row?.fresh ?? 0), device: Number(row?.device ?? 0)};
}

/** Which limit a vote is over (the 429 to answer), or null. Pure. */
export function voteRefusal(counts: VoteCounts, knownDevice: boolean): {retryAfter: number; message: string} | null {
  const L = POLL_LIMITS;
  const busy = 'Lots of answers are arriving from this network. Try again in a moment.';
  if (!knownDevice && counts.fresh >= L.newDevices.max) return {retryAfter: L.newDevices.retryAfter, message: busy};
  if (counts.ip >= L.ipVotes.max) return {retryAfter: L.ipVotes.retryAfter, message: busy};
  if (knownDevice && counts.device >= L.deviceVotes.max) {
    return {retryAfter: L.deviceVotes.retryAfter, message: 'You are answering very fast. Wait a few seconds, then try again.'};
  }
  return null;
}

const recordAttempt = (db: PrismaClient, row: {kind: 'vote' | 'lookup'; ipHash: string; deviceHash?: string | null; newDevice?: boolean}) =>
  orNoTable(
    db.$executeRaw`INSERT INTO poll_attempts (kind, ip_hash, device_hash, new_device) VALUES (${row.kind}, ${row.ipHash}, ${row.deviceHash ?? null}::char(64), ${row.newDevice ?? false})`,
    0
  );

/** Per-IP throttle for code lookups that MISS (stops code enumeration without a write per hit). Returns the 429 or null. */
async function lookupLimited(c: Context): Promise<Response | null> {
  const secret = config.jwtSecret;
  if (!secret) return null; // no hash key without the secret; the vote route 503s anyway
  const db = c.var.db as PrismaClient;
  const now = Date.now();
  const ipHash = await ipHashOf(c, secret);
  const L = POLL_LIMITS.lookupMisses;
  const [row] = await orNoTable(
    db.$queryRaw<{n: number}[]>`SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM poll_attempts WHERE kind = 'lookup' AND ip_hash = ${ipHash}
      AND created_at > ${since(L.windowSeconds, now)} LIMIT ${L.max + 1}::int) m`,
    [] as {n: number}[]
  );
  if (Number(row?.n ?? 0) >= L.max) return tooMany(c, L.retryAfter, 'Too many codes tried. Check the code and try again in a minute.');
  await recordAttempt(db, {kind: 'lookup', ipHash});
  maybeSweep(c, db, now);
  return null;
}

/** RSVP statuses that may attach their identity to a vote (a seat holder, not a cancelled or waitlisted guest). */
export const VOTING_ELIGIBLE_STATUSES = ['confirmed'] as const;
const GUEST_TOKEN_MAX = 400;

/**
 * The RSVP a `g` (raw manage token, or a signed `pg_` token from an email) names, for THIS event and a voting-eligible status; else null.
 * Silent by design: a wrong, stale or oversized token never fails a vote. The token is hashed
 * before the lookup and is never stored or logged.
 */
export async function guestRsvpId(db: PrismaClient, eventId: string, raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || !raw || raw.length > GUEST_TOKEN_MAX) return null;
  const eligible = {eventId, status: {in: [...VOTING_ELIGIBLE_STATUSES]}, response: {not: 'not_going' as const}};
  if (raw.startsWith(POLL_GUEST_PREFIX) && config.jwtSecret) {
    // Signed form (from emails): HMAC verified timing-safe in verifyToken; must name THIS event.
    const signed = verifyPollGuestToken(raw, config.jwtSecret);
    if (signed) {
      if (signed.eventId !== eventId) return null;
      const hit = await db.rsvp.findFirst({where: {id: signed.rsvpId, ...eligible}, select: {id: true}});
      return hit?.id ?? null;
    }
  }
  const row = await db.rsvp.findFirst({
    where: {manageToken: hashToken(raw), ...eligible},
    select: {id: true},
  });
  return row?.id ?? null;
}

const NOT_FOUND = problem('not_found', "We couldn't find a poll with that code.");

export const pollPublicRoutes = new Hono()
  // Live data: never cached by a browser or proxy.
  .use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  })

  .get('/:code/active', withDb, async c => {
    const db = c.var.db;
    const event = await eventByCode(db, c.req.param('code'));
    if (!event) return (await lookupLimited(c)) ?? c.json(NOT_FOUND, 404);
    const [poll, token] = await Promise.all([currentPollOf(db, event.id), readVoterToken(c, config.jwtSecret)]);
    const [options, mine] = poll
      ? await Promise.all([
          optionsOf(db, [poll.id]),
          token ? db.pollVote.findUnique({where: {pollId_voterToken: {pollId: poll.id, voterToken: token}}, select: {optionIds: true, ratingValue: true, textValue: true}}) : null,
        ])
      : [[], null];
    return c.json({
      event: {title: event.title, pollJoinCode: event.pollJoinCode},
      status: !poll ? 'waiting' : poll.status === 'open' ? 'open' : 'closed',
      poll: poll
        ? {
            id: poll.id,
            question: poll.question,
            type: poll.type,
            status: poll.status,
            showResultsToVoters: poll.showResultsToVoters,
            options: options.map(o => ({id: o.id, label: o.label})),
          }
        : null,
      myVote: mine ? myVoteOf(mine) : null,
    });
  })

  // The manage page's poll link: `/p/<code>?g=<manage token>` for a voting-eligible guest, else 404.
  .get('/guest-link/:token', withDb, async c => {
    const token = c.req.param('token');
    const rsvp =
      token.length <= GUEST_TOKEN_MAX
        ? await c.var.db.rsvp.findFirst({
            where: {manageToken: hashToken(token), status: {in: [...VOTING_ELIGIBLE_STATUSES]}, response: {not: 'not_going'}, event: {deletedAt: null, status: 'published'}},
            select: {event: {select: {pollJoinCode: true}}},
          })
        : null;
    if (!rsvp) return (await lookupLimited(c)) ?? c.json(NOT_FOUND, 404);
    return c.json({path: `/p/${rsvp.event.pollJoinCode}?g=${encodeURIComponent(token)}`});
  })

  .post('/:code/votes', withAuthCore, async c => {
    const db = c.var.db;
    // Cheapest check first: the rate limit writes a row, so it comes after the code check.
    const event = await eventByCode(db, c.req.param('code'));
    if (!event) return (await lookupLimited(c)) ?? c.json(NOT_FOUND, 404);
    // Limits (top of this file): one bounded count statement, no lock. A vote without a valid signed
    // voter cookie is a NEW ballot and counts against its IP's new devices (L-9).
    const secret = c.var.secret;
    const now = Date.now();
    const known = await readVoterToken(c, secret);
    const [ipHash, knownHash] = await Promise.all([ipHashOf(c, secret), known ? deviceHashOf(secret, known) : null]);
    const refused = voteRefusal(await voteCounts(db, ipHash, knownHash, now), Boolean(known));
    if (refused) return tooMany(c, refused.retryAfter, refused.message);
    const token = known ?? (await mintVoterToken(c, secret));
    const deviceHash = knownHash ?? (await deviceHashOf(secret, token));
    // Counted now, whatever the vote turns out to be (a bad answer is still an attempt); runs beside the reads below.
    const recorded = recordAttempt(db, {kind: 'vote', ipHash, deviceHash, newDevice: !known});
    maybeSweep(c, db, now);

    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return c.json(problem('invalid_vote', 'Send your answer as JSON.'), 400);
    if (!isUuid(raw.pollId)) return c.json(problem('invalid_vote', 'Unknown poll.'), 422);
    const optionIds = Array.isArray(raw.optionIds) ? raw.optionIds : undefined;
    if (optionIds && (optionIds.length > 10 || !optionIds.every(isUuid))) return invalid(c, 'Unknown option', 'optionIds');
    const input = {
      optionIds: optionIds as string[] | undefined,
      ratingValue: typeof raw.ratingValue === 'number' ? raw.ratingValue : null,
      textValue: typeof raw.textValue === 'string' ? raw.textValue.slice(0, 1000) : null,
    };

    // The poll with its options (one query, a join) and this device's vote, side by side.
    const [found, existing] = await Promise.all([
      db.poll.findFirst({
        where: {id: raw.pollId, eventId: event.id},
        select: {...pollSelect, pollOptions: {select: {id: true, label: true, sortOrder: true}, orderBy: [{sortOrder: 'asc'}, {id: 'asc'}]}},
      }) as Promise<(PollRow & {pollOptions: {id: string; label: string; sortOrder: number}[]}) | null>,
      db.pollVote.findUnique({where: {pollId_voterToken: {pollId: raw.pollId, voterToken: token}}, select: {optionIds: true, ratingValue: true, textValue: true}}),
      recorded,
    ]);
    if (!found) return notFound(c, 'Poll');
    const {pollOptions: options, ...poll} = found;
    const allowed = canVote(poll);
    if (!allowed.ok) return c.json(problem('poll_not_open', allowed.reason), 409);
    if (typeof raw.type === 'string' && raw.type !== poll.type) {
      return c.json(problem('poll_changed', 'This question has changed. Refresh to see the new one.'), 409);
    }

    const decided = applyVote(existing ? myVoteOf(existing) : null, input, poll.type, {validOptionIds: options.map(o => o.id)});
    if (!decided.ok) {
      if (decided.error === "You've already answered") return c.json(problem('already_answered', decided.error), 409);
      return invalid(c, decided.error, FIELD_OF[decided.error]);
    }

    const v = decided.vote;
    const data = {optionIds: v.optionIds, ratingValue: v.ratingValue, textValue: v.textValue};
    // Identity only when the poll is NOT anonymous and the guest link was valid; otherwise the vote stays anonymous.
    const rsvpId = poll.anonymous ? null : await guestRsvpId(db, event.id, raw.g);
    const identity = rsvpId ? {rsvpId} : {};
    // One answer per device per poll is the unique (poll_id, voter_token) index's job, not this read:
    // two taps at once both see "no vote yet", and the index refuses the second insert (P2002).
    const key = {pollId_voterToken: {pollId: poll.id, voterToken: token}};
    if (poll.type === 'short_text') {
      // A short answer is one per device: insert only, and a lost race is "already answered", never a silent overwrite.
      let stored: boolean;
      if (existing) {
        // A row without an answer yet: fill it only while it is still empty (conditional, one statement).
        stored = (await db.pollVote.updateMany({where: {pollId: poll.id, voterToken: token, textValue: null}, data: {...data, ...identity}})).count === 1;
      } else {
        stored = await db.pollVote
          .create({data: {pollId: poll.id, voterToken: token, ...data, ...identity}, select: {id: true}})
          .then(
            () => true,
            err => {
              if (isUniqueViolation(err)) return false;
              throw err;
            }
          );
      }
      if (!stored) return c.json(problem('already_answered', "You've already answered"), 409);
    } else {
      // Choice and rating overwrite (last answer wins). A racing first insert makes the upsert's
      // create fail on the index: the row exists now, so the retry updates it.
      const write = () =>
        db.pollVote.upsert({
          where: key,
          create: {pollId: poll.id, voterToken: token, ...data, ...identity},
          update: {...data, ...identity},
          select: {id: true},
        });
      await write().catch(err => {
        if (isUniqueViolation(err)) return write();
        throw err;
      });
    }
    invalidateResults(poll.id);
    return c.json({
      pollId: poll.id,
      myVote: myVoteOf(v),
      results: poll.showResultsToVoters ? await resultsFor(db, poll, Date.now(), options) : null,
    });
  })

  .get('/:code/results', withDb, async c => {
    const db = c.var.db;
    const event = await eventByCode(db, c.req.param('code'));
    if (!event) return (await lookupLimited(c)) ?? c.json(NOT_FOUND, 404);
    const poll = await currentPollOf(db, event.id);
    // Drafts are the host's prep work: invisible to guests.
    if (!poll) return c.json(problem('not_found', 'No poll has been opened yet.'), 404);
    if (!poll.showResultsToVoters) return c.json(problem('forbidden', 'The host is keeping these results private.'), 403);
    return c.json(await resultsFor(db, poll));
  });
