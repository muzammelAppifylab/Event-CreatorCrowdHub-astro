import {app} from '../../server/app';

/**
 * Server side of the RSVP pages: reads the RSVP routes IN-PROCESS (the same Hono app the browser
 * reaches at `/site-api/rsvp/*`). Untyped on purpose, so a page works the moment the route is
 * mounted. `null` = not reachable (503 page); `status` tells a real 404 from an outage.
 */
export async function rsvpRead<T>(request: Request, path: string): Promise<{data: T | null; status: number}> {
  try {
    const res = await app.request(new URL(`/site-api/rsvp${path}`, request.url).toString(), {
      headers: {'user-agent': request.headers.get('user-agent') ?? ''},
    });
    return {data: res.ok ? ((await res.json()) as T) : null, status: res.status};
  } catch {
    return {data: null, status: 0};
  }
}
