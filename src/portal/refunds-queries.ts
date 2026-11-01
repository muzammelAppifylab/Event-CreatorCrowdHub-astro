import {infiniteQueryOptions, queryOptions} from '@tanstack/react-query';

import {siteFetch} from '../platform/browser';
import {read} from './api';

/** Refunds to finish (`/site-api/refunds`). Keys: `['refunds', …]`. */
export type RefundRow = {id: string; guestName: string; eventId: string; eventTitle: string; amountCents: number; currency: string; since: string};
export type RefundsPage = {items: RefundRow[]; nextBefore: string | null};

const BASE = '/site-api/refunds';
const qs = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const text = q.toString();
  return text ? `?${text}` : '';
};

export const refundsQuery = infiniteQueryOptions({
  queryKey: ['refunds', 'list'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({pageParam}) => read<RefundsPage>(siteFetch(`${BASE}${qs({before: pageParam})}`)),
  getNextPageParam: last => last.nextBefore ?? undefined,
});

/** Cheap count, for the cards and badges. Pass an event id for one event. */
export const refundsCountQuery = (eventId?: string) =>
  queryOptions({
    queryKey: ['refunds', 'count', eventId ?? 'all'],
    queryFn: () => read<{count: number}>(siteFetch(`${BASE}/count${qs({eventId})}`)),
    staleTime: 30_000,
  });

export const markRefunded = (id: string) => read<{ok: true; already: boolean}>(siteFetch(`${BASE}/${encodeURIComponent(id)}/mark-refunded`, {method: 'POST'}));
