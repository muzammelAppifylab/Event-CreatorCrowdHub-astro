import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';
import {type ComponentType, lazy, Suspense, useState} from 'react';

import {eventAnalyticsQuery, eventWhen} from '../checkin-queries';
import {ApiError} from '../api';
import {HUB_TABS, type HubTabId, type TabProps, tabLoader} from '../event-tabs';
import {hubEventQuery} from '../overview-queries';
import {type AdminEventDetail} from '../../lib/event-schemas';
import {HubActions, PublishProblems} from './event-hub-actions';
import {RefundsCard} from './refunds-card';
import {Badge, buttonClass, Card, DefinitionList, EmptyState, ErrorNote, Icon, type IconName, LoadingBlock, Notice, ProgressBar, Stat, Tabs, useToast} from '../ui';

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
    if (t === 'invites') return 'guests';
    return HUB_TABS.find(x => x.id === t)?.id ?? 'overview';
  } catch {
    return 'overview';
  }
};

type HubOverviewProps = TabProps & {onTab: (tab: HubTabId, view?: string) => void};

/** The first thing a host sees: seats and what is waiting, the next things to do, then how the page performs. */
function HubOverview({eventId, onTab}: HubOverviewProps) {
  const event = useQuery(hubEventQuery(eventId));
  const e = event.data as HubDetail | undefined;
  const counts = e?.counts;
  const analytics = useQuery(eventAnalyticsQuery(eventId));
  const a = analytics.data;
  const toast = useToast();
  // Going = confirmed "Yes" only, the number Analytics shows. counts.confirmed also holds confirmed "Maybe"
  // answers, which would read as "14 of 12 going".
  const going = a ? a.rsvps.going : null;
  const where = e?.format === 'online' ? FORMAT_LABELS.online : [e?.venueName, e?.venueAddress].filter(Boolean).join(', ');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const items: {label: string; value: React.ReactNode}[] = [];
  if (e?.startAt) items.push({label: 'When', value: eventWhen(e.startAt, e.timezone ?? 'UTC')});
  if (e?.format) items.push({label: 'Where', value: FORMAT_LABELS[e.format] + (where && e.format !== 'online' ? ` · ${where}` : '')});
  if (e?.slug) items.push({label: 'Public link', value: <span className="break-all">{`${origin}/events/${e.slug}/`}</span>});
  if (e?.joinUrl) items.push({label: 'Join link (confirmed guests only)', value: <span className="break-all">{e.joinUrl}</span>});
  if (e?.pollJoinCode) items.push({label: 'Poll join code', value: <code>{e.pollJoinCode}</code>});
  const copyLink = () =>
    e &&
    void navigator.clipboard
      .writeText(`${window.location.origin}/events/${e.slug}/`)
      .then(() => toast.success('Event link copied'))
      .catch(() => undefined);
  return (
    <div className="hub-stack">
      {event.error && <ErrorNote error={event.error} />}
      <Card>
        <div className="hub-glance">
          <div className="hub-glance-head">
            <p className="hub-glance-count">
              {going ?? '–'}
              <span className="muted"> {e?.capacity ? `of ${e.capacity} going` : 'going'}</span>
            </p>
            <div className="hub-glance-flags">
              {counts && counts.pending > 0 && <Badge tone="warning">{counts.pending} awaiting approval</Badge>}
              {counts && counts.waitlisted > 0 && <Badge tone="warning">{counts.waitlisted} waitlisted</Badge>}
              {a && a.rsvps.maybe > 0 && <Badge>{a.rsvps.maybe} maybe</Badge>}
            </div>
          </div>
          {going !== null && e?.capacity ? <ProgressBar value={Math.min(going, e.capacity)} max={e.capacity} label={`${going} of ${e.capacity} going`} /> : null}
        </div>
      </Card>
      <div className="hub-quick">
        <QuickTile icon="user-plus" title="Invite guests" sub="Send personal invites" onClick={() => onTab('guests', 'invites')} />
        <QuickTile icon="check-circle" title="Check in guests" sub="Open the door list" onClick={() => onTab('checkin')} />
        <QuickTile icon="mail" title="Message guests" sub="Email an update" onClick={() => onTab('messages')} />
        <QuickTile icon="copy" title="Copy event link" sub="Share the public page" onClick={copyLink} disabled={!e} />
      </div>
      <RefundsCard eventId={eventId} />
      <div className="stat-grid">
        <Stat label="Page views" icon="search" value={a ? String(a.views) : null} />
        <Stat label="RSVPs" icon="inbox" value={a ? String(a.rsvps.total) : null} />
        <Stat label="Conversion" icon="refresh" value={a ? (a.conversion.value === null ? '—' : `${Math.round(a.conversion.value * 100)}%`) : null} />
        <Stat label="Checked in" icon="check" value={a ? String(a.rsvps.checkedIn) : null} />
      </div>
      {analytics.error && <ErrorNote error={analytics.error} />}
      <Card title="Details">{items.length ? <DefinitionList items={items} /> : <LoadingBlock rows={3} />}</Card>
    </div>
  );
}

