import {abilitiesOf, type AbilitiesOf, codenamesOf, CORE_PERMISSIONS, definePermissions} from '../platform/auth/codenames';

/**
 * THE permission catalogue: every codename this site checks, declared ONCE.
 * Adding a permission is one entry here, plus its line in tests/permissions.test.ts
 * (docs/agent/roles-and-permissions.md):
 *
 *   - `PERMISSIONS.<KEY>` is its codename, for `requirePermission` / `can`;
 *   - `ability` adds a flag to `/me` `abilities` (and to the `Abilities` type)
 *     for the UI: portal nav items, buttons, `pageContext()` pages;
 *   - the row reaches the `permissions` table (the roles screen) on the next
 *     signed-in request after deploy, and `roles` get it that first time only
 *     (`src/platform/permission-sync.ts`). No migration.
 *   - tests/permissions.test.ts lists every shipped codename and ability, so
 *     `npm test` fails until you add the new one there too (on purpose: a
 *     renamed or lost permission never slips through).
 *
 * Never rename or reuse a shipped codename: roles hold it by name. Browser-safe
 * (no server imports): the portal reads the `Abilities` type from here.
 */
export const CATALOGUE = definePermissions({
  ...CORE_PERMISSIONS,
  /**
   * See the events admin (events, guests, invites, messages, polls, analytics, refunds, settings)
   * without changing anything. Every GET of the events admin takes this OR `EVENT_MANAGE`; every
   * write needs `EVENT_MANAGE`. The store's read-only demo role holds only `…:read` codenames
   * (docs/agent/store-apps.md), so this is what lets it open the events screens.
   */
  EVENT_READ: {
    codename: 'site:event:read',
    title: 'See events',
    description: 'Open events, guests, invites, messages, polls, analytics and event settings without changing them.',
    group: 'Events',
    ability: 'viewEvents',
    roles: ['admin'],
  },
  /** Create, edit and publish events, guests, invites, messages, polls and settings. */
  EVENT_MANAGE: {
    codename: 'site:event:manage',
    title: 'Manage events',
    description: 'Create and edit events, guests, invites, messages, polls and event settings.',
    group: 'Events',
    ability: 'manageEvents',
    roles: ['admin'],
  },
  /**
   * Check guests in at the door. Admins hold it by default; the custom `checkin-staff` role
   * (migrations 20261030100000_checkin_role, 20261113160000_checkin_role_slug) holds ONLY this.
   */
  EVENT_CHECKIN: {
    codename: 'site:event:checkin',
    title: 'Check guests in',
    description: 'Scan or search tickets and mark guests as checked in.',
    group: 'Events',
    ability: 'checkinGuests',
    roles: ['admin'],
  },
  /** Outbound webhooks and other integrations: Owner only (PRD roles matrix). No default role: only `owner` (`*`). */
  EVENT_INTEGRATIONS: {
    codename: 'site:event:integrations',
    title: 'Manage integrations',
    description: 'Create, edit, test and delete outbound webhook endpoints. Owner only by default.',
    group: 'Events',
    ability: 'manageIntegrations',
    roles: [],
  },
  /**
   * See how ticket payments are taken (Settings -> Payments): the owner's provider pick and which
   * secret NAMES are set (booleans only). The read-only demo role holds it, so a store reviewer
   * sees the choice (docs/agent/store-apps.md).
   */
  PAYMENTS_READ: {
    codename: 'site:payments:read',
    title: 'View payment settings',
    description: 'See which payment provider takes ticket payments and whether its keys are set.',
    group: 'Payments',
    ability: 'viewPayments',
    roles: ['admin'],
  },
  /** Choose the payment provider (Ezypay, Stripe, PayPal or the built-in checkout). */
  PAYMENTS_MANAGE: {
    codename: 'site:payments:manage',
    title: 'Manage payment settings',
    description: 'Choose how ticket payments are taken: Ezypay, your own Stripe or PayPal, or the built-in checkout.',
    group: 'Payments',
    ability: 'managePayments',
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
