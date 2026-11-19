import {queryOptions} from '@tanstack/react-query';

import {pollingInterval} from '../domain/polls';
import {siteFetch} from '../platform/browser';
import {read} from './api';
import {downloadExport} from './guests-queries';

/**
 * Live polls: reads and writes for the dashboard screens (`screens/polls.tsx`, `screens/poll-presenter.tsx`).
 * Plain `siteFetch` calls to `/site-api/polls/...` (src/server/routes/admin-polls.ts), kept here so the
 * polls slice owns its own file. A save invalidates the `['polls']` key prefix.
 */

export type PollType = 'single_choice' | 'multi_choice' | 'rating' | 'short_text';
export type PollStatus = 'draft' | 'open' | 'closed';

export type PollResultsDto = {
  pollId: string;
  type: PollType;
  totalVoters: number;
  options: {id: string; label: string; count: number; percent: number}[];
  rating: {average: number | null; count: number; distribution: {value: number; count: number}[]} | null;
  textAnswers: {text: string; at: string}[];
};

export type AdminPoll = {
  id: string;
  eventId: string;
  question: string;
  type: PollType;
  status: PollStatus;
  anonymous: boolean;
  showResultsToVoters: boolean;
  openedAt: string | null;
  closedAt: string | null;
  options: {id: string; label: string}[];
  /** `null` for a draft. */
  results: PollResultsDto | null;
};

export type PollList = {
  event: {id: string; title: string; pollJoinCode: string; votePath: string; presenterPath: string};
  polls: AdminPoll[];
};

export type PollInput = {question: string; type: PollType; options: string[]; anonymous: boolean; showResultsToVoters: boolean};

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: {'content-type': 'application/json', accept: 'application/json'},
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** One event's polls, builder order (the event screen's polls tab). */
export const eventPollsQuery = (eventId: string) =>
  queryOptions({
    queryKey: ['polls', 'event', eventId],
    queryFn: () => read<PollList>(siteFetch(`/site-api/polls/event/${encodeURIComponent(eventId)}`)),
  });

/** What a presenter refresh can change on screen: each poll's status and answer count. */
export const presenterSignature = (list: PollList | undefined) =>
  (list?.polls ?? []).map(p => `${p.id}:${p.status}:${p.results?.totalVoters ?? 0}`).join('|');

/** When each presenter list last changed (by code), for the idle backoff below. */
const lastChange = new Map<string, {signature: string; at: number}>();

/**
 * The presenter's list, found by join code, short-polled while the tab is visible: every 2s while
 * answers come in, every 10s after 5 quiet minutes (`pollingInterval`, the same rule as the vote
 * page), paused while hidden. The server counts with one GROUP BY per refresh (audit M-28).
 */
export const presenterPollsQuery = (code: string) =>
  queryOptions({
    queryKey: ['polls', 'code', code],
    queryFn: async () => {
      const list = await read<PollList>(siteFetch(`/site-api/polls/by-code/${encodeURIComponent(code)}`));
      const signature = presenterSignature(list);
      if (lastChange.get(code)?.signature !== signature) lastChange.set(code, {signature, at: Date.now()});
      return list;
    },
    // Hidden tabs are paused by `refetchIntervalInBackground: false`, not here: returning `false` from a
    // fetch that lands while hidden would stop the interval for good (nothing re-evaluates it on return).
    refetchInterval: () =>
      pollingInterval({
        msSinceLastChange: Date.now() - (lastChange.get(code)?.at ?? Date.now()),
        hidden: false,
        role: 'presenter',
      }) ?? false,
    refetchIntervalInBackground: false,
  });

export const createPoll = (eventId: string, input: PollInput) =>
  read<{poll: AdminPoll}>(siteFetch(`/site-api/polls/event/${encodeURIComponent(eventId)}`, json('POST', input)));
export const updatePoll = (pollId: string, input: PollInput) =>
  read<{poll: AdminPoll}>(siteFetch(`/site-api/polls/${encodeURIComponent(pollId)}`, json('PATCH', input)));
export const reorderPolls = (eventId: string, ids: string[]) =>
  read<{ok: true}>(siteFetch(`/site-api/polls/event/${encodeURIComponent(eventId)}/order`, json('PATCH', {ids})));
export const deletePoll = (pollId: string) => read<{ok: true}>(siteFetch(`/site-api/polls/${encodeURIComponent(pollId)}`, json('DELETE')));
export const openPoll = (pollId: string) => read<{ok: true}>(siteFetch(`/site-api/polls/${encodeURIComponent(pollId)}/open`, json('POST')));
export const closePoll = (pollId: string) => read<{ok: true}>(siteFetch(`/site-api/polls/${encodeURIComponent(pollId)}/close`, json('POST')));

export const POLL_TYPE_LABELS: Record<PollType, {label: string; description: string}> = {
  single_choice: {label: 'Single choice', description: 'Guests pick one option.'},
  multi_choice: {label: 'Multiple choice', description: 'Guests pick all that apply.'},
  rating: {label: 'Rating', description: 'Guests rate from 1 to 5.'},
  short_text: {label: 'Short answer', description: 'One answer of up to 140 characters.'},
};

export const pollResultsCsvUrl = (pollId: string) => `/site-api/polls/${encodeURIComponent(pollId)}/results.csv`;

export const eventPollsCsvUrl = (eventId: string) => `/site-api/polls/event/${encodeURIComponent(eventId)}/results.csv`;

/** Downloads every poll of an event as one CSV. */
export async function exportEventPollsCsv(eventId: string, toast: {success: (m: string) => void; danger: (m: string) => void}): Promise<void> {
  try {
    const {truncated} = await downloadExport(eventPollsCsvUrl(eventId), 'poll-votes.csv');
    toast.success(truncated ? 'Exported the first 10,000 votes.' : 'Votes exported.');
  } catch (err) {
    toast.danger(err instanceof Error ? err.message : 'The export failed.');
  }
}

/** `CZ2BXC` shown as `CZ2-BXC` (the original's display); other lengths are left alone. */
export const formatJoinCode = (code: string) => (code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code);

/** Downloads a poll's votes as CSV; toasts the outcome (`downloadExport` carries the session through `siteFetch`). */
export async function exportPollCsv(pollId: string, toast: {success: (m: string) => void; danger: (m: string) => void}): Promise<void> {
  try {
    const {truncated} = await downloadExport(pollResultsCsvUrl(pollId), 'poll-votes.csv');
    toast.success(truncated ? 'Exported the first 10,000 votes.' : 'Votes exported.');
  } catch (err) {
    toast.danger(err instanceof Error ? err.message : 'The export failed.');
  }
}
