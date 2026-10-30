import {Hono, type Context} from 'hono';
import {getCookie, setCookie} from 'hono/cookie';

import {aggregateResults, applyVote, canVote, type PollResults, type PollType, type VoteError} from '../../domain/polls';
import {CODE_ALPHABET, POLL_JOIN_CODE_LENGTH} from '../../domain/codes';
import type {PrismaClient} from '../../generated/prisma/client';
import {attempt, keysFor, type Ctx} from '../../platform/auth/kit';
import {RATE_LIMITS, type AttemptKind, type KindPolicy} from '../../platform/auth/rate-limit';
import {config} from '../../platform/config';
import {problem, withAuthCore, withDb} from '../../platform/guards';

/**
 * Guest polls, public side (ported from CreatorCrowdHub `polls-public.ts`). No sign-in:
 * a voter is a DEVICE, named by a random UUID in an HttpOnly cookie scoped to this route.
 * Nothing here returns voter tokens or anyone else's vote.
 *
 *   GET  /site-api/polls-public/:code/active    the current poll (open, else the last opened) + my vote
 *   POST /site-api/polls-public/:code/votes     cast or change my vote
 *   GET  /site-api/polls-public/:code/results   the current poll's results (if the host shows them)
 *
 * Abuse limits: the template's database-backed rate limiter (`rate-limit.ts`), kind `vote`,
 * per client IP, plus one answer per device per poll (unique pollId + voterToken).
 */

export const VOTER_COOKIE = 'site_voter';
export const VOTER_COOKIE_PATH = '/site-api/polls-public';
const VOTER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const MAX_VOTES_READ = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `vote` is not in the template's `AttemptKind` list: its policy is registered once, here, so
 * this slice needs no edit to `rate-limit.ts` (move it into `RATE_LIMITS` there when convenient).
 * Per IP, every vote counts: 600 per 10 minutes (a room on one venue Wi-Fi), then 10s, 20s, 40s...
 */
const VOTE_KIND = 'vote' as AttemptKind;
(RATE_LIMITS as Record<string, KindPolicy>)['vote'] ??= {
  ip: {windowSeconds: 10 * 60, free: 600, baseDelaySeconds: 10, maxDelaySeconds: 10 * 60, counts: 'all'},
};

const LOOKUP_KIND = 'poll_lookup' as AttemptKind;
(RATE_LIMITS as Record<string, KindPolicy>)['poll_lookup'] ??= {
  // Counts only MISSES (unknown, draft or malformed codes): 30 per 10 min per IP, then 10s, 20s... Live pages that hit pay nothing.
  ip: {windowSeconds: 10 * 60, free: 30, baseDelaySeconds: 10, maxDelaySeconds: 10 * 60, counts: 'all'},
};

/* ── helpers shared with the admin routes ───────────────────────────────── */

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

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
    select: {id: true, pollId: true, label: true},
    orderBy: {id: 'asc'},
  });
  return rows.map((o, sortOrder) => ({...o, sortOrder}));
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

/* ── results, cached per isolate for a moment (best effort only) ────────── */

const RESULTS_TTL_MS = 1000;
const CACHE_MAX = 200;
const cache = new Map<string, {at: number; value: Promise<ResultsDto>}>();

/** Drops a poll's cached results on THIS isolate (other isolates age out within a second). */
export const invalidateResults = (pollId: string) => void cache.delete(pollId);

/**
 * Aggregated results. Concurrent callers on one isolate share one query and an answer lives
 * ~1s: a room of 300 phones polling every 3s costs a handful of queries, not hundreds. Another
 * isolate may serve a second-old answer, which is fine for live counts.
 */
