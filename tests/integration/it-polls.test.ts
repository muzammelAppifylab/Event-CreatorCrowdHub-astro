import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {aggregateResults, type PollType} from '../../src/domain/polls';
import {hashToken} from '../../src/domain/secureToken';
import {subjectHash} from '../../src/platform/auth/keys';
import {rateLimitIp} from '../../src/platform/auth/kit';
import {parseCsv} from '../../src/server/csv';
import {POLL_EXPORT_MAX_ROWS} from '../../src/server/routes/admin-polls';
import {POLL_LIMITS, resultsOfPolls, toResultsDto, VOTER_COOKIE} from '../../src/server/routes/polls-public';
import {env} from './support/cloudflare-workers';
import {createEvent, eventsApp, resetEvents, userWith} from './support/events-fixtures';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

/**
 * Live polls, deeper cases (audit M-3, L-9, M-28, M-22): the vote limits on `poll_attempts`, the SQL
 * aggregate against counting in code, and the keyset CSV export, through the real routes and SQL.
 */
const P = '/site-api/admin-polls';
type PollDto = {id: string; question: string; options: {id: string; label: string}[]};
type Answer = Awaited<ReturnType<Browser['post']>>;

const ipHashOf = (ip: string) => subjectHash(env.JWT_SECRET!, 'ip', rateLimitIp(ip));

/** The IP has already used `n` attempts of this kind in the window (rows written straight to the table). */
async function spend(ip: string, n: number, newDevice: boolean) {
  const ipHash = await ipHashOf(ip);
  await db.$executeRaw`INSERT INTO poll_attempts (kind, ip_hash, new_device) SELECT 'vote', ${ipHash}, ${newDevice} FROM generate_series(1, ${n}::int)`;
}

