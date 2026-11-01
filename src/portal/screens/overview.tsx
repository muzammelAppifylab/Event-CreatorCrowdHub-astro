import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';

import {healthQuery, siteQuery} from '../queries';
import {formatInZone} from '../../domain/time';
import {type OverviewData, overviewQuery} from '../overview-queries';
import {ago, useMe, when} from '../shared';
import {RefundsCard} from './refunds-card';
import {Badge, buttonClass, Card, type Column, DataTable, EmptyState, ErrorNote, Icon, LoadingBlock, Notice, PageHeader, Stat} from '../ui';

/**
 * `/` of the dashboard: a greeting, what needs attention, stat tiles, a
 * setup checklist for whoever runs the site, then recent activity. Every
 * number is cheap (a first page, never a count): docs/agent/performance.md.
 *
 * Make it YOURS: swap the tiles for the numbers your app is about (bookings
 * today, open orders), each from a first page or a counter kept on write.
 */
export function Overview() {
  const me = useMe();
  const viewer = me.data?.viewer;
  const abilities = me.data?.abilities;
  const health = useQuery(healthQuery);
  const site = useQuery(siteQuery);
  const events = useQuery({...overviewQuery, enabled: Boolean(abilities?.manageEvents)});
  const ev = events.data;
  const firstName = viewer?.name?.split(/\s+/)[0];

  const upcoming = ev?.events ?? [];
  const noEvents = Boolean(ev) && upcoming.length === 0 && ev!.recent.length === 0;

  return (
    <div className="app-page screen-overview">
      <PageHeader
        title="Dashboard"
        description={`Here is what is happening on ${site.data?.site?.name ?? 'your site'}${firstName ? `, ${firstName}` : ''}.`}
        actions={
          <>
            <a className={buttonClass({variant: 'secondary'})} href="/">
              <Icon name="globe" size={18} />
              View the website
            </a>
            {abilities?.manageEvents && (
              <Link className={buttonClass()} to={'/events/new' as never}>
                <Icon name="plus" size={18} />
                Create event
              </Link>
            )}
          </>
        }
      />

      {me.error && <ErrorNote error={me.error} />}
      {health.data && !health.data.ownerSetup && (
        <Notice tone="warning" title="Nobody can become this site's owner yet">
          No owner email is set. Publish the site again from the platform, or add the owner's email to
          ownerEmails in src/server/auth-settings.ts.
        </Notice>
      )}
      {health.data && !health.data.siteKey && (
        <Notice tone="info" title="Emails are not sent here">
          This copy has no Site Key, so sign-in codes and password resets are not emailed. The live site has one.
        </Notice>
      )}

      {abilities?.manageEvents && <RefundsCard />}

      {me.data && !abilities?.manageEvents && (
        <EmptyState
          icon="user"
          title={firstName ? `Welcome, ${firstName}` : 'Welcome'}
          action={
            <Link className={buttonClass({variant: 'secondary'})} to={'/account' as never}>
              Your account
            </Link>
          }>
          You are signed in. Manage your profile and sign-in details from your account.
        </EmptyState>
      )}

      {events.error && <ErrorNote error={events.error} />}
      {events.isPending && events.fetchStatus !== 'idle' && <LoadingBlock rows={2} />}
      {abilities?.manageEvents && noEvents && (
        <EmptyState
          icon="clock"
          title="Create your first event"
          action={
            <Link className={buttonClass()} to={'/events/new' as never}>
              <Icon name="plus" size={18} />
              Create your first event
            </Link>
          }>
          Set it up in a few minutes and share the link. Every guest lands in your Guests list.
        </EmptyState>
      )}
      {abilities?.manageEvents && ev && !noEvents && (
        <>
          <div className="grid-main-side screen-overview-split">
            <Card
              title="Upcoming events"
              flush
              actions={
                <Link className={buttonClass({variant: 'ghost', size: 'sm'})} to={'/events' as never}>
                  All events
                  <Icon name="arrow-right" size={16} />
                </Link>
              }>
              {upcoming.length ? (
                <DataTable caption="Upcoming events" columns={upcomingColumns} rows={upcoming} rowKey={e => e.id} />
              ) : (
                <div className="card-body">
                  <p className="muted">
                    Nothing scheduled. <Link to={'/events/new' as never}>Create an event</Link>
                  </p>
                </div>
              )}
            </Card>
            <div className="stat-stack">
              <Stat label="Upcoming events" icon="clock" value={String(ev.totals.upcomingEvents) + (ev.totals.hasMore ? '+' : '')} hint="Published, not yet ended" to="/events" />
              <Stat label="Going" icon="users" value={String(ev.totals.going)} hint="Confirmed seats" />
              <Stat label="Waitlisted" icon="clock" value={String(ev.totals.waitlisted)} hint="Across upcoming events" />
              <Stat label="Awaiting approval" icon="inbox" value={String(ev.totals.pending)} hint="Pending RSVPs" />
            </div>
          </div>
          <Card
            title="Recent RSVPs"
            description="Newest responses to upcoming events."
            flush
            actions={
              <Link className={buttonClass({variant: 'ghost', size: 'sm'})} to={'/events' as never}>
                View all
                <Icon name="arrow-right" size={16} />
              </Link>
            }>
            {ev.recent.length ? (
              <ul className="list">
                {ev.recent.map(r => (
                  <li key={r.id} className="list-row">
                    <span className="list-row-icon">
                      <Icon name="users" size={16} />
                    </span>
                    <div className="list-row-text">
                      <p className="list-row-title">
                        {r.name} <span className="muted">· {r.status.replaceAll('_', ' ')}</span>
                      </p>
                      <p className="list-row-sub">{r.eventTitle}</p>
                    </div>
                    <time className="list-row-end" dateTime={r.createdAt} title={when(r.createdAt)}>
                      {ago(r.createdAt)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="users" title="No RSVPs yet">
                Responses to your upcoming events will show here.
              </EmptyState>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

type UpcomingRow = OverviewData['events'][number];

const HUB_LINKS = [
  {tab: 'guests', label: 'Guests'},
  {tab: 'invites', label: 'Invites'},
  {tab: 'messages', label: 'Messages'},
  {tab: 'polls', label: 'Polls'},
  {tab: 'checkin', label: 'Check-in'},
  {tab: 'analytics', label: 'Analytics'},
] as const;

const upcomingColumns: Column<UpcomingRow>[] = [
  {
    key: 'event',
    header: 'Event',
    cell: e => (
      <span className="cell-title">
        <Link to={`/events/${e.id}` as never}>{e.title}</Link>
      </span>
    ),
  },
  {key: 'when', header: 'When', width: 'shrink', cell: e => <time dateTime={e.startAt}>{formatInZone(new Date(e.startAt), e.timezone)}</time>},
  {
    key: 'going',
    header: 'Going',
    width: 'shrink',
    cell: e => (
      <span>
        {e.capacity !== null && e.going >= e.capacity && <Badge tone="warning">Full</Badge>}{' '}
        <strong>{e.going}</strong>
        <span className="muted"> / {e.capacity === null ? 'no limit' : e.capacity}</span>
      </span>
    ),
  },
  {
    key: 'links',
    header: 'Manage',
    hideOnMobile: true,
    cell: e => (
      <span className="badges">
        {HUB_LINKS.map(l => (
          <Link key={l.tab} className={buttonClass({variant: 'ghost', size: 'sm'})} to={`/events/${e.id}` as never} search={{tab: l.tab} as never}>
            {l.label}
          </Link>
        ))}
      </span>
    ),
  },
];
