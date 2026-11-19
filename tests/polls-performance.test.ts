import {Hono} from 'hono';
import {getCookie} from 'hono/cookie';
import {describe, expect, it} from 'vitest';

import {aggregateResults} from '../src/domain/polls';
import {voteRetryDelay, VOTE_RETRIES} from '../src/lib/poll-client';
import * as constants from '../src/lib/poster-constants';
import * as schemas from '../src/lib/event-schemas';
import {presenterSignature, type PollList} from '../src/portal/polls-queries';
import {mintVoterToken, readVoterToken, resultsFromRows, toResultsDto, type AggRow} from '../src/server/routes/polls-public';

const SECRET = 's'.repeat(40);

describe('poster constants (M-30)', () => {
  it('match the server validation, with no imports of their own', async () => {
    expect(constants.POSTER_DESIGNS).toEqual(schemas.POSTER_DESIGNS);
    expect(constants.POSTER_PALETTES).toEqual(schemas.POSTER_PALETTES);
    expect(constants.POSTER_HEX.source).toBe(schemas.POSTER_HEX.source);
    const {readFileSync} = await import('node:fs');
    expect(readFileSync('src/lib/poster-constants.ts', 'utf8')).not.toMatch(/^import /m);
    expect(readFileSync('src/lib/posters.ts', 'utf8')).not.toMatch(/^import \{[^}]*\} from '\.\/event-schemas'/m);
  });
});

describe('vote retry (M-3)', () => {
  it('retries 429/503 after Retry-After plus jitter, a bounded number of times', () => {
    expect(voteRetryDelay(429, '1', 0, () => 0.5)).toBe(1750);
    expect(voteRetryDelay(503, null, 0, () => 0)).toBe(1000);
    expect(voteRetryDelay(429, '10', 1, () => 0)).toBe(10_000);
    expect(voteRetryDelay(429, '1', VOTE_RETRIES)).toBeNull();
    expect(voteRetryDelay(429, '30', 0)).toBeNull(); // a long wait is shown, not sat through
    expect(voteRetryDelay(422, '1', 0)).toBeNull();
    expect(voteRetryDelay(409, null, 0)).toBeNull();
    expect(voteRetryDelay(429, 'soon', 0)).toBeNull();
  });
});

describe('signed voter cookie (L-9)', () => {
  const app = new Hono()
    .post('/mint', async c => c.json({token: await mintVoterToken(c, SECRET)}))
    .get('/read', async c => c.json({token: await readVoterToken(c, SECRET), raw: getCookie(c, 'site_voter') ?? null}));
  const read = async (cookie: string) => (await (await app.request('/read', {headers: {cookie}})).json()).token as string | null;

  it('only a token this server minted counts as a known device', async () => {
    const res = await app.request('/mint', {method: 'POST'});
    const {token} = (await res.json()) as {token: string};
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(cookie).toMatch(/^site_voter=[0-9a-f-]{36}\.[0-9a-f]{32}$/);
    expect(await read(cookie)).toBe(token);
    // A made-up uuid, an old unsigned cookie, or a tag moved to another uuid: a new device.
    expect(await read(`site_voter=${crypto.randomUUID()}`)).toBeNull();
    expect(await read(`site_voter=${crypto.randomUUID()}.${cookie.split('.')[1]}`)).toBeNull();
    expect(await read(`site_voter=${token}.${'0'.repeat(32)}`)).toBeNull();
    expect(await read(`${cookie}x`)).toBeNull();
  });
});

describe('results from the aggregate (M-28)', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 10, 0, s));
  const options = [
    {id: 'o1', label: 'A', sortOrder: 0},
    {id: 'o2', label: 'B', sortOrder: 1},
    {id: 'o3', label: 'C', sortOrder: 2},
  ];
  const row = (poll: string, kind: AggRow['kind'], key: string | null, n: number, text: string | null = null, when: Date | null = null): AggRow => ({
    kind,
    poll_id: poll,
    key,
    n,
    text,
    at: when,
  });

  it('gives the same answer as counting the votes in code', () => {
    const choice = resultsFromRows(
      [{id: 'c', type: 'multi_choice', options}],
      [row('c', 'o', 'o1', 2), row('c', 'o', 'o2', 1), row('c', 'v', null, 2)]
    ).get('c')!;
    const expected = toResultsDto(
      aggregateResults({id: 'c', type: 'multi_choice', status: 'open', sortOrder: 0}, options, [
        {voterToken: 'a', optionIds: ['o1', 'o2'], createdAt: at(1)},
        {voterToken: 'b', optionIds: ['o1'], createdAt: at(2)},
      ])
    );
    expect(choice).toEqual(expected);

    const rating = resultsFromRows([{id: 'r', type: 'rating', options: []}], [row('r', 'r', '5', 2), row('r', 'r', '2', 1)]).get('r')!;
    expect(rating).toEqual(
      toResultsDto(
        aggregateResults({id: 'r', type: 'rating', status: 'open', sortOrder: 0}, [], [
          {voterToken: 'a', optionIds: [], ratingValue: 5, createdAt: at(1)},
          {voterToken: 'b', optionIds: [], ratingValue: 5, createdAt: at(2)},
          {voterToken: 'c', optionIds: [], ratingValue: 2, createdAt: at(3)},
        ])
      )
    );

    const text = resultsFromRows(
      [{id: 't', type: 'short_text', options: []}],
      [row('t', 'tn', null, 2), row('t', 't', null, 0, 'older', at(1)), row('t', 't', null, 0, 'newer', at(5))]
    ).get('t')!;
    expect(text.totalVoters).toBe(2);
    expect(text.textAnswers.map(a => a.text)).toEqual(['newer', 'older']);
    expect(text.textAnswers[0]!.at).toBe(at(5).toISOString());
  });

  it('a poll with no votes has zeros, never a missing entry', () => {
    const empty = resultsFromRows([{id: 'x', type: 'single_choice', options}], []).get('x')!;
    expect(empty.totalVoters).toBe(0);
    expect(empty.options.map(o => [o.count, o.percent])).toEqual([[0, 0], [0, 0], [0, 0]]);
  });
});

describe('presenter refresh (M-28)', () => {
  it('changes only when a status or an answer count changes', () => {
    const list = (status: string, voters: number) =>
      ({event: {}, polls: [{id: 'p', status, results: {totalVoters: voters}}]}) as unknown as PollList;
    expect(presenterSignature(list('open', 3))).toBe(presenterSignature(list('open', 3)));
    expect(presenterSignature(list('open', 3))).not.toBe(presenterSignature(list('open', 4)));
    expect(presenterSignature(list('open', 3))).not.toBe(presenterSignature(list('closed', 3)));
  });
});