function QuickTile({icon, title, sub, onClick, disabled}: {icon: IconName; title: string; sub: string; onClick: () => void; disabled?: boolean}) {
  return (
    <button type="button" className="hub-quick-tile" onClick={onClick} disabled={disabled}>
      <span className="hub-quick-icon">
        <Icon name={icon} size={18} />
      </span>
      <span>
        {title}
        <span className="hub-quick-sub">{sub}</span>
      </span>
    </button>
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
  const [problem, setProblem] = useState<ApiError | null>(null);
  const current = HUB_TABS.find(t => t.id === tab)!;
  const Tab = tab === 'overview' ? null : tabComponent(tab);

  const select = (next: HubTabId, view?: string) => {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', next);
      if (view) url.searchParams.set('view', view);
      else url.searchParams.delete('view');
      window.history.replaceState(window.history.state, '', url);
    } catch {
      /* the URL is a convenience only */
    }
  };

  // The header read failed and there is nothing to show: say so instead of leaving every tab loading.
  if (!e && event.error) {
    const missing = event.error instanceof ApiError && (event.error.status === 404 || event.error.status === 403);
    return (
      <div className="app-page screen-event-hub">
        <header className="hub-head">
          <Link className="hub-crumb" to={'/events' as never}>
            <Icon name="arrow-left" size={16} />
            Events
          </Link>
        </header>
        <Card>
          {missing ? (
            <EmptyState
              icon="search"
              title="Event not found"
              action={
                <Link className={buttonClass({variant: 'secondary'})} to={'/events' as never}>
                  Back to events
                </Link>
              }>
              It may have been deleted, or the link is wrong.
            </EmptyState>
          ) : (
            <ErrorNote error={event.error} />
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="app-page screen-event-hub">
      <header className="hub-head">
        <Link className="hub-crumb" to={'/events' as never}>
          <Icon name="arrow-left" size={16} />
          Events
        </Link>
        <div className="hub-title-row">
          <div>
            <h2>{e?.title ?? 'Event'}</h2>
            {e && (
              <span className="badges">
                <Badge tone={STATUS_TONES[e.status] ?? 'neutral'}>{STATUS_LABELS[e.status] ?? e.status}</Badge>
                {(e as HubDetail).visibility && <Badge>{VISIBILITY_LABELS[(e as HubDetail).visibility!]}</Badge>}
                {(e as HubDetail).format && <Badge>{FORMAT_LABELS[(e as HubDetail).format!]}</Badge>}
              </span>
            )}
          </div>
          <div className="hub-actions">
            {e && e.status === 'published' && (
              <a className={buttonClass({variant: 'secondary'})} href={`/events/${e.slug}/`} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={18} />
                Event page
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
                event={{
                  id: e.id,
                  title: e.title,
                  status: e.status,
                  startAt: e.startAt,
                  endAt: e.endAt,
                  timezone: (e as HubDetail).timezone ?? 'UTC',
                  counts: (e as HubDetail).counts,
                  hasHeld: (e as HubDetail).hasHeld,
                }}
                onPublishProblem={setProblem}
              />
            )}
          </div>
        </div>
      </header>
      {event.error && <ErrorNote error={event.error} />}
      {problem && <PublishProblems error={problem} />}
      {e?.status === 'draft' && <Notice tone="warning">This is a draft. Guests can't open the link until you publish.</Notice>}
      {e?.status === 'cancelled' && <Notice tone="danger">This event is cancelled. Its page shows a Cancelled banner.</Notice>}
      <Tabs label="Event sections" items={HUB_TABS.map(t => ({
          value: t.id,
          label: (
            <span className="tab-label">
              <Icon name={t.icon} size={16} />
              {t.label}
            </span>
          ),
        }))} value={tab} onChange={next => select(next)}>
        <Suspense fallback={<LoadingBlock rows={4} />}>
          {tab === 'overview' ? <HubOverview eventId={eventId} onTab={select} /> : Tab ? <Tab eventId={eventId} /> : <Card><ComingSoon label={current.label} /></Card>}
        </Suspense>
      </Tabs>
    </div>
  );
}