export function resultsFor(db: PrismaClient, poll: Pick<PollRow, 'id' | 'type' | 'status'>, now = Date.now()): Promise<ResultsDto> {
  const hit = cache.get(poll.id);
  if (hit && now - hit.at < RESULTS_TTL_MS) return hit.value;
  const value = (async () => {
    const [options, votes] = await Promise.all([
      optionsOf(db, [poll.id]),
      db.pollVote.findMany({
        where: {pollId: poll.id},
        select: {voterToken: true, optionIds: true, ratingValue: true, textValue: true, createdAt: true, updatedAt: true},
        take: MAX_VOTES_READ,
      }),
    ]);
    return toResultsDto(
      aggregateResults(
        {id: poll.id, type: poll.type, status: poll.status, sortOrder: 0},
        options,
        votes.map(v => ({...v, optionIds: Array.isArray(v.optionIds) ? (v.optionIds as string[]) : []}))
      )
    );
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

const invalid = (c: Context, message: string, field: string) =>
  c.json({...problem('invalid_vote', message), fields: {[field]: message}}, 422);

function readVoterToken(c: Context): string | null {
  const token = getCookie(c, VOTER_COOKIE);
  return token && isUuid(token) ? token : null;
}

function ensureVoterToken(c: Context): string {
  const existing = readVoterToken(c);
  if (existing) return existing;
  const token = crypto.randomUUID();
  setCookie(c, VOTER_COOKIE, token, {
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

/** Per-IP throttle for code lookups that MISS (stops code enumeration without a write per poll). Returns the 429 or null. */
async function lookupLimited(c: Context): Promise<Response | null> {
  const secret = config.jwtSecret;
  if (!secret) return null; // no limiter key without the secret; the vote route 503s anyway
  const ctx = c as unknown as Ctx;
  ctx.set('secret', secret);
  const {stop} = await attempt(ctx, LOOKUP_KIND, await keysFor(ctx, null));
  return stop;
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
    const poll = await currentPollOf(db, event.id);
    const token = readVoterToken(c);
    const [options, mine] = poll
      ? await Promise.all([
          optionsOf(db, [poll.id]),
          token ? db.pollVote.findUnique({where: {pollId_voterToken: {pollId: poll.id, voterToken: token}}}) : null,
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

  .post('/:code/votes', withAuthCore, async c => {
    const ctx = c as unknown as Ctx;
    const db = c.var.db;
    // Cheapest check first: the rate limit writes a row, so it comes after the code check.
    const event = await eventByCode(db, c.req.param('code'));
    if (!event) return (await lookupLimited(c)) ?? c.json(NOT_FOUND, 404);
    const limited = await attempt(ctx, VOTE_KIND, await keysFor(ctx, null));
    if (limited.stop) return limited.stop;

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

    const poll = (await db.poll.findFirst({where: {id: raw.pollId, eventId: event.id}, select: pollSelect})) as PollRow | null;
    if (!poll) return c.json(problem('not_found', 'Poll not found.'), 404);
    const allowed = canVote(poll);
    if (!allowed.ok) return c.json(problem('poll_not_open', allowed.reason), 409);
    if (typeof raw.type === 'string' && raw.type !== poll.type) {
      return c.json(problem('poll_changed', 'This question has changed. Refresh to see the new one.'), 409);
    }

    const token = ensureVoterToken(c);
    const [options, existing] = await Promise.all([
      optionsOf(db, [poll.id]),
      db.pollVote.findUnique({where: {pollId_voterToken: {pollId: poll.id, voterToken: token}}}),
    ]);
    const decided = applyVote(existing ? myVoteOf(existing) : null, input, poll.type, {validOptionIds: options.map(o => o.id)});
    if (!decided.ok) {
      if (decided.error === "You've already answered") return c.json(problem('already_answered', decided.error), 409);
      return invalid(c, decided.error, FIELD_OF[decided.error]);
    }

    const v = decided.vote;
    const data = {optionIds: v.optionIds, ratingValue: v.ratingValue, textValue: v.textValue};
    // Choice and rating overwrite; a short answer is one per device (the domain refused a second).
    await db.pollVote.upsert({
      where: {pollId_voterToken: {pollId: poll.id, voterToken: token}},
      create: {pollId: poll.id, voterToken: token, ...data},
      update: poll.type === 'short_text' ? {} : data,
    });
    invalidateResults(poll.id);
    return c.json({
      pollId: poll.id,
      myVote: myVoteOf(v),
      results: poll.showResultsToVoters ? await resultsFor(db, poll) : null,
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
