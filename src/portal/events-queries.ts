import {infiniteQueryOptions, queryOptions} from '@tanstack/react-query';
import {useNavigate} from '@tanstack/react-router';

import type {
  AdminEventDetail,
  AdminEventsPage,
  AdminTicketType,
  EventListTab,
  EventSettingsDto,
} from '../lib/event-schemas';
import {api, read} from './api';

/**
 * The admin-events reads, ONCE (same rule as `queries.ts`): a screen and its
 * route loader share the options. Kept in its own file so the events slice
 * never edits `queries.ts`; keys all start with `'events'` (list, detail,
 * tickets) or `'event-settings'`, so a save invalidates by prefix.
 */

/** `/dashboard/events`: the list of one tab, keyset paged. */
export const eventsListQuery = (tab: EventListTab) =>
  infiniteQueryOptions({
    queryKey: ['events', 'list', tab],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) => read<AdminEventsPage>(api['admin-events'].$get({query: {tab, before: pageParam ?? ''}})),
    getNextPageParam: last => last.nextBefore ?? undefined,
  });

/** `/dashboard/events/$id`: one event with its questions. */
export const eventQuery = (id: string) =>
  queryOptions({
    queryKey: ['events', 'detail', id],
    queryFn: () => read<{event: AdminEventDetail}>(api['admin-events'][':id'].$get({param: {id}})),
  });

/** The ticket types of one event. */
export const eventTicketsQuery = (id: string) =>
  queryOptions({
    queryKey: ['events', 'tickets', id],
    queryFn: () =>
      read<{ticketTypes: AdminTicketType[]; currency: string}>(api['admin-events'][':id']['ticket-types'].$get({param: {id}})),
  });

/** `/dashboard/event-settings`. */
export const eventSettingsQuery = queryOptions({
  queryKey: ['event-settings'],
  queryFn: () => read<{settings: EventSettingsDto}>(api['event-settings'].$get()),
});

/**
 * Navigate to an events screen by path, without needing the new routes to be
 * in the router's registered type yet. Paths: `/events`, `/events/new`,
 * `/events/<id>`, `/event-settings`.
 */
export function useEventsNav() {
  const navigate = useNavigate();
  return (to: string) => void (navigate as unknown as (options: {to: string}) => Promise<void>)({to});
}

/** The a11y wiring a `Field`'s control needs (what `useForm().field` gives its own fields). */
export const fieldAria = (id: string, error?: string, hint?: boolean) => ({
  'aria-invalid': error ? (true as const) : undefined,
  'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined,
});

/** After errors render, move focus to the first invalid control of a form. */
export function focusFirstInvalid(root: ParentNode | null | undefined) {
  window.setTimeout(() => root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
}
