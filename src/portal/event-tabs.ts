import type {ComponentType} from 'react';

/**
 * Event hub tab registry. Tabs are resolved by FILE NAME through import.meta.glob, so a tab whose
 * screen has not been written yet is simply absent (the hub shows "Coming soon") instead of a build error.
 * A module may export the component as default or under a conventional named export.
 */
export const HUB_TABS = [
  {id: 'overview', label: 'Overview'},
  {id: 'guests', label: 'Guests', file: 'guests'},
  {id: 'invites', label: 'Invites', file: 'invites'},
  {id: 'messages', label: 'Messages', file: 'messages'},
  {id: 'polls', label: 'Polls', file: 'polls'},
  {id: 'checkin', label: 'Check-in', file: 'checkin-tab'},
  {id: 'analytics', label: 'Analytics', file: 'event-analytics'},
] as const;
export type HubTabId = (typeof HUB_TABS)[number]['id'];
export type TabProps = {eventId: string};

const modules = import.meta.glob<Record<string, unknown>>('./screens/*.tsx');

const pascal = (s: string) => s.replace(/(^|-)(\w)/g, (_, __, ch: string) => ch.toUpperCase());

/** Pick the component out of a module: `default`, else the first of the likely named exports, else any function export. */
export function pickComponent(mod: Record<string, unknown>, file: string): ComponentType<TabProps> | null {
  const names = [pascal(file), `Event${pascal(file)}`, `${pascal(file)}Tab`, `Event${pascal(file)}Tab`];
  const hit = mod.default ?? names.map(n => mod[n]).find(Boolean);
  if (typeof hit === 'function' || (typeof hit === 'object' && hit)) return hit as ComponentType<TabProps>;
  const any = Object.values(mod).find(v => typeof v === 'function');
  return (any as ComponentType<TabProps> | undefined) ?? null;
}

/** A loader for a tab, or null when its screen file does not exist yet. */
export function tabLoader(id: HubTabId): (() => Promise<{default: ComponentType<TabProps>}>) | null {
  const tab = HUB_TABS.find(t => t.id === id);
  if (!tab || !('file' in tab)) return null;
  const load = modules[`./screens/${tab.file}.tsx`];
  if (!load) return null;
  return async () => {
    const component = pickComponent(await load(), tab.file);
    if (!component) throw new Error(`No component exported by screens/${tab.file}.tsx`);
    return {default: component};
  };
}
