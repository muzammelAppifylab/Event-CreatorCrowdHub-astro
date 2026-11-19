import type {QueryClient} from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  redirect,
  type ErrorComponentProps,
  Link,
  lazyRouteComponent,
  Outlet,
  useMatches,
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import {lazy, Suspense, useEffect, useRef, useState} from 'react';

import type {Abilities} from '../lib/types';
import {logout} from '../platform/browser';
import {
  auditQuery,
  firstAuditQuery,
  firstUsersQuery,
  healthQuery,
  meQuery,
  permissionsQuery,
  rolesQuery,
  sessionsQuery,
  siteQuery,
  twoFactorQuery,
  usersQuery,
} from './queries';
import {doorEventsQuery, doorListQuery} from './checkin-queries';
import {eventsListQuery, eventSettingsQuery} from './events-queries';
import {hubEventQuery} from './overview-queries';
import {presenterPollsQuery} from './polls-queries';
import {firstSettingsPath, isSettingsPath, SettingsLayout} from './settings-layout';
import {useMe, useSite} from './shared';
import {webhooksQuery} from './webhooks-queries';
import {
  Avatar,
  Button,
  buttonClass,
  ConfirmProvider,
  EmptyState,
  Icon,
  IconButton,
  type IconName,
  LoadingBlock,
  Menu,
  ToastProvider,
} from './ui';

/**
 * The portal's screens: a TanStack Router app under `/dashboard` (basepath),
 * served by `src/pages/portal/[...path].astro` (signed-in users only), with
 * data from the Site API through TanStack Query. Links INSIDE the portal use
 * `<Link>`; links to the website (`/`, `/blog/`, `/account/…`) are plain
 * `<a href>`.
 *
 * Add a screen (all five, every time):
 *   1. its reads as `queryOptions` in `queries.ts`, used by the screen with `useQuery(x)`;
 *   2. the component in `screens/<name>.tsx` (a named export);
 *   3. a `createRoute` below: literal `path`, `staticData.title` (the top bar
 *      and the tab), a `loader` that warms its queries, and the component
 *      LAZY (`lazyRouteComponent(() => import('./screens/<name>'), 'Name')`)
 *      so its code loads on first use (or on hover), never in the first bundle;
 *   4. its route in `routeTree`;
 *   5. one item in `NAV_GROUPS` if it belongs in the sidebar.
 * Never a plain `<a href>` to a portal path: it reloads the whole app.
 */

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** The screen's name: the top bar's `<h1>` and the tab's title. */
    title?: string;
  }
}

/**
 * Warm a screen's queries before it renders (on navigation, and on hover via
 * `defaultPreload: 'intent'`). A failed read is NOT thrown: the screen shows
 * the error in place from the same query, as it always has.
 */
const warm = (...reads: Promise<unknown>[]) => Promise.all(reads.map(read => read.catch(() => undefined))).then(() => undefined);

/**
 * A route's guard (the enforcement; the nav only hides): a visitor without one of `abilities` is sent
 * to the overview. The server still checks every call; this only keeps the screens out of reach.
 */
const needs =
  (...abilities: (keyof Abilities)[]) =>
  async ({context: {queryClient}}: {context: {queryClient: QueryClient}}) => {
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
    if (me && !abilities.some(a => me.abilities?.[a])) throw redirect({to: '/'});
  };

/** While a slow screen loads (after `defaultPendingMs`). */
export function RoutePending() {
  return (
    <div className="app-page">
      <LoadingBlock rows={4} />
    </div>
  );
}

/** A screen that failed to render or to load its code (an old tab after a Publish: reload). */
export function RouteError({error}: ErrorComponentProps) {
  const router = useRouter();
  const failure = error instanceof Error ? error : new Error('Something went wrong.');
  const stale = /dynamically imported module|module script|Importing a module/i.test(failure.message);
  return (
    <div className="app-page">
      <EmptyState
        icon={stale ? 'refresh' : 'alert'}
        title={stale ? 'This dashboard was updated' : 'This screen could not load'}
        action={
          <Button variant="secondary" icon="refresh" onClick={() => (stale ? window.location.reload() : void router.invalidate())}>
            {stale ? 'Reload' : 'Try again'}
          </Button>
        }>
        {stale ? 'Reload to get the new version.' : failure.message}
      </EmptyState>
    </div>
  );
}

