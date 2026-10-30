import {queryOptions} from '@tanstack/react-query';

import {siteFetch} from '../platform/browser';
import {read} from './api';

export type OverviewData = {
  totals: {upcomingEvents: number; hasMore: boolean; going: number; waitlisted: number; pending: number};
  events: {id: string; title: string; startAt: string; timezone: string; capacity: number | null; going: number; waitlisted: number; pending: number}[];
  recent: {id: string; eventId: string; eventTitle: string; name: string; status: string; response: string; seats: number; createdAt: string}[];
};

/** Admin event header, owned by the events-admin agent: `GET /site-api/admin-events/:id`. Only these fields are used. */
export type HubEvent = {id: string; title: string; status: 'draft' | 'published' | 'cancelled'; startAt: string; endAt: string; slug: string; timezone?: string};

export const overviewQuery = queryOptions({
  queryKey: ['events', 'overview'],
  queryFn: () => read<OverviewData>(siteFetch('/site-api/overview')),
  staleTime: 30_000,
  retry: false,
});

export const hubEventQuery = (id: string) =>
  queryOptions({
    queryKey: ['events', 'hub-header', id],
    queryFn: async () => {
      const body = await read<HubEvent | {event: HubEvent}>(siteFetch(`/site-api/admin-events/${encodeURIComponent(id)}`));
      return 'event' in body ? body.event : body;
    },
  });
