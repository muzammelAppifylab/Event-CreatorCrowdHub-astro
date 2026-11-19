import type {EventUnavailable} from '../../lib/rsvp-types';
import {app} from '../../server/app';

/**
 * `rsvpRead` for the guest's token pages (`/r/<token>`, `/i/<token>`): the same in-process read of
 * `/site-api/rsvp/*`, and also the 410 `event_unavailable` answer (a valid link whose event the host
 * unpublished or deleted), so the page can say so instead of "not found".
 * `status` 0 = the route could not be reached (503 page).
 */
export async function rsvpReadOr410<T>(
  request: Request,
  path: string
): Promise<{data: T | null; unavailable: EventUnavailable | null; status: number}> {
  try {
    const res = await app.request(new URL(`/site-api/rsvp${path}`, request.url).toString(), {
      headers: {'user-agent': request.headers.get('user-agent') ?? ''},
    });
    if (res.ok) return {data: (await res.json()) as T, unavailable: null, status: res.status};
    if (res.status === 410) {
      const body = (await res.json().catch(() => null)) as Partial<EventUnavailable> | null;
      const title = typeof body?.event?.title === 'string' ? body.event.title : '';
      return {data: null, unavailable: {error: 'event_unavailable', message: body?.message ?? '', event: {title}}, status: 410};
    }
    return {data: null, unavailable: null, status: res.status};
  } catch {
    return {data: null, unavailable: null, status: 0};
  }
}
