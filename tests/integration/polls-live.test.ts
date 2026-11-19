import {readFileSync} from 'node:fs';

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {aggregateResults, type PollType} from '../../src/domain/polls';
import {subjectHash} from '../../src/platform/auth/keys';
import {rateLimitIp} from '../../src/platform/auth/kit';
import {votePages} from '../../src/server/routes/admin-polls';
import {POLL_LIMITS, resultsOfPolls, toResultsDto} from '../../src/server/routes/polls-public';
import {createEvent, eventsApp, resetEvents, userWith} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

/**
 * Live polls under load (audit M-3, L-9, M-28, M-22), against real Postgres. `poll_attempts` comes from
 * migration 20261113180000_poll_attempts: when the test database doesn't have it yet, this file creates
 * it for its run and drops it again, so the database is left as it was found.
 */
const P = '/site-api/admin-polls';
type PollDto = {id: string; options: {id: string}[]};
let created = false;

describe.skipIf(!DATABASE_URL)('live polls (integration, real Postgres)', () => {
  let admin: Browser;

  beforeAll(async () => {
    configureEnv();
    const [row] = await db.$queryRaw<{t: string | null}[]>`SELECT to_regclass('poll_attempts')::text AS t`;
    if (!row?.t) {
      const sql = readFileSync('prisma/migrations/20261113180000_poll_attempts/migration.sql', 'utf8')
        .replace(/--.*$/gm, '')
        .split(';')
        .map(s => s.trim())
        .filter(s => s && !/^(BEGIN|COMMIT)$/i.test(s));
      for (const statement of sql) await db.$executeRawUnsafe(statement);
      created = true;
    }
  });
  afterAll(async () => {
    if (created) {
      await db.$executeRawUnsafe('DROP INDEX IF EXISTS "poll_votes_poll_created_idx"');
      await db.$executeRawUnsafe('DROP TABLE IF EXISTS "poll_attempts"');
    }
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    await db.$executeRawUnsafe('TRUNCATE "poll_attempts"');
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
  });

  async function openPoll(type: PollType, options: string[] = []) {
    const ev = await createEvent(admin);
    const poll = (await admin.post(`${P}/event/${ev.id}`, {question: `${type}?`, type, options})).json.poll as PollDto;
    expect((await admin.post(`${P}/${poll.id}/open`)).status).toBe(200);
    const code = (await db.event.findUniqueOrThrow({where: {id: ev.id}})).pollJoinCode;
    return {ev, poll, V: `/site-api/polls-public/${code}`};
  }

  it('M-3: 40 phones on one venue IP voting at the same moment are all accepted', async () => {
    const {poll, V} = await openPoll('single_choice', ['Yes', 'No']);
    const phones = Array.from({length: 40}, () => new Browser(eventsApp, '198.51.100.7'));
    // CSRF cookies first, so the 40 votes themselves go out together.
    await Promise.all(phones.map(p => p.get('/site-api/auth/csrf')));
    const answers = await Promise.all(phones.map((p, i) => p.post(`${V}/votes`, {pollId: poll.id, optionIds: [poll.options[i % 2]!.id]})));
    expect(answers.map(a => a.status)).toEqual(Array(40).fill(200));
    expect(await db.pollVote.count({where: {pollId: poll.id}})).toBe(40);
    const results = (await admin.get(`${P}/${poll.id}/results`)).json as {totalVoters: number; options: {count: number}[]};
    expect(results.totalVoters).toBe(40);
    expect(results.options.map(o => o.count)).toEqual([20, 20]);
  });

  it('L-9: a device that drops (or forges) its cookie is a new ballot, capped per IP; a known device is not', async () => {
    const {poll, V} = await openPoll('single_choice', ['Yes', 'No']);
    const ip = '198.51.100.8';
    const known = new Browser(eventsApp, ip);
    expect((await known.post(`${V}/votes`, {pollId: poll.id, optionIds: [poll.options[0]!.id]})).status).toBe(200);
    // The IP has now minted the most new devices it may in the window.
    const ipHash = await subjectHash(process.env.JWT_SECRET ?? 'integration-test-secret-0123456789-abcdefghijklmnop', 'ip', rateLimitIp(ip));
    await db.$executeRaw`INSERT INTO poll_attempts (kind, ip_hash, new_device) SELECT 'vote', ${ipHash}, true FROM generate_series(1, ${POLL_LIMITS.newDevices.max}::int)`;
    const dropper = new Browser(eventsApp, ip);
    const refused = await dropper.post(`${V}/votes`, {pollId: poll.id, optionIds: [poll.options[1]!.id]});
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    // A made-up cookie is no way round it.
    const forger = new Browser(eventsApp, ip);
    forger.jar.set('site_voter', crypto.randomUUID());
    expect((await forger.post(`${V}/votes`, {pollId: poll.id, optionIds: [poll.options[1]!.id]})).status).toBe(429);
    // The phone that already has its signed cookie still changes its answer.
    expect((await known.post(`${V}/votes`, {pollId: poll.id, optionIds: [poll.options[1]!.id]})).status).toBe(200);
    expect(await db.pollVote.count({where: {pollId: poll.id}})).toBe(1);
  });

  it('M-28: the database aggregate matches counting every vote in code, for every poll type', async () => {
    const choice = await openPoll('multi_choice', ['A', 'B', 'C']);
    const rating = await openPoll('rating');
    const text = await openPoll('short_text');
    const token = () => crypto.randomUUID();
    const base = Date.UTC(2026, 10, 13, 10);
    const votes = [
      ...[['A', 'B'], ['A'], ['C'], []].map((labels, i) => ({
        pollId: choice.poll.id,
        voterToken: token(),
        optionIds: labels.map(l => choice.poll.options[['A', 'B', 'C'].indexOf(l)]!.id),
        createdAt: new Date(base + i * 1000),
      })),
      ...[5, 4, 4, 1].map((ratingValue, i) => ({pollId: rating.poll.id, voterToken: token(), optionIds: [], ratingValue, createdAt: new Date(base + i * 1000)})),
      ...['first', '  ', 'third'].map((textValue, i) => ({pollId: text.poll.id, voterToken: token(), optionIds: [], textValue, createdAt: new Date(base + i * 1000)})),
    ];
    for (const v of votes) await db.pollVote.create({data: {...v, updatedAt: v.createdAt}});

    for (const {poll} of [choice, rating, text]) {
      const row = await db.poll.findUniqueOrThrow({where: {id: poll.id}, select: {id: true, type: true, status: true, pollOptions: {select: {id: true, label: true, sortOrder: true}}}});
      const got = (await resultsOfPolls(db as never, [{id: row.id, type: row.type, options: row.pollOptions}])).get(row.id);
      const mine = votes.filter(v => v.pollId === row.id).map(v => ({...v, updatedAt: v.createdAt}));
      const expected = toResultsDto(aggregateResults({id: row.id, type: row.type, status: row.status, sortOrder: 0}, row.pollOptions, mine));
      expect(got).toEqual(expected);
    }
    // The presenter list (by code) counts through the same aggregate.
    const list = (await admin.get(`${P}/event/${choice.ev.id}`)).json as {polls: {results: {totalVoters: number}}[]};
    expect(list.polls[0]!.results.totalVoters).toBe(3);
  });

  it('M-22: the CSV export pages through every vote in (created_at, id) order', async () => {
    const {poll} = await openPoll('rating');
    const when = new Date(Date.UTC(2026, 10, 13, 10));
    // Five votes, three sharing one timestamp: the id breaks the tie, none is skipped or repeated.
    for (let i = 0; i < 5; i++) {
      const at = new Date(when.getTime() + (i < 3 ? 0 : i * 1000));
      await db.pollVote.create({data: {pollId: poll.id, voterToken: crypto.randomUUID(), optionIds: [], ratingValue: 1 + i, createdAt: at, updatedAt: at}});
    }
    const seen: number[] = [];
    let pages = 0;
    for await (const page of votePages(db as never, {id: poll.id, question: 'q', type: 'rating', anonymous: true}, 2)) {
      pages++;
      seen.push(...page.map(v => v.ratingValue!));
    }
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(seen.slice(3)).toEqual([4, 5]);
    const csv = await admin.get(`${P}/${poll.id}/results.csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.json.text).trim().split('\r\n')).toHaveLength(6);
  });
});