/** `abilities`: shown when the visitor has ANY of them (the same rule as the route's `needs(...)`). */
type NavItem = {to: string; label: string; icon: IconName; exact?: boolean; abilities?: (keyof Abilities)[]};

/**
 * The sidebar, in groups. `abilities` hides an item the visitor may not use;
 * that only HIDES it, the route's guard is the enforcement. A group with no
 * visible item is not shown.
 */
const NAV_GROUPS: {label: string; items: NavItem[]}[] = [
  {
    label: '',
    items: [
      {to: '/', label: 'Overview', icon: 'dashboard', exact: true},
      {to: '/events', label: 'Events', icon: 'calendar', abilities: ['manageEvents']},
      {to: '/checkin', label: 'Check-in', icon: 'check-circle', abilities: ['checkinGuests', 'manageEvents']},
      {to: '/contacts', label: 'Contacts', icon: 'users', abilities: ['manageEvents']},
    ],
  },
  // Settings, Account, Users, Roles, Activity and Integrations are ONE sidebar entry (below) with a
  // secondary nav: src/portal/settings-layout.tsx.
  // Only in the Preview and `npm run dev` (never in a build): the UI kit, on screen.
  ...(import.meta.env.DEV
    ? [{label: 'Build', items: [{to: '/components', label: 'Components', icon: 'layers' as const}]}]
    : []),
];

/** The screen's title for the top bar and the tab: the deepest route's `staticData.title`. */
function useScreenTitle() {
  const matches = useMatches();
  return [...matches].reverse().find(match => match.staticData.title)?.staticData.title ?? 'Dashboard';
}

/**
 * After every in-app navigation (never the first load): the tab title says
 * where you are, and focus moves to the screen's `<h1>` so keyboard and
 * screen reader users start at the new screen (it is read out), as after a
 * page load.
 */
function useNavigationFocus(title: string, siteName: string | undefined) {
  const heading = useRef<HTMLHeadingElement>(null);
  const resolved = useRouterState({select: s => s.resolvedLocation?.pathname});
  const first = useRef(true);
  // "<title> · <site>", as App.astro writes it on the first load.
  const [fallbackName] = useState(() => document.title.split(' · ').slice(1).join(' · ') || 'CreatorCrowdHub');
  useEffect(() => {
    document.title = `${title} · ${siteName ?? fallbackName}`;
  }, [title, siteName, fallbackName]);
  useEffect(() => {
    if (!resolved) return;
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus({preventScroll: true});
  }, [resolved]);
  return {heading, resolved};
}

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'site:theme';

/** Light, dark or the device's: `data-theme` on <html> (global.css), remembered in this browser. */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage blocked: the choice lasts until the tab closes.
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

/**
 * The app shell: a full-height sidebar (brand, grouped nav, way back to the
 * website), a top bar (screen title, theme, the user's menu) and the screen
 * in between; a drawer with a scrim on small screens. Every screen renders
 * inside it, with toasts (`useToast`) and confirmations (`useConfirm`)
 * mounted once here. Nothing here reloads the page.
 */
const rootRoute = createRootRouteWithContext<{queryClient: QueryClient}>()({
  component: function Root() {
    return (
      <ToastProvider>
        <ConfirmProvider>
          <Shell />
        </ConfirmProvider>
      </ToastProvider>
    );
  },
  notFoundComponent: () => (
    <div className="app-page">
      <EmptyState
        icon="search"
        title="This page does not exist"
        action={
          <Link className={buttonClass({variant: 'secondary'})} to="/">
            Back to the overview
          </Link>
        }>
        The link may be old, or the page was moved.
      </EmptyState>
    </div>
  ),
});

/** Whether the sidebar is a drawer (small screens), the width `app.css` switches at. */
const drawerWidth = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 960px)').matches;

