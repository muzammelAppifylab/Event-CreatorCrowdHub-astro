/**
 * The shapes the Site API answers with. Browser-safe (no server code): pages,
 * the portal and `src/server/` all import them from here.
 *
 * Every one is OUR shape, built field by field from the platform's answers and
 * the database's rows, so nothing added later (another user's email, say)
 * reaches a page by accident.
 */

export type {Access, AdminUser, AuditRow, PermissionRow, RoleRow, Site, Viewer, ViewerState} from '../platform/types';

/** Blog posts are a content collection (Markdown): see `src/lib/posts.ts`. */

/**
 * What the UI may SHOW the visitor (every route checks again). Derived from
 * the permission catalogue: add an `ability` there, never a field here.
 */
export {type Abilities, NO_ABILITIES} from '../server/permissions';

export interface EventSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  coverImageUrl: string | null;
  coverPoster: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  format: 'in_person' | 'online' | 'hybrid';
  venueName: string | null;
  capacity: number | null;
  /** List only: the cheapest ticket (null without ticket types) and whether every ticket is free. */
  fromPrice?: {amountCents: number; currency: string} | null;
  free?: boolean;
}

export interface EventDetail extends EventSummary {
  venueAddress: string | null;
  mapUrl: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  waitlistEnabled: boolean;
}

export interface EventsPage {
  events: EventSummary[];
  next: string | null;
}
