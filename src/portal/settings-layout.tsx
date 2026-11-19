import {Link, useRouterState} from '@tanstack/react-router';
import type {ReactNode} from 'react';

import type {Abilities} from '../lib/types';
import {useMe} from './shared';
import {Icon, type IconName} from './ui';

/** `abilities`: shown when the visitor has ANY of them (the same rule as the route's `needs(...)`). */
type SettingsItem = {to: string; label: string; icon: IconName; abilities?: (keyof Abilities)[]};

/**
 * Everything that configures the site or the person lives under ONE sidebar entry, "Settings",
 * with this secondary nav (the pattern of Monarch, Ghost and Toggl in the Mobbin references):
 * account, how events look and run, connections, and the team. Each item is still its own
 * route, so every link and guard keeps working.
 */
export const SETTINGS_GROUPS: {label: string; items: SettingsItem[]}[] = [
  {label: 'Personal', items: [{to: '/account', label: 'Your account', icon: 'user'}]},
  {
    label: 'Events',
    items: [
      {to: '/event-settings', label: 'Branding & defaults', icon: 'settings', abilities: ['viewEvents', 'manageEvents']},
      {to: '/integrations', label: 'Integrations', icon: 'zap', abilities: ['manageIntegrations']},
    ],
  },
  {
    label: 'Team',
    items: [
      {to: '/users', label: 'Users', icon: 'users', abilities: ['manageUsers']},
      {to: '/roles', label: 'Roles & access', icon: 'shield', abilities: ['manageRoles']},
      {to: '/activity', label: 'Activity log', icon: 'activity', abilities: ['readAudit']},
    ],
  },
];

const allowed = (item: SettingsItem, abilities: Partial<Abilities> | undefined) =>
  !item.abilities || item.abilities.some(a => abilities?.[a]);

const SETTINGS_PATHS = SETTINGS_GROUPS.flatMap(group => group.items.map(item => item.to));

/** True on any settings screen (the shell wraps those in the layout, and lights the sidebar entry). */
export const isSettingsPath = (pathname: string) =>
  SETTINGS_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`));

/** Where the sidebar's "Settings" entry goes: the first screen this visitor may open. */
export function firstSettingsPath(abilities: Partial<Abilities> | undefined) {
  const first = SETTINGS_GROUPS.flatMap(group => group.items).find(item => allowed(item, abilities));
  return first?.to ?? '/account';
}

export function SettingsLayout({children}: {children: ReactNode}) {
  const abilities = useMe().data?.abilities;
  const groups = SETTINGS_GROUPS.map(group => ({
    ...group,
    items: group.items.filter(item => allowed(item, abilities)),
  })).filter(group => group.items.length);
  const pathname = useRouterState({select: s => s.location.pathname});
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings">
        {groups.map(group => (
          <div className="settings-nav-group" key={group.label}>
            <p className="settings-nav-label">{group.label}</p>
            {group.items.map(item => (
              <Link
                key={item.to}
                to={item.to}
                className="settings-nav-link"
                data-active={pathname === item.to || pathname.startsWith(`${item.to}/`) ? '' : undefined}>
                <Icon name={item.icon} size={16} />
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-body">{children}</div>
    </div>
  );
}
