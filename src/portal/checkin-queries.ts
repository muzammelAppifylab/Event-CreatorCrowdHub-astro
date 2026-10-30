import {infiniteQueryOptions, queryOptions} from '@tanstack/react-query';

import {siteFetch} from '../platform/browser';
import {ApiError, read} from './api';

/**
 * Reads and writes for door check-in and event analytics. Kept in their own file (the shared
 * `queries.ts` belongs to the shell) and typed by hand, so they work whether or not the routes
 * are mounted in `app.ts` yet. Keys: `['checkin', …]`, `['analytics', …]`.
 */

export type DoorEvent = {id: string; title: string; startAt: string; endAt: string; timezone: string; format: 'in_person' | 'online' | 'hybrid'};
export type DoorGuest = {name: string; ticketCode: string; seats: number; status: string; checkedInAt: string | null};
export type DoorCounts = {checkedInSeats: number; expectedSeats: number; checkedInGuests: number; expectedGuests: number};
export type DoorList = {event: DoorEvent; guests: DoorGuest[]; counts: DoorCounts; canManage: boolean};
export type DoorToggle = {guest: DoorGuest; counts: DoorCounts};
export type Attendee = {id: string; name: string; email: string; seats: number; attended: boolean | null; checkedInAt: string | null};
export type AttendeesPage = {attendees: Attendee[]; nextBefore: string | null};
export type Ratio = {value: number | null; numerator: number; denominator: number; reason: string | null};
export type EventAnalyticsData = {
  eventId: string;
  generatedAt: string;
  ended: boolean;
  views: number;
  rsvps: {total: number; going: number; maybe: number; checkedIn: number};
  conversion: Ratio;
  showRate: Ratio;
  viewsByDay: {date: string; views: number}[];
  sources: {source: string | null; views: number; rsvps: number}[];
};

/** A Site API call with a JSON body (writes) or none (reads); throws `ApiError` with the server's words. */
export function call<T>(path: string, body?: unknown): Promise<T> {
  return read<T>(
    siteFetch(`/site-api${path}`, body === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
  );
}

export {ApiError};

export const doorEventsQuery = queryOptions({
  queryKey: ['checkin', 'events'],
  queryFn: () => call<{events: DoorEvent[]}>('/checkin/events'),
});

/** The door list for one event; `q` is in the key so a search is its own cache entry. */
export const doorListQuery = (eventId: string, q: string) =>
  queryOptions({
    queryKey: ['checkin', 'list', eventId, q],
    queryFn: () => call<DoorList>(`/checkin/events/${encodeURIComponent(eventId)}?q=${encodeURIComponent(q)}`),
  });

/** One page of confirmed guests for hand-marking online attendance (managers only). */
export const attendeesQuery = (eventId: string) =>
  infiniteQueryOptions({
    queryKey: ['checkin', 'attendees', eventId] as const,
    queryFn: ({pageParam}: {pageParam: string}) =>
      call<AttendeesPage>(`/checkin/events/${encodeURIComponent(eventId)}/attendees?before=${encodeURIComponent(pageParam)}`),
    initialPageParam: '',
    getNextPageParam: (last: AttendeesPage) => last.nextBefore ?? undefined,
  });

export const eventAnalyticsQuery = (eventId: string) =>
  queryOptions({
    queryKey: ['analytics', 'event', eventId],
    queryFn: () => call<EventAnalyticsData>(`/analytics/events/${encodeURIComponent(eventId)}`),
    staleTime: 60_000,
  });

/** "Fri 30 Oct, 18:00" in the event's own timezone: what the door staff's wall clock says. */
export function eventWhen(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone}).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

/** "18:02" in the event's timezone. */
export function doorTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit', hour12: false, timeZone}).format(new Date(iso));
  } catch {
    return '';
  }
}

/** "Gina + 1": the party the door is admitting. */
export const partyName = (guest: {name: string; seats: number}) => (guest.seats > 1 ? `${guest.name} + ${guest.seats - 1}` : guest.name);
