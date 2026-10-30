import {Hono} from 'hono';

import type {PollType} from '../../domain/polls';
import type {PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {PERMISSIONS} from '../permissions';
import {emitWebhook, pollClosedPayload} from '../webhook-emit';
import {
  invalidateResults,
  isUuid,
  normalizeJoinCode,
  optionsOf,
  orderedUuid,
  pollSelect,
  type PollRow,
  resultsFor,
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
 *
 * Order (polls and options) is carried by their ids (`orderedUuid`): the schema has no sort column.
 * One open poll per event is enforced by the partial unique index `polls_one_open_per_event_uq`.
 */

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

async function adminPolls(db: Db, rows: PollRow[]) {
  const options = await optionsOf(
    db,
    rows.map(p => p.id)
  );
  return Promise.all(
    rows.map(async p => ({
      id: p.id,
      eventId: p.eventId,
      question: p.question,
      type: p.type,
      status: p.status,
      anonymous: p.anonymous,
      showResultsToVoters: p.showResultsToVoters,
      openedAt: p.openedAt?.toISOString() ?? null,
      closedAt: p.closedAt?.toISOString() ?? null,
      options: options.filter(o => o.pollId === p.id).map(o => ({id: o.id, label: o.label})),
      results: p.status === 'draft' ? null : await resultsFor(db, p),
    }))
  );
}

async function listFor(db: Db, event: EventRef) {
  const rows = (await db.poll.findMany({where: {eventId: event.id}, select: pollSelect, orderBy: {id: 'asc'}, take: 200})) as PollRow[];
  return {event: eventRef(event), polls: await adminPolls(db, rows)};
}

export const adminPollRoutes = new Hono()
  .get('/event/:eventId', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const id = c.req.param('eventId');
    const event = isUuid(id) ? await c.var.db.event.findFirst({where: {id, deletedAt: null}, select: eventSelect}) : null;
    if (!event) return c.json(problem('not_found', 'Event not found.'), 404);
    c.header('Cache-Control', 'private, no-store');
    return c.json(await listFor(c.var.db, event));
  })

  .get('/by-code/:code', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const code = normalizeJoinCode(c.req.param('code'));
    const event = code ? await c.var.db.event.findFirst({where: {pollJoinCode: code, deletedAt: null}, select: eventSelect}) : null;
    if (!event) return c.json(problem('not_found', 'Event not found.'), 404);
    c.header('Cache-Control', 'private, no-store');
    return c.json(await listFor(c.var.db, event));
  })

  .post('/event/:eventId', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('eventId');
    const event = isUuid(id) ? await db.event.findFirst({where: {id, deletedAt: null}, select: {id: true}}) : null;
    if (!event) return c.json(problem('not_found', 'Event not found.'), 404);
    const input = parsePollInput(await c.req.json().catch(() => null));
    if ('error' in input) return c.json(invalid(input), 422);
    if ((await db.poll.count({where: {eventId: event.id}})) >= 100) {
      return c.json(problem('too_many_polls', 'An event can have at most 100 polls.'), 409);
    }
    const created = await db.poll.create({
      data: {
        id: orderedUuid(Date.now() / 1000),
        eventId: event.id,
        question: input.question,
        type: input.type,
        anonymous: input.anonymous,
        showResultsToVoters: input.showResultsToVoters,
        pollOptions: {create: input.options.map((label, i) => ({id: orderedUuid(i), label}))},
      },
      select: pollSelect,
    });
    return c.json({poll: (await adminPolls(db, [created as PollRow]))[0]}, 201);
  })

  .patch('/:pollId', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('pollId');
    const poll = isUuid(id) ? await db.poll.findUnique({where: {id}, select: {id: true, status: true}}) : null;
    if (!poll) return c.json(problem('not_found', 'Poll not found.'), 404);
    if (poll.status !== 'draft') return c.json(problem('not_draft', 'Only draft polls can be edited. This one has already been opened.'), 409);
    const input = parsePollInput(await c.req.json().catch(() => null));
    if ('error' in input) return c.json(invalid(input), 422);
    const updated = await db.$transaction(async tx => {
      await tx.pollOption.deleteMany({where: {pollId: poll.id}});
      await tx.pollOption.createMany({data: input.options.map((label, i) => ({id: orderedUuid(i), pollId: poll.id, label}))});
      return tx.poll.update({
        where: {id: poll.id},
        data: {question: input.question, type: input.type, anonymous: input.anonymous, showResultsToVoters: input.showResultsToVoters},
        select: pollSelect,
      });
    });
    invalidateResults(poll.id);
    return c.json({poll: (await adminPolls(db, [updated as PollRow]))[0]});
  })

  .delete('/:pollId', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const id = c.req.param('pollId');
    const poll = isUuid(id) ? await c.var.db.poll.findUnique({where: {id}, select: {id: true, status: true}}) : null;
    if (!poll) return c.json(problem('not_found', 'Poll not found.'), 404);
    if (poll.status !== 'draft') return c.json(problem('not_draft', 'Only draft polls can be deleted. This one has already been opened.'), 409);
    await c.var.db.poll.deleteMany({where: {id: poll.id, status: 'draft'}});
    invalidateResults(poll.id);
    return c.json({ok: true});
  })

  .post('/:pollId/open', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('pollId');
    const poll = isUuid(id) ? await db.poll.findUnique({where: {id}, select: {id: true, eventId: true, status: true}}) : null;
    if (!poll) return c.json(problem('not_found', 'Poll not found.'), 404);
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
      } catch (error) {
        // Two presenters opened polls at the same instant; the partial unique index kept one.
        if (isUnique(error)) return c.json(problem('conflict', 'Another poll was opened at the same moment. Try again.'), 409);
        throw error;
      }
      invalidateResults(poll.id);
    }
    return c.json({ok: true});
  })

  .post('/:pollId/close', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const db = c.var.db;
    const id = c.req.param('pollId');
    const poll = isUuid(id) ? await db.poll.findUnique({where: {id}, select: {id: true, eventId: true, status: true}}) : null;
    if (!poll) return c.json(problem('not_found', 'Poll not found.'), 404);
    if (poll.status === 'draft') return c.json(problem('not_opened', "This poll hasn't been opened yet."), 409);
    if (poll.status === 'open') {
      const closed = await db.poll.updateMany({where: {id: poll.id, status: 'open'}, data: {status: 'closed', closedAt: new Date()}});
      invalidateResults(poll.id);
      if (closed.count === 1) emitWebhook(c, db, 'poll.closed', pollClosedPayload(poll));
    }
    return c.json({ok: true});
  })

  .get('/:pollId/results', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
    const id = c.req.param('pollId');
    const poll = isUuid(id) ? ((await c.var.db.poll.findUnique({where: {id}, select: pollSelect})) as PollRow | null) : null;
    if (!poll) return c.json(problem('not_found', 'Poll not found.'), 404);
    c.header('Cache-Control', 'private, no-store');
    return c.json(await resultsFor(c.var.db, poll));
  });
