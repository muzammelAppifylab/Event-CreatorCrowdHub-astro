import {abilitiesOf, type AbilitiesOf, codenamesOf, CORE_PERMISSIONS, definePermissions} from '../platform/auth/codenames';

/**
 * THE permission catalogue: every codename this site checks, declared ONCE.
 * Adding an entry here is the whole job (docs/agent/roles-and-permissions.md):
 *
 *   - `PERMISSIONS.<KEY>` is its codename, for `requirePermission` / `can`;
 *   - `ability` adds a flag to `/me` `abilities` (and to the `Abilities` type)
 *     for the UI: portal nav items, buttons, `pageContext()` pages;
 *   - the row reaches the `permissions` table (the roles screen) on the next
 *     signed-in request after deploy, and `roles` get it that first time only
 *     (`src/platform/permission-sync.ts`). No migration.
 *
 * Never rename or reuse a shipped codename: roles hold it by name. Browser-safe
 * (no server imports): the portal reads the `Abilities` type from here.
 */
export const CATALOGUE = definePermissions({
  ...CORE_PERMISSIONS,
  /** Create, edit and publish events, guests, invites, messages, polls, settings (). */
  EVENT_MANAGE: {
    codename: 'site:event:manage',
    title: 'Manage events',
    description: 'Create and edit events, guests, invites, messages, polls and event settings.',
    group: 'Events',
    ability: 'manageEvents',
    roles: ['admin'],
  },
  /** Check guests in at the door (). Granted to a custom 'checkin_staff' role. */
  EVENT_CHECKIN: {
    codename: 'site:event:checkin',
    title: 'Check guests in',
    description: 'Scan or search tickets and mark guests as checked in.',
    group: 'Events',
    ability: 'checkinGuests',
    roles: ['admin'],
  },
});

/** Codenames by key: `PERMISSIONS.EVENT_MANAGE` is `'site:event:manage'`. */
export const PERMISSIONS = codenamesOf(CATALOGUE);

export type Codename = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** What the UI may SHOW the visitor (`/me`); every route checks again. */
export type Abilities = AbilitiesOf<typeof CATALOGUE>;

/** The abilities a set of granted codenames gives (`/me`). */
export const abilitiesFor = (permissions: ReadonlySet<string>): Abilities => abilitiesOf(CATALOGUE, permissions);

/** A guest's abilities: every flag false. */
export const NO_ABILITIES: Abilities = abilitiesFor(new Set());