/** Deterministic pseudo-random numbers (mulberry32), so a failure can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const csvRows = (res: Answer) => parseCsv(String(res.json.text));

describe.skipIf(!DATABASE_URL)('polls: limits, aggregate and export (integration, real Postgres)', () => {
  let admin: Browser;

  beforeAll(async () => {
    configureEnv();
    const [row] = await db.$queryRaw<{t: string | null}[]>`SELECT to_regclass('poll_attempts')::text AS t`;
    if (!row?.t) throw new Error('poll_attempts is missing: migrate the test database first');
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await resetEvents();
    await db.$executeRawUnsafe('TRUNCATE "poll_attempts"');
    admin = await userWith('admin@example.test', ['admin'], '203.0.113.2');
  });

  async function newPoll(eventId: string, type: PollType, options: string[] = [], over: Record<string, unknown> = {}) {
    const res = await admin.post(`${P}/event/${eventId}`, {question: `${type} question?`, type, options, ...over});
    expect(res.status).toBe(201);
    return res.json.poll as PollDto;
  }

  async function open(pollId: string) {
    expect((await admin.post(`${P}/${pollId}/open`)).status).toBe(200);
  }

  async function openPoll(type: PollType, options: string[] = [], over: Record<string, unknown> = {}) {
    const ev = await createEvent(admin);
    const poll = await newPoll(ev.id, type, options, over);
    await open(poll.id);
    const code = (await db.event.findUniqueOrThrow({where: {id: ev.id}})).pollJoinCode;
    return {ev, poll, code, V: `/site-api/polls-public/${code}`};
  }

  const vote = (b: Browser, V: string, body: Record<string, unknown>) => b.post(`${V}/votes`, body);
  const voterCookie = (b: Browser) => b.jar.get(VOTER_COOKIE);

  /* ── vote limits ─────────────────────────────────────────────────────── */

  it('60 phones on one IP, each with its own valid cookie, change their answer at the same moment: all accepted', async () => {
    const {poll, V} = await openPoll('single_choice', ['Yes', 'No']);
    const ip = '198.51.100.20';
    const phones = Array.from({length: 60}, () => new Browser(eventsApp, ip));
    await Promise.all(phones.map(p => p.get('/site-api/auth/csrf')));

    // First answers at once: 60 new devices, well under the new-device limit.
    const first = await Promise.all(phones.map(p => vote(p, V, {pollId: poll.id, optionIds: [poll.options[0]!.id]})));
    expect(first.map(a => a.status)).toEqual(Array(60).fill(200));
    const cookies = phones.map(voterCookie);
    expect(cookies.every(c => typeof c === 'string' && /^[0-9a-f-]{36}\.[0-9a-f]{32}$/.test(c))).toBe(true);
    expect(new Set(cookies).size).toBe(60);

    // The IP's new-device budget is now spent: only signed cookies can still vote.
    await spend(ip, POLL_LIMITS.newDevices.max, true);
    const before = await db.$queryRaw<{n: number}[]>`SELECT COUNT(*)::int AS n FROM poll_attempts WHERE new_device`;

    const second = await Promise.all(phones.map((p, i) => vote(p, V, {pollId: poll.id, optionIds: [poll.options[i % 2]!.id]})));
    expect(second.map(a => a.status)).toEqual(Array(60).fill(200));
    // Same devices: no new cookie, no new ballot, no new-device attempt recorded.
    expect(phones.map(voterCookie)).toEqual(cookies);
    expect(await db.pollVote.count({where: {pollId: poll.id}})).toBe(60);
    const after = await db.$queryRaw<{n: number}[]>`SELECT COUNT(*)::int AS n FROM poll_attempts WHERE new_device`;
    expect(after[0]!.n).toBe(before[0]!.n);

    const results = (await admin.get(`${P}/${poll.id}/results`)).json as {totalVoters: number; options: {count: number; percent: number}[]};
    expect(results.totalVoters).toBe(60);
    expect(results.options.map(o => o.count)).toEqual([30, 30]);
    expect(results.options.map(o => o.percent)).toEqual([50, 50]);

    // A 61st phone with no cookie is a new device, over the limit.
    const late = await vote(new Browser(eventsApp, ip), V, {pollId: poll.id, optionIds: [poll.options[0]!.id]});
    expect(late.status).toBe(429);
  });

  it('no cookie, a made-up cookie, a moved or edited tag: all over the new-device limit (429); a known device still votes', async () => {
    const {poll, V} = await openPoll('single_choice', ['Yes', 'No']);
    const ip = '198.51.100.21';
    const known = new Browser(eventsApp, ip);
    expect((await vote(known, V, {pollId: poll.id, optionIds: [poll.options[0]!.id]})).status).toBe(200);
    const good = voterCookie(known)!;
    const [token, tag] = good.split('.') as [string, string];

    await spend(ip, POLL_LIMITS.newDevices.max, true);

    const flipped = tag.slice(0, -1) + (tag.endsWith('0') ? '1' : '0');
    const forged: (string | null)[] = [
      null, // no cookie at all
      crypto.randomUUID(), // a bare uuid, the old unsigned format
      `${crypto.randomUUID()}.${'0'.repeat(32)}`, // a made-up tag
      `${crypto.randomUUID()}.${tag}`, // a real tag moved onto another token
      `${token}.${flipped}`, // the real token with one character of its tag changed
      `${token}.${tag}0`, // too long
      `${token}.`, // tag dropped
      'not-a-uuid.' + tag,
    ];
    for (const value of forged) {
      const b = new Browser(eventsApp, ip);
      if (value !== null) b.jar.set(VOTER_COOKIE, value);
      const res = await vote(b, V, {pollId: poll.id, optionIds: [poll.options[1]!.id]});
      expect(res.status, `cookie ${value === null ? '(none)' : value.slice(0, 12)}…`).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBe(POLL_LIMITS.newDevices.retryAfter);
      // Refused before anything: no ballot, no cookie minted.
      expect(b.jar.get(VOTER_COOKIE) ?? null).toBe(value);
    }

    // The same new-device limit is per IP: a fresh phone elsewhere is fine.
    expect((await vote(new Browser(eventsApp, '198.51.100.99'), V, {pollId: poll.id, optionIds: [poll.options[1]!.id]})).status).toBe(200);
    // The phone holding its signed cookie still changes its answer, on the same ballot.
    expect((await vote(known, V, {pollId: poll.id, optionIds: [poll.options[1]!.id]})).status).toBe(200);
    expect(voterCookie(known)).toBe(good);
    expect(await db.pollVote.count({where: {pollId: poll.id}})).toBe(2);
    const mine = await db.pollVote.findUniqueOrThrow({where: {pollId_voterToken: {pollId: poll.id, voterToken: token}}, select: {optionIds: true}});
    expect(mine.optionIds).toEqual([poll.options[1]!.id]);
  });

  it('a forged or moved voter cookie, under the limit, is a NEW device: a new signed cookie, a new ballot, counted as new', async () => {
    const {poll, V} = await openPoll('single_choice', ['Yes', 'No']);
    const ip = '198.51.100.22';
    const ipHash = await ipHashOf(ip);
    const a = new Browser(eventsApp, ip);
    expect((await vote(a, V, {pollId: poll.id, optionIds: [poll.options[0]!.id]})).status).toBe(200);
    const [tokenA, tagA] = voterCookie(a)!.split('.') as [string, string];

    const cases = [`${crypto.randomUUID()}.${tagA}`, crypto.randomUUID(), `${tokenA}.${'f'.repeat(32)}`];
    for (const [i, value] of cases.entries()) {
      const b = new Browser(eventsApp, ip);
      b.jar.set(VOTER_COOKIE, value);
      const res = await vote(b, V, {pollId: poll.id, optionIds: [poll.options[1]!.id]});
      expect(res.status).toBe(200);
      const minted = voterCookie(b)!;
      expect(minted).not.toBe(value);
      expect(minted).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{32}$/);
      // The forged token is never the ballot: a third tag on A's own token must not touch A's vote.
      expect(minted.split('.')[0]).not.toBe(tokenA);
      expect(await db.pollVote.count({where: {pollId: poll.id}})).toBe(2 + i);
    }
    const a0 = await db.pollVote.findUniqueOrThrow({where: {pollId_voterToken: {pollId: poll.id, voterToken: tokenA}}, select: {optionIds: true}});
    expect(a0.optionIds).toEqual([poll.options[0]!.id]);
    const fresh = await db.$queryRaw<{n: number}[]>`SELECT COUNT(*)::int AS n FROM poll_attempts WHERE kind = 'vote' AND ip_hash = ${ipHash} AND new_device`;
    expect(fresh[0]!.n).toBe(1 + cases.length);

    // A's real cookie copied to another phone is A's ballot (a bearer cookie): no new device, no new row.
    const copy = new Browser(eventsApp, '198.51.100.23');
    copy.jar.set(VOTER_COOKIE, `${tokenA}.${tagA}`);
    expect((await vote(copy, V, {pollId: poll.id, optionIds: [poll.options[1]!.id]})).status).toBe(200);
    expect(await db.pollVote.count({where: {pollId: poll.id}})).toBe(1 + cases.length);
  });

  it('per device: 30 votes a minute, the 31st is 429 with Retry-After; other phones on the IP are unaffected; the window passes', async () => {
    const {poll, V} = await openPoll('single_choice', ['Yes', 'No']);
    const ip = '198.51.100.24';
    const phone = new Browser(eventsApp, ip);
    for (let i = 0; i < POLL_LIMITS.deviceVotes.max; i++) {
      const res = await vote(phone, V, {pollId: poll.id, optionIds: [poll.options[i % 2]!.id]});
      expect(res.status, `vote ${i + 1}`).toBe(200);
    }
    const over = await vote(phone, V, {pollId: poll.id, optionIds: [poll.options[0]!.id]});
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBe(POLL_LIMITS.deviceVotes.retryAfter);
    expect(JSON.stringify(over.json)).toMatch(/very fast/);
    // A bad answer is still an attempt, but a refused one is not recorded.
    const attempts = await db.$queryRaw<{n: number}[]>`SELECT COUNT(*)::int AS n FROM poll_attempts WHERE kind = 'vote'`;
    expect(attempts[0]!.n).toBe(POLL_LIMITS.deviceVotes.max);

    const other = new Browser(eventsApp, ip);
    expect((await vote(other, V, {pollId: poll.id, optionIds: [poll.options[1]!.id]})).status).toBe(200);

    // A minute later the device may vote again.
    await db.$executeRaw`UPDATE poll_attempts SET created_at = created_at - interval '2 minutes'`;
    expect((await vote(phone, V, {pollId: poll.id, optionIds: [poll.options[1]!.id]})).status).toBe(200);
    expect(await db.pollVote.count({where: {pollId: poll.id}})).toBe(2);
  });

  it('per IP: 600 votes in 10 minutes stops even a known device; older attempts do not count', async () => {
    const {poll, V} = await openPoll('rating');
    const ip = '198.51.100.25';
    const phone = new Browser(eventsApp, ip);
    expect((await vote(phone, V, {pollId: poll.id, ratingValue: 3})).status).toBe(200);
    await spend(ip, POLL_LIMITS.ipVotes.max, false);
    const res = await vote(phone, V, {pollId: poll.id, ratingValue: 4});
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBe(POLL_LIMITS.ipVotes.retryAfter);
    await db.$executeRaw`UPDATE poll_attempts SET created_at = created_at - interval '11 minutes'`;
    expect((await vote(phone, V, {pollId: poll.id, ratingValue: 4})).status).toBe(200);
  });

  /* ── aggregate ───────────────────────────────────────────────────────── */

  type Row = {pollId: string; voterToken: string; optionIds: unknown; ratingValue: number | null; textValue: string | null; createdAt: Date; updatedAt: Date};

  async function insertVotes(rows: Row[]) {
    await db.pollVote.createMany({data: rows.map(r => ({...r, optionIds: r.optionIds as never}))});
  }

  /** What counting every vote in code gives, through the domain's own `aggregateResults`. */
  async function expectedFor(pollId: string, rows: Row[]) {
    const p = await db.poll.findUniqueOrThrow({where: {id: pollId}, select: {id: true, type: true, status: true, pollOptions: {select: {id: true, label: true, sortOrder: true}}}});
    const mine = rows
      .filter(r => r.pollId === pollId)
      .map(r => ({...r, optionIds: Array.isArray(r.optionIds) ? (r.optionIds as string[]) : []}));
    return {
      poll: {id: p.id, type: p.type, options: p.pollOptions},
      expected: toResultsDto(aggregateResults({id: p.id, type: p.type, status: p.status, sortOrder: 0}, p.pollOptions, mine)),
    };
  }

  it('the SQL aggregate equals counting in code: single, multiple, rating and short text, on every route that shows it', async () => {
    const ev = await createEvent(admin);
    const single = await newPoll(ev.id, 'single_choice', ['Red', 'Green', 'Blue', 'Gold']);
    const multi = await newPoll(ev.id, 'multi_choice', ['A', 'B', 'C', 'D', 'E']);
    const rating = await newPoll(ev.id, 'rating');
    const text = await newPoll(ev.id, 'short_text');
    const elsewhere = await openPoll('single_choice', ['X', 'Y']); // another event's poll: never counted here
    await open(single.id);

    const rand = rng(20261113);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const base = Date.UTC(2026, 10, 13, 9);
    let tick = 0;
    const at = () => new Date(base + ++tick * 1000);
    const row = (pollId: string, over: Partial<Row>): Row => {
      const when = at();
      return {pollId, voterToken: crypto.randomUUID(), optionIds: [], ratingValue: null, textValue: null, createdAt: when, updatedAt: when, ...over};
    };
    const ghost = crypto.randomUUID();
    const rows: Row[] = [];
    for (let i = 0; i < 157; i++) rows.push(row(single.id, {optionIds: [pick(single.options).id]}));
    // Votes that must not count: an unknown option, another poll's option, nothing chosen, not an array.
    rows.push(row(single.id, {optionIds: [ghost]}), row(single.id, {optionIds: [elsewhere.poll.options[0]!.id]}), row(single.id, {optionIds: []}), row(single.id, {optionIds: {a: 1}}));
    for (let i = 0; i < 211; i++) {
      const chosen = multi.options.filter(() => rand() < 0.4).map(o => o.id);
      // Repeats and strangers inside one vote: each option counts once, strangers never.
      if (chosen.length && rand() < 0.2) chosen.push(chosen[0]!);
      if (rand() < 0.1) chosen.push(ghost);
      rows.push(row(multi.id, {optionIds: chosen}));
    }
    for (let i = 0; i < 173; i++) rows.push(row(rating.id, {ratingValue: 1 + Math.floor(rand() * 5)}));
    // (Out-of-range values are refused by the poll_votes_rating_range check, so only a missing one here.)
    rows.push(row(rating.id, {ratingValue: null}), row(rating.id, {ratingValue: null}));
    for (let i = 0; i < 47; i++) rows.push(row(text.id, {textValue: rand() < 0.15 ? '   ' : `  answer ${i}, "quoted" ${pick(['ok', 'fine', 'great'])}  `}));
    rows.push(row(text.id, {textValue: null}), row(text.id, {textValue: ''}));
    rows.push(row(elsewhere.poll.id, {optionIds: [elsewhere.poll.options[1]!.id]}));
    await insertVotes(rows);

    const all = await Promise.all([single, multi, rating, text].map(p => expectedFor(p.id, rows)));
    // Sanity: the data really exercises each type.
    expect(all[0]!.expected.totalVoters).toBe(157);
    expect(all[1]!.expected.totalVoters).toBeGreaterThan(150);
    expect(all[2]!.expected.rating!.count).toBe(173);
    await expect(insertVotes([row(rating.id, {ratingValue: 6})])).rejects.toThrow(/poll_votes_rating_range/);
    expect(all[3]!.expected.textAnswers).toHaveLength(20);

    // 1. The aggregate itself, every poll in one statement.
    const got = await resultsOfPolls(db as never, all.map(a => a.poll));
    for (const a of all) expect(got.get(a.poll.id)).toEqual(a.expected);
    // 2. One poll's results (admin).
    for (const a of all) expect((await admin.get(`${P}/${a.poll.id}/results`)).json).toEqual(a.expected);
    // 3. The presenter list, by event and by join code.
    const code = (await db.event.findUniqueOrThrow({where: {id: ev.id}})).pollJoinCode;
    const byEvent = (await admin.get(`${P}/event/${ev.id}`)).json as {polls: {id: string; status: string; results: unknown}[]};
    const byCode = (await admin.get(`${P}/by-code/${code}`)).json as {polls: {id: string; status: string; results: unknown}[]};
    for (const list of [byEvent, byCode]) {
      expect(list.polls.map(p => p.id).sort()).toEqual(all.map(a => a.poll.id).sort());
      const open1 = list.polls.find(p => p.id === single.id)!;
      expect(open1.results).toEqual(all[0]!.expected);
      for (const p of list.polls.filter(x => x.status === 'draft')) expect(p.results).toBeNull();
    }
    // 4. The guests' view of the open poll.
    expect((await new Browser(eventsApp, '198.51.100.30').get(`/site-api/polls-public/${code}/results`)).json).toEqual(all[0]!.expected);
  });

  // The vote route never writes such a row; the SQL still counts only the first known option, as code does.
  it('a single-choice row holding two options counts once, as in code', async () => {
    const ev = await createEvent(admin);
    const single = await newPoll(ev.id, 'single_choice', ['Red', 'Green']);
    const when = new Date(Date.UTC(2026, 10, 13, 9));
    const rows: Row[] = [{pollId: single.id, voterToken: crypto.randomUUID(), optionIds: [single.options[1]!.id, single.options[0]!.id], ratingValue: null, textValue: null, createdAt: when, updatedAt: when}];
    await insertVotes(rows);
    const {poll, expected} = await expectedFor(single.id, rows);
    expect((await resultsOfPolls(db as never, [poll])).get(single.id)).toEqual(expected);
  });

  // The vote route stores trimmed text; the SQL still trims what JS trim() strips (tabs, newlines), not only spaces.
  it('a whitespace-only text answer (tabs, newlines) is not counted, as in code', async () => {
    const ev = await createEvent(admin);
    const text = await newPoll(ev.id, 'short_text');
    const when = new Date(Date.UTC(2026, 10, 13, 9));
    const rows: Row[] = ['\t', '\n \r\n', ' \tpadded\t '].map((textValue, i) => ({
      pollId: text.id,
      voterToken: crypto.randomUUID(),
      optionIds: [],
      ratingValue: null,
      textValue,
      createdAt: new Date(when.getTime() + i),
      updatedAt: new Date(when.getTime() + i),
    }));
    await insertVotes(rows);
    const {poll, expected} = await expectedFor(text.id, rows);
    expect((await resultsOfPolls(db as never, [poll])).get(text.id)).toEqual(expected);
  });

  /* ── CSV export ──────────────────────────────────────────────────────── */

  /** `n` text votes inserted in ONE statement: they all share one created_at (and updated_at). */
  async function bulkText(pollId: string, n: number, prefix: string) {
    await db.$executeRaw`INSERT INTO poll_votes (poll_id, voter_token, text_value, created_at, updated_at)
      SELECT ${pollId}::uuid, gen_random_uuid(), ${prefix} || lpad(g::text, 6, '0'), now(), now() FROM generate_series(1, ${n}::int) g`;
    const [stamps] = await db.$queryRaw<{n: number}[]>`SELECT COUNT(DISTINCT created_at)::int AS n FROM poll_votes WHERE poll_id = ${pollId}::uuid`;
    expect(stamps!.n).toBe(1);
  }
  const expectedAnswers = (n: number, prefix: string) => Array.from({length: n}, (_, i) => `${prefix}${String(i + 1).padStart(6, '0')}`);

  it('poll CSV: 2,345 votes sharing one created_at, every vote exactly once, and the export ends', async () => {
    const {poll} = await openPoll('short_text');
    await bulkText(poll.id, 2345, 'v');
    const res = await withDeadline(admin.get(`${P}/${poll.id}/results.csv`), 20_000, 'the CSV export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('x-export-truncated')).toBe('0');
    const [header, ...data] = csvRows(res);
    // Anonymous by default: no email column.
    expect(header).toEqual(['Poll', 'Answer', 'Submitted at (UTC)']);
    expect(data).toHaveLength(2345);
    const answers = data.map(r => r[1]!);
    expect(new Set(answers).size).toBe(2345);
    expect([...answers].sort()).toEqual(expectedAnswers(2345, 'v'));
    const audits = await db.$queryRaw<{n: number}[]>`SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'poll_results_exported'`;
    expect(audits[0]!.n).toBe(1);
  });

  it('poll CSV: exactly two full pages (2,000 votes, one created_at) ends without a repeat', async () => {
    const {poll} = await openPoll('short_text');
    await bulkText(poll.id, 2000, 'w');
    const res = await withDeadline(admin.get(`${P}/${poll.id}/results.csv`), 20_000, 'the CSV export');
    const data = csvRows(res).slice(1);
    expect(data.map(r => r[1]!).sort()).toEqual(expectedAnswers(2000, 'w'));
  });

  it('event CSV: several polls, each over a page with one shared created_at, every vote once in builder order', async () => {
    const ev = await createEvent(admin);
    const first = await newPoll(ev.id, 'short_text', [], {question: 'First?'});
    const second = await newPoll(ev.id, 'short_text', [], {question: 'Second?', anonymous: false});
    await bulkText(first.id, 1001, 'a');
    await bulkText(second.id, 1500, 'b');
    const res = await withDeadline(admin.get(`${P}/event/${ev.id}/results.csv`), 20_000, 'the event CSV export');
    expect(res.status).toBe(200);
    const [header, ...data] = csvRows(res);
    expect(header).toEqual(['Poll', 'Answer', 'Submitted at (UTC)', 'Guest email']);
    expect(data).toHaveLength(2501);
    expect(data.slice(0, 1001).every(r => r[0] === 'First?')).toBe(true);
    expect(data.slice(1001).every(r => r[0] === 'Second?')).toBe(true);
    expect(data.slice(0, 1001).map(r => r[1]!).sort()).toEqual(expectedAnswers(1001, 'a'));
    expect(data.slice(1001).map(r => r[1]!).sort()).toEqual(expectedAnswers(1500, 'b'));
  });

  it(
    'poll CSV over the cap: 20,001 votes in one statement give exactly 20,000 distinct rows and X-Export-Truncated: 1',
    async () => {
      const {poll} = await openPoll('short_text');
      await bulkText(poll.id, POLL_EXPORT_MAX_ROWS + 1, 't');
      const res = await withDeadline(admin.get(`${P}/${poll.id}/results.csv`), 90_000, 'the capped CSV export');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-export-truncated')).toBe('1');
      const answers = csvRows(res).slice(1).map(r => r[1]!);
      expect(answers).toHaveLength(POLL_EXPORT_MAX_ROWS);
      expect(new Set(answers).size).toBe(POLL_EXPORT_MAX_ROWS);
      const all = new Set(expectedAnswers(POLL_EXPORT_MAX_ROWS + 1, 't'));
      expect(answers.every(a => all.has(a))).toBe(true);
    },
    120_000
  );

  it('anonymous polls never put a guest email in a CSV, even for a vote linked to an RSVP; named polls do', async () => {
    const {ev, poll: anon, V} = await openPoll('single_choice', ['Yes', 'No']);
    const named = await newPoll(ev.id, 'single_choice', ['Up', 'Down'], {question: 'Named?', anonymous: false});
    const raw = `manage-${crypto.randomUUID()}`;
    const guest = await db.rsvp.create({
      data: {eventId: ev.id, name: 'Guest One', email: 'guest.one@example.test', response: 'going', status: 'confirmed', ticketCode: 'TKT00001', manageToken: hashToken(raw)},
      select: {id: true},
    });
    const phone = new Browser(eventsApp, '198.51.100.40');

    // Through the route: the guest link names the RSVP, but the anonymous poll drops it.
    expect((await vote(phone, V, {pollId: anon.id, optionIds: [anon.options[0]!.id], g: raw})).status).toBe(200);
    const anonVote = await db.pollVote.findFirstOrThrow({where: {pollId: anon.id}, select: {rsvpId: true}});
    expect(anonVote.rsvpId).toBeNull();
    await open(named.id);
    expect((await vote(phone, V, {pollId: named.id, optionIds: [named.options[1]!.id], g: raw})).status).toBe(200);
    const namedVote = await db.pollVote.findFirstOrThrow({where: {pollId: named.id}, select: {rsvpId: true}});
    expect(namedVote.rsvpId).toBe(guest.id);

    // An anonymous poll's row that IS linked (older data): still no email anywhere.
    const when = new Date();
    await db.pollVote.create({data: {pollId: anon.id, voterToken: crypto.randomUUID(), optionIds: [anon.options[1]!.id], rsvpId: guest.id, createdAt: when, updatedAt: when}});

    const anonCsv = await admin.get(`${P}/${anon.id}/results.csv`);
    expect(anonCsv.status).toBe(200);
    const anonText = String(anonCsv.json.text);
    expect(anonText).not.toContain('@');
    expect(anonText).not.toContain('Guest email');
    expect(csvRows(anonCsv).slice(1)).toHaveLength(2);

    const namedRows = csvRows(await admin.get(`${P}/${named.id}/results.csv`));
    expect(namedRows[0]).toEqual(['Poll', 'Answer', 'Submitted at (UTC)', 'Guest email']);
    expect(namedRows.slice(1).map(r => [r[1], r[3]])).toEqual([['Down', 'guest.one@example.test']]);

    const eventRows = csvRows(await admin.get(`${P}/event/${ev.id}/results.csv`)).slice(1);
    expect(eventRows).toHaveLength(3);
    for (const r of eventRows.filter(r => r[0] === anon.question)) expect(r[3]).toBe('');
    expect(eventRows.filter(r => r[0] === 'Named?').map(r => r[3])).toEqual(['guest.one@example.test']);
  });
});
