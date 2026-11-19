import type {ComponentType} from 'react';

import type {IconName} from './ui';

/**
 * Event hub tab registry. Each tab names its screen with an explicit, typed dynamic import, so a
 * renamed file or export is a build error (never a silently empty tab), and each screen is still
 * its own chunk, loaded when its tab is first opened. `overview` is drawn by the hub itself.
 */
export const HUB_TABS = [
  {id: 'overview', label: 'Overview', icon: 'dashboard' as IconName},
  {id: 'guests', label: 'Guests', icon: 'users' as IconName},
  {id: 'messages', label: 'Messages', icon: 'inbox' as IconName},
  {id: 'polls', label: 'Polls', icon: 'activity' as IconName},
  {id: 'checkin', label: 'Check-in', icon: 'check-circle' as IconName},
  {id: 'analytics', label: 'Analytics', icon: 'trending-up' as IconName},
] as const;
export type HubTabId = (typeof HUB_TABS)[number]['id'];
export type TabProps = {eventId: string};

type TabModule = {default: ComponentType<TabProps>};

const LOADERS: Partial<Record<HubTabId, () => Promise<TabModule>>> = {
  guests: () => import('./screens/guests-invites').then(m => ({default: m.default})),
  messages: () => import('./screens/messages').then(m => ({default: m.MessagesTab})),
  polls: () => import('./screens/polls').then(m => ({default: m.Polls})),
  checkin: () => import('./screens/checkin-tab').then(m => ({default: m.default})),
  analytics: () => import('./screens/event-analytics').then(m => ({default: m.EventAnalytics})),
};

/** A loader for a tab's screen, or null for a tab the hub draws itself (`overview`). */
export function tabLoader(id: HubTabId): (() => Promise<TabModule>) | null {
  return LOADERS[id] ?? null;
}