function Shell() {
  const me = useMe();
  const site = useSite();
  const navigate = useNavigate();
  const title = useScreenTitle();
  const siteName = site.data?.site?.name;
  const {heading, resolved} = useNavigationFocus(title, siteName);
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({select: s => s.location.pathname});
  const inSettings = isSettingsPath(pathname);
  const [theme, setTheme] = useTheme();
  // `logout()` reloads the page when it is done, so pending never needs resetting.
  const [signingOut, setSigningOut] = useState(false);
  const viewer = me.data?.viewer;
  const abilities = me.data?.abilities;
  // Signed out meanwhile (or never signed in, in the editor Preview, where
  // the host page cannot see the session): go and sign in, then come back.
  const signedOut = viewer !== undefined && viewer.state !== 'user';
  useEffect(() => {
    if (!signedOut) return;
    const back = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    window.location.replace(`/account/login/?next=${back}`);
  }, [signedOut]);
  // The drawer closes on navigation and on Esc.
  useEffect(() => setOpen(false), [resolved]);
  // Drawer widths only: opening moves focus into the sidebar (the rest is inert), closing returns it to the
  // menu button. The button is found in the shell, as the kit's IconButton takes no ref.
  const shell = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  // Closed BY a navigation (a drawer link): focus goes to the new screen's <h1>, as on every navigation
  // (the heading could not take it while `.app-main` was still inert).
  const openedOn = useRef(resolved);
  const resolvedNow = useRef(resolved);
  resolvedNow.current = resolved;
  useEffect(() => {
    const drawer = window.matchMedia('(max-width: 960px)').matches;
    if (open && drawer) {
      openedOn.current = resolvedNow.current;
      shell.current?.querySelector<HTMLElement>('.app-sidebar a')?.focus();
    } else if (!open && wasOpen.current && drawer) {
      if (resolvedNow.current !== openedOn.current) heading.current?.focus({preventScroll: true});
      else shell.current?.querySelector<HTMLElement>('.app-menu-button')?.focus();
    }
    wasOpen.current = open;
  }, [open, heading]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (signedOut) return null;

  const name = siteName ?? 'CreatorCrowdHub';
  return (
    <div className="app-shell" data-nav-open={open ? '' : undefined} ref={shell}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="app-sidebar" aria-label="Sidebar">
        <a className="app-brand" href="/">
          <span className="app-brand-name">{name}</span>
        </a>
        <nav className="app-nav" aria-label="Dashboard">
          {NAV_GROUPS.map(group => {
            const items = group.items.filter(item => !item.abilities || item.abilities.some(a => abilities?.[a]));
            if (!items.length) return null;
            return (
              <div className="app-nav-group" key={group.label}>
                {group.label && <p className="app-nav-label">{group.label}</p>}
                {items.map(item => (
                  <Link key={item.to} to={item.to} className="app-nav-link" activeOptions={{exact: item.exact ?? false}}>
                    <Icon name={item.icon} size={18} />
                    {item.label}
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="app-sidebar-foot">
          <Link to={firstSettingsPath(abilities)} className="app-nav-link" data-active={inSettings ? '' : undefined}>
            <Icon name="settings" size={18} />
            Settings
          </Link>
          <a className="app-nav-link" href="/">
            <Icon name="arrow-left" size={18} />
            Back to the website
          </a>
        </div>
      </aside>
      <button type="button" className="app-scrim" aria-label="Close the menu" tabIndex={-1} onClick={() => setOpen(false)} />

      <div className="app-main" inert={(open && drawerWidth()) || undefined}>
        <header className="app-topbar">
          <IconButton
            className="app-menu-button"
            icon={open ? 'x' : 'menu'}
            label={open ? 'Close the menu' : 'Open the menu'}
            aria-expanded={open}
            onClick={() => setOpen(value => !value)}
          />
          <h1 className="app-title" ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <div className="app-topbar-actions">
            <Menu
              label={`Theme: ${theme}`}
              trigger={<Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'} size={18} />}
              items={[
                {label: 'Light', icon: 'sun', onSelect: () => setTheme('light')},
                {label: 'Dark', icon: 'moon', onSelect: () => setTheme('dark')},
                {label: 'Same as this device', icon: 'monitor', onSelect: () => setTheme('system')},
              ]}
            />
            {viewer && (
              <Menu
                label={`Account menu for ${viewer.name ?? 'you'}`}
                trigger={
                  <>
                    {signingOut ? <span className="spinner" aria-hidden="true" /> : <Avatar name={viewer.name ?? ''} size="sm" />}
                    <span className="app-viewer-name">{signingOut ? 'Signing out…' : viewer.name}</span>
                    <Icon name="chevron-down" size={16} />
                  </>
                }
                disabled={signingOut}
                items={[
                  {label: 'Your account', icon: 'user', onSelect: () => void navigate({to: '/account'})},
                  {label: 'Back to the website', icon: 'globe', onSelect: () => window.location.assign('/')},
                  'separator',
                  {
                    label: 'Sign out',
                    icon: 'log-out',
                    onSelect: () => {
                      setSigningOut(true);
                      void logout();
                    },
                  },
                ]}
              />
            )}
          </div>
        </header>
        <main className="app-content" id="main" tabIndex={-1}>
          {inSettings ? (
            <SettingsLayout>
              <Outlet />
            </SettingsLayout>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}

// One `createRoute` per screen, with a LITERAL path (`<Link to>` is typed from
// them), a title, a loader over the screen's own queryOptions, a lazy screen.
const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  staticData: {title: 'Overview'},
  // Door staff (check in guests, cannot manage events) land on the door screen, as in the original.
  beforeLoad: async ({context: {queryClient}}) => {
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null);
    if (me?.abilities?.checkinGuests && !me.abilities.manageEvents) throw redirect({to: '/checkin'});
  },
  loader: async ({context: {queryClient}}) => {
    // The tiles the visitor may see, as the screen's `enabled` flags decide.
    const [me] = await Promise.all([queryClient.ensureQueryData(meQuery).catch(() => null), warm(queryClient.ensureQueryData(healthQuery), queryClient.ensureQueryData(twoFactorQuery), queryClient.ensureQueryData(siteQuery))]);
    const can = me?.abilities;
    await warm(
      ...(can?.manageUsers ? [queryClient.ensureQueryData(firstUsersQuery)] : []),
      ...(can?.readAudit ? [queryClient.ensureQueryData(firstAuditQuery)] : [])
    );
  },
  component: lazyRouteComponent(() => import('./screens/overview'), 'Overview'),
});
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  staticData: {title: 'Your account'},
  // `?tab=security`: a link can open one section of the account screen.
  validateSearch: (search: Record<string, unknown>): {tab?: string} =>
    typeof search.tab === 'string' ? {tab: search.tab} : {},
  loader: ({context: {queryClient}}) =>
    warm(
      queryClient.ensureQueryData(meQuery),
      queryClient.ensureQueryData(twoFactorQuery),
      queryClient.ensureQueryData(sessionsQuery)
    ),
  component: lazyRouteComponent(() => import('./screens/account'), 'Account'),
});
const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  beforeLoad: needs('manageUsers'),
  staticData: {title: 'Users'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(usersQuery({email: '', status: ''}))),
  component: lazyRouteComponent(() => import('./screens/users'), 'Users'),
});
const rolesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/roles',
  beforeLoad: needs('manageRoles'),
  staticData: {title: 'Roles'},
  loader: ({context: {queryClient}}) =>
    warm(queryClient.ensureQueryData(rolesQuery), queryClient.ensureQueryData(permissionsQuery)),
  component: lazyRouteComponent(() => import('./screens/roles'), 'Roles'),
});
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  beforeLoad: needs('readAudit'),
  staticData: {title: 'Activity'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(auditQuery)),
  component: lazyRouteComponent(() => import('./screens/activity'), 'Activity'),
});

// Events (admin): the list, the editor, the tabbed hub, settings.
// The hub is LAZY like every screen (audit L-25): imported eagerly it put its tabs and their
// date libraries in the dashboard's first bundle.
const EventHub = lazy(() => import('./screens/event-hub').then(m => ({default: m.EventHub})));
function EventHubRoute() {
  const {id} = eventHubRoute.useParams();
  return (
    <Suspense fallback={<RoutePending />}>
      <EventHub eventId={id} />
    </Suspense>
  );
}
const eventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events',
  beforeLoad: needs('manageEvents'),
  staticData: {title: 'Events'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureInfiniteQueryData(eventsListQuery('upcoming'))),
  component: lazyRouteComponent(() => import('./screens/events'), 'Events'),
});
const eventNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events/new',
  beforeLoad: needs('manageEvents'),
  staticData: {title: 'New event'},
  component: lazyRouteComponent(() => import('./screens/event-editor'), 'EventEditor'),
});
const eventEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events/$id/edit',
  beforeLoad: needs('manageEvents'),
  staticData: {title: 'Edit event'},
  component: lazyRouteComponent(() => import('./screens/event-editor'), 'EventEditor'),
});
const eventHubRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events/$id',
  beforeLoad: needs('manageEvents'),
  staticData: {title: 'Event'},
  // `warm` swallows a failed read (a 404 included): the hub shows its own "Event not found" state.
  loader: ({context: {queryClient}, params}) => warm(queryClient.ensureQueryData(hubEventQuery(params.id))),
  component: EventHubRoute,
});
const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contacts',
  beforeLoad: needs('manageEvents'),
  staticData: {title: 'Contacts'},
  component: lazyRouteComponent(() => import('./screens/contacts'), 'Contacts'),
});
const contactDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/contacts/$email',
  beforeLoad: needs('manageEvents'),
  staticData: {title: 'Contact'},
  component: lazyRouteComponent(() => import('./screens/contact-detail'), 'ContactDetailPage'),
});
const eventSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/event-settings',
  beforeLoad: needs('manageEvents'),
  staticData: {title: 'Event settings'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureQueryData(eventSettingsQuery)),
  component: lazyRouteComponent(() => import('./screens/event-settings'), 'EventSettings'),
});
const checkinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/checkin',
  beforeLoad: needs('checkinGuests', 'manageEvents'),
  staticData: {title: 'Check-in'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureQueryData(doorEventsQuery)),
  component: lazyRouteComponent(() => import('./screens/checkin'), 'Checkin'),
});
const checkinEventRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/checkin/$eventId',
  beforeLoad: needs('checkinGuests', 'manageEvents'),
  staticData: {title: 'Door list'},
  loader: ({context: {queryClient}, params}) => warm(queryClient.ensureQueryData(doorListQuery(params.eventId, ''))),
  component: lazyRouteComponent(() => import('./screens/checkin-event'), 'CheckinEvent'),
});
const checkinCodeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/checkin/code/$code',
  beforeLoad: needs('checkinGuests', 'manageEvents'),
  staticData: {title: 'Check in guest'},
  component: lazyRouteComponent(() => import('./screens/checkin-code'), 'CheckinCode'),
});
const pollPresenterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/polls/$code/present',
  beforeLoad: needs('manageEvents'),
  staticData: {title: 'Poll presenter'},
  loader: ({context: {queryClient}, params}) => warm(queryClient.ensureQueryData(presenterPollsQuery(params.code))),
  component: lazyRouteComponent(() => import('./screens/poll-presenter'), 'PollPresenter'),
});
const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations',
  beforeLoad: needs('manageIntegrations'),
  staticData: {title: 'Integrations'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureQueryData(webhooksQuery)),
  component: lazyRouteComponent(() => import('./screens/integrations'), 'Integrations'),
});
const refundsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/refunds',
  staticData: {title: 'Refunds to finish'},
  component: lazyRouteComponent(() => import('./screens/refunds'), 'Refunds'),
});

// The UI kit on screen, for the owner and their agent. Dev only: the whole route (and its
// chunk) is left out of a build, because `import.meta.env.DEV` is `false` there.
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/components',
        staticData: {title: 'Components'},
        component: lazyRouteComponent(() => import('./screens/components'), 'Components'),
      }),
    ]
  : [];

export const routeTree = rootRoute.addChildren([
  overviewRoute,
  accountRoute,
  usersRoute,
  rolesRoute,
  activityRoute,
  eventsRoute,
  eventNewRoute,
  eventEditRoute,
  eventHubRoute,
  eventSettingsRoute,
  contactsRoute,
  contactDetailRoute,
  checkinRoute,
  checkinCodeRoute,
  checkinEventRoute,
  pollPresenterRoute,
  integrationsRoute,
  refundsRoute,
  ...devRoutes,
]);
