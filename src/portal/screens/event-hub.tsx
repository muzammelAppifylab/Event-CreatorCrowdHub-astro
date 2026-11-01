import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {type ComponentType, lazy, Suspense, useState} from 'react';

import {eventAnalyticsQuery, eventWhen} from '../checkin-queries';
import {type ApiError} from '../api';
import {HUB_TABS, type HubTabId, type TabProps, tabLoader} from '../event-tabs';
import {hubEventQuery} from '../overview-queries';
import {type AdminEventDetail} from '../../lib/event-schemas';
import {HubActions, PublishProblems} from './event-hub-actions';
import {RefundsCard} from './refunds-card';
import {Badge, Button, buttonClass, Card, DefinitionList, EmptyState, ErrorNote, Icon, LoadingBlock, Notice, PageHeader, Stat, Tabs, useToast} from '../ui';

const STATUS_TONES = {draft: 'neutral', published: 'success', cancelled: 'danger'} as const;
const STATUS_LABELS = {draft: 'Draft', published: 'Published', cancelled: 'Cancelled'} as const;
const VISIBILITY_LABELS = {public: 'Public', unlisted: 'Unlisted', private: 'Private'} as const;
const FORMAT_LABELS = {in_person: 'In person', online: 'Online', hybrid: 'Hybrid'} as const;
/** The hub header read returns the whole event; the query's type only names the fields the shell needs. */
type HubDetail = Partial<AdminEventDetail> & {id: string};

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
  const event = useQuery(hubEventQuery(eventId));
  const e = event.data as HubDetail | undefined;
  const counts = e?.counts;
  const analytics = useQuery(eventAnalyticsQuery(eventId));
  const a = analytics.data;
  const seats = counts ? (e?.capacity ? `${counts.confirmed} of ${e.capacity}` : String(counts.confirmed)) : null;
  const where = e?.format === 'online' ? FORMAT_LABELS.online : [e?.venueName, e?.venueAddress].filter(Boolean).join(', ');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const items: {label: string; value: React.ReactNode}[] = [];
  if (e?.startAt) items.push({label: 'When', value: eventWhen(e.startAt, e.timezone ?? 'UTC')});
  if (e?.format) items.push({label: 'Where', value: FORMAT_LABELS[e.format] + (where && e.format !== 'online' ? ` · ${where}` : '')});
  if (e?.slug) items.push({label: 'Public link', value: <span className="break-all">{`${origin}/events/${e.slug}/`}</span>});
  if (e?.joinUrl) items.push({label: 'Join link (confirmed guests only)', value: <span className="break-all">{e.joinUrl}</span>});
  if (e?.pollJoinCode) items.push({label: 'Poll join code', value: <code>{e.pollJoinCode}</code>});
  return (
    <>
      {event.error && <ErrorNote error={event.error} />}
      <div className="stat-grid">
        <Stat label="Going" icon="check" value={counts ? String(counts.confirmed) : null} />
        <Stat label="Maybe" icon="info" value={a ? String(a.rsvps.maybe) : null} />
        <Stat label="Waitlisted" icon="clock" value={counts ? String(counts.waitlisted) : null} />
        <Stat label="Pending approval" icon="inbox" value={counts ? String(counts.pending) : null} />
        <Stat label="Seats taken" icon="users" value={seats} />
      </div>
      <RefundsCard eventId={eventId} />
      <Card title="Summary">
        <div className="stat-grid">
          <Stat label="Page views" icon="search" value={a ? String(a.views) : null} />
          <Stat label="RSVPs" icon="inbox" value={a ? String(a.rsvps.total) : null} />
          <Stat label="Conversion" icon="refresh" value={a ? (a.conversion.value === null ? '—' : `${Math.round(a.conversion.value * 100)}%`) : null} />
          <Stat label="Checked in" icon="check" value={a ? String(a.rsvps.checkedIn) : null} />
        </div>
        {analytics.error && <ErrorNote error={analytics.error} />}
      </Card>
      <Card title="Details">{items.length ? <DefinitionList items={items} /> : <LoadingBlock rows={3} />}</Card>
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
  const toast = useToast();
  const [problem, setProblem] = useState<ApiError | null>(null);
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
            <span className="badges">
              <Badge tone={STATUS_TONES[e.status] ?? 'neutral'}>{STATUS_LABELS[e.status] ?? e.status}</Badge>
              {(e as HubDetail).visibility && <Badge>{VISIBILITY_LABELS[(e as HubDetail).visibility!]}</Badge>}
              {(e as HubDetail).format && <Badge>{FORMAT_LABELS[(e as HubDetail).format!]}</Badge>}
            </span>
          ) : undefined
        }
        actions={
          <>
            <Link className={buttonClass({variant: 'ghost'})} to={'/events' as never}>
              <Icon name="arrow-left" size={18} />
              All events
            </Link>
            {e && (
              <Button
                variant="secondary"
                icon="copy"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(`${window.location.origin}/events/${e.slug}/`)
                    .then(() => toast.success('Event link copied'))
                    .catch(() => undefined)
                }>
                Copy link
              </Button>
            )}
            {e && e.status === 'published' && (
              <a className={buttonClass({variant: 'secondary'})} href={`/events/${e.slug}/`} target="_blank" rel="noopener">
                <Icon name="external" size={18} />
                View public page
              </a>
            )}
            {e && e.status !== 'cancelled' && (
              <Link className={buttonClass({variant: 'secondary'})} to={`/events/${e.id}/edit` as never}>
                <Icon name="pencil" size={18} />
                Edit
              </Link>
            )}
            {e && (
              <HubActions
                event={{id: e.id, title: e.title, status: e.status, startAt: e.startAt, endAt: e.endAt, timezone: (e as HubDetail).timezone ?? 'UTC'}}
                onPublishProblem={setProblem}
              />
            )}
          </>
        }
      />
      {event.error && <ErrorNote error={event.error} />}
      {problem && <PublishProblems error={problem} />}
      {e?.status === 'draft' && <Notice tone="warning">This is a draft. Guests can't open the link until you publish.</Notice>}
      {e?.status === 'cancelled' && <Notice tone="danger">This event is cancelled. Its page shows a Cancelled banner.</Notice>}
      <Tabs label="Event sections" items={HUB_TABS.map(t => ({value: t.id, label: t.label}))} value={tab} onChange={select}>
        <Suspense fallback={<LoadingBlock rows={4} />}>
          {Tab ? <Tab eventId={eventId} /> : <Card><ComingSoon label={current.label} /></Card>}
        </Suspense>
      </Tabs>
    </div>
  );
}
