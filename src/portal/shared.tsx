import {useQuery} from '@tanstack/react-query';
import type {ReactNode} from 'react';

import type {Abilities, Viewer} from '../lib/types';
import {meQuery, siteQuery} from './queries';

/** Data helpers every portal screen uses. The visual pieces are the kit: `./ui`. */

export const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(iso))
    : '—';

/** "3 min ago", "yesterday", "12 Oct": for activity feeds and "last seen". */
export function ago(iso: string | null): string {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', {numeric: 'auto'});
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return rtf.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return rtf.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 7 * 86_400) return rtf.format(-Math.floor(seconds / 86_400), 'day');
  return new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium'}).format(new Date(iso));
}

export interface Me {
  viewer: Viewer;
  roles: string[];
  abilities: Abilities;
}

/** Who is signed in, and what the portal may SHOW them. Shared by every screen. */
export function useMe() {
  return useQuery(meQuery);
}

/** The brand, for the sidebar. Public and cached on the server. */
export function useSite() {
  return useQuery(siteQuery);
}

/**
 * A count for a stat tile from the FIRST page of a keyset list: "12", or
 * "25+" when there are more. Never a COUNT query per request; a total that
 * must be exact comes from a counter kept in the Site Database on write.
 */
export const pageCount = (rows: unknown[] | undefined, more: boolean) =>
  rows ? `${rows.length}${more ? '+' : ''}` : null;

/**
 * May this visitor CHANGE events (create, edit, delete, send, refund, export)? A read-only
 * viewer (`viewEvents` without `manageEvents`, like the store's demo admin) opens every events
 * screen but sees no write control. Only hides: the server refuses the write with 403 anyway.
 */
export function useCanManageEvents() {
  return Boolean(useMe().data?.abilities?.manageEvents);
}

/** May this visitor SEE the events admin (read or manage)? */
export function useCanViewEvents() {
  const abilities = useMe().data?.abilities;
  return Boolean(abilities?.viewEvents || abilities?.manageEvents);
}

/** May this visitor check guests in at the door (door staff or event managers; not read-only viewers)? */
export function useCanCheckIn() {
  const abilities = useMe().data?.abilities;
  return Boolean(abilities?.checkinGuests || abilities?.manageEvents);
}

/**
 * Disables every control inside (a native `<fieldset disabled>`, laid out as if it were not there)
 * when `readOnly`: how an events form renders for a read-only viewer. Hide its Save button too.
 */
export function ReadOnly({readOnly, children}: {readOnly: boolean; children: ReactNode}) {
  return (
    <fieldset className="fieldset-contents" disabled={readOnly}>
      {children}
    </fieldset>
  );
}
