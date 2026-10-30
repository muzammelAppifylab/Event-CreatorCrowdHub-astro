import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {type ComponentType, lazy, Suspense, useState} from 'react';

import {eventAnalyticsQuery, eventWhen} from '../checkin-queries';
import {HUB_TABS, type HubTabId, type TabProps, tabLoader} from '../event-tabs';
import {hubEventQuery} from '../overview-queries';
import {Badge, buttonClass, Card, EmptyState, ErrorNote, Icon, LoadingBlock, PageHeader, Stat, Tabs} from '../ui';

const STATUS_TONES = {draft: 'neutral', published: 'success', cancelled: 'danger'} as const;

const cache = new Map<HubTabId, ComponentType<TabProps> | null>();
function tabComponent(id: HubTabId): ComponentType<TabProps> | null {
  if (!cache.has(id)) {
    const loader = tabLoader(id);
    cache.set(id, loader ? lazy(loader) : null);
  }
  return cache.get(id) ?? null;
}

const initialTab = (): HubTabId => {
  try {
    const t = new URLSearchParams(window.location.search).get('tab');
    return HUB_TABS.find(x => x.id === t)?.id ?? 'overview';
  } catch {
    return 'overview';
  }
};

function HubOverview({eventId}: TabProps) {
  const analytics = useQuery(eventAnalyticsQuery(eventId));
  const a = analytics.data;
  return (
    <>
      {analytics.error && <ErrorNote error={analytics.error} />}
      <div className="stat-grid">
        <Stat label="Page views" icon="globe" value={a ? String(a.views) : null} hint="Unique views of the event page" />
        <Stat label="RSVPs" icon="users" value={a ? String(a.rsvps.total) : null} hint={a ? `${a.rsvps.going} going` : undefined} />
        <Stat label="Checked in" icon="check" value={a ? String(a.rsvps.checkedIn) : null} hint="Showed up at the door or online" />
      </div>
    </>
  );
}

function ComingSoon({label}: {label: string}) {
  return (
    <EmptyState icon="clock" title="Coming soon">
      The {label} tab is not available yet.
    </EmptyState>
  );
}

/** `/dashboard/events/$id`: a tabbed hub. Each tab is a separate screen file loaded on demand. */
export function EventHub({eventId}: {eventId: string}) {
  const [tab, setTab] = useState<HubTabId>(initialTab);
  const event = useQuery(hubEventQuery(eventId));
  const e = event.data;
  const current = HUB_TABS.find(t => t.id === tab)!;
  const Tab = tab === 'overview' ? HubOverview : tabComponent(tab);

  const select = (next: HubTabId) => {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', next);
      window.history.replaceState(null, '', url);
    } catch {
      /* the URL is a convenience only */
    }
  };

  return (
    <div className="app-page screen-event-hub">
      <PageHeader
        title={e?.title ?? 'Event'}
        description={
          e ? (
            <>
              <Badge tone={STATUS_TONES[e.status] ?? 'neutral'}>{e.status}</Badge>{' '}
              <span className="muted">{eventWhen(e.startAt, e.timezone ?? 'UTC')}</span>
            </>
          ) : undefined
        }
        actions={
          <>
            <Link className={buttonClass({variant: 'secondary'})} to={'/events' as never}>
              <Icon name="arrow-left" size={18} />
              All events
            </Link>
            {e && (
              <a className={buttonClass({variant: 'secondary'})} href={`/events/${e.slug}`}>
                <Icon name="globe" size={18} />
                View public page
              </a>
            )}
          </>
        }
      />
      {event.error && <ErrorNote error={event.error} />}
      <Tabs label="Event sections" items={HUB_TABS.map(t => ({value: t.id, label: t.label}))} value={tab} onChange={select}>
        <Suspense fallback={<LoadingBlock rows={4} />}>
          {Tab ? <Tab eventId={eventId} /> : <Card><ComingSoon label={current.label} /></Card>}
        </Suspense>
      </Tabs>
    </div>
  );
}
