import {infiniteQueryOptions, queryOptions, useMutation, useQueryClient} from '@tanstack/react-query';
import {useNavigate} from '@tanstack/react-router';

import type {
  AdminEventDetail,
  AdminEventsPage,
  CancelPreview,
  AdminTicketType,
  EventListTab,
  EventSettingsDto,
} from '../lib/event-schemas';
import {siteFetch} from '../platform/browser';
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

// ------------------------------------------------------------ lifecycle --

/** Who a cancellation affects (guests to email, orders to refund); fetched when the dialog opens. */
export const cancelPreviewQuery = (id: string) =>
  queryOptions({
    queryKey: ['events', 'cancel-preview', id],
    queryFn: () => read<CancelPreview>(siteFetch(`/site-api/admin-events/${encodeURIComponent(id)}/cancel-preview`)),
    gcTime: 0,
    retry: false,
  });

const lifecycle = (id: string, action: 'publish' | 'unpublish' | 'cancel') =>
  read<{event: AdminEventDetail}>(siteFetch(`/site-api/admin-events/${encodeURIComponent(id)}/${action}`, {method: 'POST'}));

/** publish / unpublish / cancel / duplicate / delete: each invalidates every `['events', …]` read. */
export function useEventLifecycle() {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({queryKey: ['events']});
  return {
    publish: useMutation({mutationFn: (id: string) => lifecycle(id, 'publish'), onSuccess}),
    unpublish: useMutation({mutationFn: (id: string) => lifecycle(id, 'unpublish'), onSuccess}),
    cancel: useMutation({mutationFn: (id: string) => lifecycle(id, 'cancel'), onSuccess}),
    duplicate: useMutation({
      mutationFn: ({id, ...body}: {id: string; startAt: string; endAt: string; title: string}) =>
        read<{event: AdminEventDetail}>(
          siteFetch(`/site-api/admin-events/${encodeURIComponent(id)}/duplicate`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(body),
          })
        ),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: string) => read<unknown>(siteFetch(`/site-api/admin-events/${encodeURIComponent(id)}`, {method: 'DELETE'})),
      onSuccess,
    }),
  };
}
