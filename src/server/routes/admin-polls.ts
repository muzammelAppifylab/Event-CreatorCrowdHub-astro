import {Hono} from 'hono';

import type {PollType} from '../../domain/polls';
import type {Prisma, PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth/audit';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {attachmentHeader, csvExport, type CsvValue, toCsv} from '../csv';
import {PERMISSIONS} from '../permissions';
import {nextSortOrder, validateOrder} from '../sort-order';
import {isUuid, notFound} from '../validate';
import {emitWebhook, emitWebhooks, pollClosedPayload} from '../webhook-emit';
import {
  invalidateResults,
  normalizeJoinCode,
  orderedUuid,
  type PollScope,
  pollSelect,
  type PollRow,
  type ResultsDto,
  aggregateRows,
  resultsFromRows,
} from './polls-public';

/**
 * Live polls, admin side (ported from CreatorCrowdHub `polls.ts`). Holders of `site:event:manage`.
 * Mounted at `/site-api/polls`:
 *
 *   GET    /polls/event/:eventId          the event's polls (builder order) with live results
 *   POST   /polls/event/:eventId          create a draft poll
 *   GET    /polls/by-code/:code           the same list, found by join code (presenter screen)
 *   PATCH  /polls/:pollId                 edit a DRAFT poll
 *   DELETE /polls/:pollId                 delete a DRAFT poll
 *   POST   /polls/:pollId/open            open it (closes the event's other open poll)
 *   POST   /polls/:pollId/close           close it
 *   GET    /polls/:pollId/results         its results
 *   GET    /polls/:pollId/results.csv     its votes as CSV (read page by page, 20,000 rows at most; audited)
 *   GET    /polls/event/:eventId/results.csv  all the event's polls as one CSV (same cap; audited)
 *
 * Order (polls and options) is the organiser-controlled `sortOrder` (ties broken by id, `orderedUuid`).
 * One open poll per event is enforced by the partial unique index `polls_one_open_per_event_uq`.
 * A poll of a soft-deleted event is not found (404) on every route: the single-poll reads carry
 * `event: {deletedAt: null}` in their own where (same statement, no extra round trip).
 */

/**
 * Vote rows per page of a CSV export (audit M-22): votes are read page by page with a keyset on
 * (created_at, id) per poll (index poll_votes_poll_created_idx) and turned into text one page at a
 * time (`csvExport`), all before the route answers, so the request's database client is never used
 * by a response body after the handler returned.
 */
export const POLL_EXPORT_PAGE = 1000;
/** Most vote rows one CSV export holds; `X-Export-Truncated: 1` says when it was cut. */
export const POLL_EXPORT_MAX_ROWS = 20_000;

export type ExportVote = {
  optionIds: unknown;
  ratingValue: number | null;
  textValue: string | null;
  createdAt: Date;
  updatedAt: Date;
  email?: string | null;
};

function voteAnswer(type: PollType, labels: Map<string, string>, v: ExportVote): CsvValue {
  const ids = Array.isArray(v.optionIds) ? v.optionIds.filter((x): x is string => typeof x === 'string') : [];
  if (type === 'rating') return v.ratingValue ?? '';
  if (type === 'short_text') return v.textValue ?? '';
  return ids.map(id => labels.get(id) ?? '').filter(Boolean).join('; ');
}

/** One row per vote: question, answer, time (UTC); the guest email column only for non-anonymous polls. */
export function pollVotesCsv(poll: {question: string; type: PollType; anonymous: boolean}, labels: Map<string, string>, votes: ExportVote[]): string {
  const header: CsvValue[] = ['Poll', 'Answer', 'Submitted at (UTC)', ...(poll.anonymous ? [] : ['Guest email'])];
  const rows = votes.map((v): CsvValue[] => {
    const answer = voteAnswer(poll.type, labels, v);
    return [poll.question, answer,(v.updatedAt ?? v.createdAt).toISOString(), ...(poll.anonymous ? [] : [v.email ?? ''])];
  });
  return toCsv([header, ...rows]);
}

/** All polls of an event in one sheet: one row per vote, polls in builder order; emails only on non-anonymous polls. */
export function eventVotesCsv(
  polls: {id: string; question: string; type: PollType; anonymous: boolean}[],
  labels: Map<string, string>,
  votes: (ExportVote & {pollId: string})[]
): string {
  const rows: CsvValue[][] = [['Poll', 'Answer', 'Submitted at (UTC)', 'Guest email']];
  // Grouped once (not a filter per poll): 100 polls x 10,000 votes stays linear.
  const byPoll = new Map<string, (ExportVote & {pollId: string})[]>();
  for (const v of votes) {
    const list = byPoll.get(v.pollId);
    if (list) list.push(v);
    else byPoll.set(v.pollId, [v]);
  }
  for (const poll of polls) {
    for (const v of byPoll.get(poll.id) ?? []) {
      rows.push([poll.question, voteAnswer(poll.type, labels, v), (v.updatedAt ?? v.createdAt).toISOString(), poll.anonymous ? '' : (v.email ?? '')]);
    }
  }
  return toCsv(rows);
}

type ExportPoll = {id: string; question: string; type: PollType; anonymous: boolean};
type PageVote = ExportVote & {id: string};

/**
 * One poll's votes in pages of `POLL_EXPORT_PAGE`, oldest first, keyset (created_at, id): every page is
 * one indexed query, however deep. The guest's email is read only for a NON-anonymous poll. At most
 * `limit` votes in all.
 */
export async function* votePages(db: Db, poll: ExportPoll, pageSize = POLL_EXPORT_PAGE, limit = Infinity): AsyncGenerator<PageVote[]> {
  // The keyset is Prisma's `cursor` (the last row's id, skipped): the database compares (created_at, id)
  // itself. A JS Date keeps only milliseconds while created_at has microseconds, so a hand-written
  // `createdAt > last.createdAt` re-sent rows at every page edge (and looped forever on a bulk insert).
  let after: string | null = null;
  let read = 0;
  while (read < limit) {
    const take = Math.min(pageSize, limit - read);
    const rows = await db.pollVote.findMany({
      where: {pollId: poll.id},
      ...(after ? {cursor: {id: after}, skip: 1} : {}),
      orderBy: [{createdAt: 'asc'}, {id: 'asc'}],
      take,
      select: {
        id: true,
        optionIds: true,
        ratingValue: true,
        textValue: true,
        createdAt: true,
        updatedAt: true,
        ...(poll.anonymous ? {} : {rsvp: {select: {email: true}}}),
      },
    });
    const page = rows.map(v => ({...v, email: (v as {rsvp?: {email: string} | null}).rsvp?.email ?? null}));
    read += rows.length;
    if (page.length) yield page;
    if (rows.length < take) return;
    const lastId: string = rows[rows.length - 1]!.id;
    after = lastId;
  }
}

/**
 * CSV rows for every poll in builder order, page by page (`emailColumn`: the event sheet always has the
 * column). Reads at most `POLL_EXPORT_MAX_ROWS + 1` votes in all: the extra one tells `csvExport` it was cut.
 */
async function* exportRows(db: Db, polls: ExportPoll[], labels: Map<string, string>, emailColumn: boolean): AsyncGenerator<CsvValue[][]> {
  let left = POLL_EXPORT_MAX_ROWS + 1;
  for (const poll of polls) {
    if (left <= 0) return;
    for await (const page of votePages(db, poll, POLL_EXPORT_PAGE, left)) {
      left -= page.length;
      yield page.map((v): CsvValue[] => {
        const row: CsvValue[] = [poll.question, voteAnswer(poll.type, labels, v), (v.updatedAt ?? v.createdAt).toISOString()];
        if (emailColumn) row.push(poll.anonymous ? '' : (v.email ?? ''));
        return row;
      });
    }
  }
}

const csvHeaders = (name: string, truncated: boolean) => ({
  'Content-Type': 'text/csv; charset=utf-8',
  'Content-Disposition': attachmentHeader(name),
  'Cache-Control': 'private, no-store',
  'X-Export-Truncated': truncated ? '1' : '0',
});

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
const CHOICE: PollType[] = ['single_choice', 'multi_choice'];
const TYPES: PollType[] = ['single_choice', 'multi_choice', 'rating', 'short_text'];

export type PollInput = {question: string; type: PollType; options: string[]; anonymous: boolean; showResultsToVoters: boolean};

/** Validates a poll builder body. A string is the first problem found (message), else the clean input. */
export function parsePollInput(value: unknown): PollInput | {error: string; field: string} {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const question = typeof v.question === 'string' ? v.question.trim() : '';
  if (!question) return {error: 'Write the question', field: 'question'};
  if (question.length > 200) return {error: 'Keep the question under 200 characters', field: 'question'};
  if (typeof v.type !== 'string' || !TYPES.includes(v.type as PollType)) return {error: 'Unknown poll type', field: 'type'};
  const type = v.type as PollType;
  for (const key of ['anonymous', 'showResultsToVoters']) {
    if (v[key] !== undefined && typeof v[key] !== 'boolean') return {error: 'Must be true or false', field: key};
  }
  let options: string[] = [];
  if (CHOICE.includes(type)) {
    if (!Array.isArray(v.options)) return {error: `Add at least ${POLL_MIN_OPTIONS} options`, field: 'options'};
    options = v.options.map(o => (typeof o === 'string' ? o.trim() : ''));
    if (options.length < POLL_MIN_OPTIONS) return {error: `Add at least ${POLL_MIN_OPTIONS} options`, field: 'options'};
    if (options.length > POLL_MAX_OPTIONS) return {error: `Use at most ${POLL_MAX_OPTIONS} options`, field: 'options'};
    if (options.some(o => !o || o.length > 100)) return {error: 'Options need 1 to 100 characters', field: 'options'};
    if (new Set(options.map(o => o.toLowerCase())).size !== options.length) return {error: 'Each option must be different', field: 'options'};
  }
  return {
    question,
    type,
    options,
    anonymous: v.anonymous !== false,
    showResultsToVoters: v.showResultsToVoters !== false,
  };
}

const invalid = (error: {error: string; field: string}) => ({...problem('invalid_poll', error.error), fields: {[error.field]: error.error}});

const isUnique = (error: unknown) => (error as {code?: unknown} | null)?.code === 'P2002';

const eventSelect = {id: true, title: true, pollJoinCode: true} as const;
type EventRef = {id: string; title: string; pollJoinCode: string};

const eventRef = (e: EventRef) => ({
  id: e.id,
  title: e.title,
  pollJoinCode: e.pollJoinCode,
  votePath: `/p/${e.pollJoinCode}`,
  presenterPath: `/dashboard/polls/${e.pollJoinCode}/present`,
});

type Db = PrismaClient;

const POLL_LIST_LIMIT = 200;
const pollOrder = [{sortOrder: 'asc' as const}, {id: 'asc' as const}];
const optionsSelect = {select: {id: true, label: true, sortOrder: true}, orderBy: pollOrder};
/** A poll with its options in ONE query: `relationJoins` makes it a join, never a query per poll. */
const withOptions = {...pollSelect, pollOptions: optionsSelect} as const;

type OptionRow = {id: string; label: string; sortOrder: number};
type AdminPollRow = PollRow & {pollOptions?: OptionRow[]};

const labelsOf = (polls: AdminPollRow[]) => new Map(polls.flatMap(p => (p.pollOptions ?? []).map(o => [o.id, o.label] as const)));

/**
 * Results are COUNTED BY THE DATABASE (`aggregateRows`: one GROUP BY statement for every poll in a
 * scope, run beside the poll list), never rebuilt from every vote row (audit M-28).
 */
const resultsOf = (polls: AdminPollRow[], rows: Awaited<ReturnType<typeof aggregateRows>>) =>
  resultsFromRows(polls.map(p => ({id: p.id, type: p.type, options: p.pollOptions ?? []})), rows);

function adminPoll(p: AdminPollRow, results: Map<string, ResultsDto> = new Map()) {
  return {
    id: p.id,
    eventId: p.eventId,
    question: p.question,
    type: p.type,
    status: p.status,
    anonymous: p.anonymous,
    showResultsToVoters: p.showResultsToVoters,
    openedAt: p.openedAt?.toISOString() ?? null,
    closedAt: p.closedAt?.toISOString() ?? null,
    options: (p.pollOptions ?? []).map(o => ({id: o.id, label: o.label})),
    sortOrder: p.sortOrder ?? 0,
    results: p.status === 'draft' ? null : (results.get(p.id) ?? null),
  };
}

/** The polls and their options in one query (run beside the event lookup and the results aggregate). */
const listPolls = (db: Db, where: Prisma.PollWhereInput) =>
  db.poll.findMany({where, select: withOptions, orderBy: pollOrder, take: POLL_LIST_LIMIT}) as Promise<AdminPollRow[]>;

/**
 * The list with its results: the event, the polls and every count in ONE round trip (three queries
 * side by side; the aggregate finds the polls through `scope` itself, so it doesn't wait for the list).
 */
async function pollList(db: Db, event: Promise<EventRef | null>, where: Prisma.PollWhereInput, scope: PollScope) {
  const [found, rows, counts] = await Promise.all([event, listPolls(db, where), aggregateRows(db, scope)]);
  if (!found) return null;
  const results = resultsOf(rows, counts);
  return {event: eventRef(found), polls: rows.map(p => adminPoll(p, results))};
}

export const adminPollRoutes = new Hono()
  .get('/event/:eventId', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const id = c.req.param('eventId');
    if (!isUuid(id)) return notFound(c, 'Event');
    const list = await pollList(c.var.db, c.var.db.event.findFirst({where: {id, deletedAt: null}, select: eventSelect}), {eventId: id}, {eventId: id});
    if (!list) return notFound(c, 'Event');
    c.header('Cache-Control', 'private, no-store');
    return c.json(list);
  })

  .get('/event/:eventId/results.csv', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('eventId');
    if (!isUuid(id)) return notFound(c, 'Event');
    // The event and its polls with their options: one trip. The votes follow page by page, before the answer.
    const [event, polls] = await Promise.all([
      db.event.findFirst({where: {id, deletedAt: null}, select: {id: true}}),
      db.poll.findMany({where: {eventId: id}, select: withOptions, orderBy: pollOrder, take: POLL_LIST_LIMIT}) as Promise<AdminPollRow[]>,
    ]);
    if (!event) return notFound(c, 'Event');
    const {csv, rows, truncated} = await csvExport(['Poll', 'Answer', 'Submitted at (UTC)', 'Guest email'], exportRows(db, polls, labelsOf(polls), true), POLL_EXPORT_MAX_ROWS);
    await audit(db, {actorUserId: c.var.viewer.id, action: 'poll_results_exported', target: ['event', event.id], meta: {polls: polls.length, rows, truncated}});
    return c.body(csv, 200, csvHeaders(`poll-votes-${event.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`, truncated));
  })

  .get('/by-code/:code', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const code = normalizeJoinCode(c.req.param('code'));
    if (!code) return notFound(c, 'Event');
    const list = await pollList(
      c.var.db,
      c.var.db.event.findFirst({where: {pollJoinCode: code, deletedAt: null}, select: eventSelect}),
      {event: {pollJoinCode: code, deletedAt: null}},
      {joinCode: code}
    );
    if (!list) return notFound(c, 'Event');
    c.header('Cache-Control', 'private, no-store');
    return c.json(list);
  })

  .post('/event/:eventId', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('eventId');
    if (!isUuid(id)) return notFound(c, 'Event');
    const body = await c.req.json().catch(() => null);
    // The event, the poll count and the last position: independent reads, one trip.
    const [event, count, last] = await Promise.all([
      db.event.findFirst({where: {id, deletedAt: null}, select: {id: true}}),
      db.poll.count({where: {eventId: id}}),
      db.poll.aggregate({where: {eventId: id}, _max: {sortOrder: true}}),
    ]);
    if (!event) return notFound(c, 'Event');
    const input = parsePollInput(body);
    if ('error' in input) return c.json(invalid(input), 422);
    if (count >= 100) {
      return c.json(problem('too_many_polls', 'An event can have at most 100 polls.'), 409);
    }
    const created = await db.poll.create({
      data: {
        id: orderedUuid(Date.now() / 1000),
        sortOrder: nextSortOrder(last._max.sortOrder),
        eventId: event.id,
        question: input.question,
        type: input.type,
        anonymous: input.anonymous,
        showResultsToVoters: input.showResultsToVoters,
        pollOptions: {create: input.options.map((label, i) => ({id: orderedUuid(i), label, sortOrder: i}))},
      },
      // The new options come back in the same statement: no second read.
      select: withOptions,
    });
    return c.json({poll: adminPoll(created as AdminPollRow)}, 201);
  })

  .patch('/event/:eventId/order', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('eventId');
    if (!isUuid(id)) return notFound(c, 'Event');
    const body = (await c.req.json().catch(() => null)) as {ids?: unknown} | null;
    const [event, existing] = await Promise.all([
      db.event.findFirst({where: {id, deletedAt: null}, select: {id: true}}),
      db.poll.findMany({where: {eventId: id}, select: {id: true}, take: POLL_LIST_LIMIT}),
    ]);
    if (!event) return notFound(c, 'Event');
    if (!validateOrder(body?.ids, existing.map(p => p.id))) {
      return c.json(invalid({error: 'Send every poll of this event exactly once.', field: 'ids'}), 422);
    }
    const ids = body!.ids as string[];
    // ONE statement for the whole order (a bound uuid[] works on the live database since template 0.10.21);
    // the event id in the WHERE keeps it to this event's polls.
    await db.$executeRaw`
      UPDATE polls AS p SET sort_order = (o.ord - 1)::int
      FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS o(id, ord)
      WHERE p.id = o.id AND p.event_id = ${id}::uuid`;
    return c.json({ok: true});
  })

  .patch('/:pollId', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('pollId');
    const poll = isUuid(id) ? await db.poll.findUnique({where: {id, event: {deletedAt: null}}, select: {id: true, status: true}}) : null;
    if (!poll) return notFound(c, 'Poll');
    if (poll.status !== 'draft') return c.json(problem('not_draft', 'Only draft polls can be edited. This one has already been opened.'), 409);
    const input = parsePollInput(await c.req.json().catch(() => null));
    if ('error' in input) return c.json(invalid(input), 422);
    let updated: AdminPollRow;
    try {
      updated = (await db.$transaction(async tx => {
        await tx.pollOption.deleteMany({where: {pollId: poll.id}});
        await tx.pollOption.createMany({data: input.options.map((label, i) => ({id: orderedUuid(i), pollId: poll.id, label, sortOrder: i}))});
        // Still a draft (opened meanwhile: P2025 rolls it all back); the new options come back in this statement.
        return tx.poll.update({
          where: {id: poll.id, status: 'draft'},
          data: {question: input.question, type: input.type, anonymous: input.anonymous, showResultsToVoters: input.showResultsToVoters},
          select: withOptions,
        });
      })) as AdminPollRow;
    } catch (error) {
      if ((error as {code?: unknown} | null)?.code === 'P2025') {
        return c.json(problem('not_draft', 'Only draft polls can be edited. This one has already been opened.'), 409);
      }
      throw error;
    }
    invalidateResults(poll.id);
    return c.json({poll: adminPoll(updated)});
  })

  .delete('/:pollId', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const id = c.req.param('pollId');
    const poll = isUuid(id) ? await c.var.db.poll.findUnique({where: {id, event: {deletedAt: null}}, select: {id: true, status: true}}) : null;
    if (!poll) return notFound(c, 'Poll');
    if (poll.status !== 'draft') return c.json(problem('not_draft', 'Only draft polls can be deleted. This one has already been opened.'), 409);
    await c.var.db.poll.deleteMany({where: {id: poll.id, status: 'draft'}});
    invalidateResults(poll.id);
    await audit(c.var.db, {actorUserId: c.var.viewer.id, action: 'poll_deleted', target: ['poll', poll.id]});
    return c.json({ok: true});
  })

  .post('/:pollId/open', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('pollId');
    const poll = isUuid(id) ? await db.poll.findUnique({where: {id, event: {deletedAt: null}}, select: {id: true, eventId: true, status: true}}) : null;
    if (!poll) return notFound(c, 'Poll');
    if (poll.status !== 'open') {
      const now = new Date();
      try {
        const closed = await db.$transaction(async tx => {
          const others = await tx.poll.findMany({where: {eventId: poll.eventId, status: 'open', id: {not: poll.id}}, select: {id: true}});
          await tx.poll.updateMany({where: {id: {in: others.map(o => o.id)}}, data: {status: 'closed', closedAt: now}});
          await tx.poll.update({where: {id: poll.id}, data: {status: 'open', openedAt: now, closedAt: null}});
          return others;
        });
        for (const other of closed) invalidateResults(other.id);
        // One call for all of them (one job), never one per poll.
        emitWebhooks(c, db, closed.map(other => ({event: 'poll.closed' as const, payload: pollClosedPayload({id: other.id, eventId: poll.eventId})})));
      } catch (error) {
        // Two presenters opened polls at the same instant; the partial unique index kept one.
        if (isUnique(error)) return c.json(problem('conflict', 'Another poll was opened at the same moment. Try again.'), 409);
        throw error;
      }
      invalidateResults(poll.id);
      await audit(db, {actorUserId: c.var.viewer.id, action: 'poll_opened', target: ['poll', poll.id]});
    }
    return c.json({ok: true});
  })

  .post('/:pollId/close', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('pollId');
    const poll = isUuid(id) ? await db.poll.findUnique({where: {id, event: {deletedAt: null}}, select: {id: true, eventId: true, status: true}}) : null;
    if (!poll) return notFound(c, 'Poll');
    if (poll.status === 'draft') return c.json(problem('not_opened', "This poll hasn't been opened yet."), 409);
    if (poll.status === 'open') {
      const closed = await db.poll.updateMany({where: {id: poll.id, status: 'open'}, data: {status: 'closed', closedAt: new Date()}});
      invalidateResults(poll.id);
      if (closed.count === 1) {
        emitWebhook(c, db, 'poll.closed', pollClosedPayload(poll));
        await audit(db, {actorUserId: c.var.viewer.id, action: 'poll_closed', target: ['poll', poll.id]});
      }
    }
    return c.json({ok: true});
  })

  .get('/:pollId/results', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const id = c.req.param('pollId');
    if (!isUuid(id)) return notFound(c, 'Poll');
    // The poll with its options, and its counts: side by side, one round trip.
    const [poll, counts] = await Promise.all([
      c.var.db.poll.findUnique({where: {id, event: {deletedAt: null}}, select: withOptions}) as Promise<AdminPollRow | null>,
      aggregateRows(c.var.db, {pollIds: [id]}),
    ]);
    if (!poll) return notFound(c, 'Poll');
    c.header('Cache-Control', 'private, no-store');
    return c.json(resultsOf([poll], counts).get(poll.id));
  })

  .get('/:pollId/results.csv', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('pollId');
    if (!isUuid(id)) return notFound(c, 'Poll');
    const poll = (await db.poll.findUnique({where: {id, event: {deletedAt: null}}, select: withOptions})) as AdminPollRow | null;
    if (!poll) return notFound(c, 'Poll');
    const header: CsvValue[] = ['Poll', 'Answer', 'Submitted at (UTC)', ...(poll.anonymous ? [] : ['Guest email'])];
    const {csv, rows, truncated} = await csvExport(header, exportRows(db, [poll], labelsOf([poll]), !poll.anonymous), POLL_EXPORT_MAX_ROWS);
    await audit(db, {actorUserId: c.var.viewer.id, action: 'poll_results_exported', target: ['poll', poll.id], meta: {rows, truncated}});
    return c.body(csv, 200, csvHeaders(`poll-votes-${poll.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`, truncated));
  });
