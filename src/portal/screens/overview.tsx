import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';

import {healthQuery, siteQuery} from '../queries';
import {formatInZone} from '../../domain/time';
import {type OverviewData, overviewQuery} from '../overview-queries';
import {formatChange} from '../overview-format';
import {ago, useCanManageEvents, useMe, when} from '../shared';
import {RefundsCard} from './refunds-card';
import {Badge, buttonClass, Card, EmptyState, ErrorNote, Icon, LoadingBlock, Notice, PageHeader, ProgressBar, Stat} from '../ui';

type Window = NonNullable<OverviewData['last30']>;
type UpcomingRow = OverviewData['events'][number];

/**
 * `/` of the dashboard. Top to bottom: the last 30 days against the 30 before (KPI tiles, as in
 * Cal.com Insights), then what needs doing next to the events coming up (Luma's "at a glance"),
 * then the newest RSVPs. Every number is cheap (a first page, never a count): performance.md.
 */
export function Overview() {
  const me = useMe();
  const viewer = me.data?.viewer;
  const abilities = me.data?.abilities;
  const canView = Boolean(abilities?.viewEvents || abilities?.manageEvents);
  const canManage = useCanManageEvents();
  const health = useQuery(healthQuery);
  const site = useQuery(siteQuery);
  const events = useQuery({...overviewQuery, enabled: canView});
  const ev = events.data;
  const firstName = viewer?.name?.split(/\s+/)[0];

  const upcoming = ev?.events ?? [];
  const noEvents = Boolean(ev) && upcoming.length === 0 && ev!.recent.length === 0;

  return (
    <div className="app-page screen-overview">
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : 'Overview'}
        description={`Here is what is happening on ${site.data?.site?.name ?? 'your site'}.`}
        actions={
          <>
            <a className={buttonClass({variant: 'secondary'})} href="/">
              <Icon name="globe" size={18} />
              View the website
            </a>
            {canManage && (
              <Link className={buttonClass()} to={'/events/new' as never}>
                <Icon name="plus" size={18} />
                Create event
              </Link>
            )}
          </>
        }
      />

      {me.error && <ErrorNote error={me.error} />}
      {health.data && !health.data.siteKey && (
        <Notice tone="info" title="Emails are not sent here">
          This copy has no Site Key, so sign-in codes and password resets are not emailed. The live site has one.
        </Notice>
      )}

      {canView && <RefundsCard />}

      {me.data && !canView && (
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
      {canManage && noEvents && (
        <EmptyState
          icon="calendar"
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
      {canView && ev && !noEvents && (
        <>
          <Kpis data={ev.last30} upcoming={ev.totals.upcomingEvents} more={ev.totals.hasMore} />

          <div className="grid-main-side screen-overview-split">
            <Card
              title="Upcoming events"
              description="Published and not yet ended."
              flush
              actions={
                <Link className={buttonClass({variant: 'ghost', size: 'sm'})} to={'/events' as never}>
                  All events
                  <Icon name="arrow-right" size={16} />
                </Link>
              }>
              {upcoming.length ? (
                <ul className="event-rows">
                  {upcoming.map(e => (
                    <EventRow key={e.id} event={e} />
                  ))}
                </ul>
              ) : (
                <div className="card-body">
                  <p className="muted">
                    Nothing scheduled.{canManage && <> <Link to={'/events/new' as never}>Create an event</Link></>}
                  </p>
                </div>
              )}
            </Card>

            <div className="side-stack">
              <Card title="Needs your attention" description="Across all upcoming events.">
                <ul className="attention-list">
                  <Attention icon="inbox" count={ev.totals.pending} label="Awaiting approval" empty="No pending RSVPs" />
                  <Attention icon="clock" count={ev.totals.waitlisted} label="On a waitlist" empty="Nobody waiting" />
                  <Attention icon="users" count={ev.totals.going} label="Confirmed to attend" tone="neutral" empty="No confirmed guests yet" />
                </ul>
              </Card>

              <Card title="Recent RSVPs" flush>
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
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const KPI_ROWS = [
  {key: 'rsvps', label: 'RSVPs', icon: 'users'},
  {key: 'views', label: 'Page views', icon: 'trending-up'},
  {key: 'checkins', label: 'Check-ins', icon: 'check-circle'},
] as const;

/** The last window against the one before it, as a tile each: the number, and the change. */
function Kpis({data, upcoming, more}: {data: Window | undefined; upcoming: number; more: boolean}) {
  const fmt = new Intl.NumberFormat();
  return (
    <div className="stat-grid kpi-grid">
      {KPI_ROWS.map(row => {
        const now = data?.current[row.key];
        const before = data?.previous[row.key];
        const change = data && before !== undefined && before > 0 ? formatChange(now ?? 0, before) : null;
        return (
          <Stat
            key={row.key}
            label={row.label}
            icon={row.icon}
            value={data ? fmt.format(now ?? 0) : '–'}
            trend={change ? {label: change, direction: (now ?? 0) >= (before ?? 0) ? 'up' : 'down'} : undefined}
            hint={data ? `Last ${data.windowDays} days` : 'No data yet'}
          />
        );
      })}
      <Stat label="Upcoming events" icon="calendar" value={`${upcoming}${more ? '+' : ''}`} hint="Published, not yet ended" to="/events" />
    </div>
  );
}

function Attention({icon, count, label, empty, tone = 'warning'}: {icon: 'inbox' | 'clock' | 'users'; count: number; label: string; empty: string; tone?: 'warning' | 'neutral'}) {
  return (
    <li className="attention-item" data-empty={count === 0 ? '' : undefined}>
      <span className="attention-icon">
        <Icon name={icon} size={16} />
      </span>
      <span className="attention-text">{count === 0 ? empty : label}</span>
      {count > 0 && <Badge tone={tone}>{count}</Badge>}
    </li>
  );
}

const MONTH = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en', {month: 'short', timeZone}).format(new Date(iso));
const DAY = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en', {day: 'numeric', timeZone}).format(new Date(iso));

/** One upcoming event: a date block, the title and time, seats taken, and the two jumps people want. */
function EventRow({event: e}: {event: UpcomingRow}) {
  const full = e.capacity !== null && e.going >= e.capacity;
  return (
    <li className="event-row">
      <div className="event-date" aria-hidden="true">
        <span className="event-date-month">{MONTH(e.startAt, e.timezone)}</span>
        <span className="event-date-day">{DAY(e.startAt, e.timezone)}</span>
      </div>
      <div className="event-row-main">
        <Link className="event-row-title" to={`/events/${e.id}` as never}>
          {e.title}
        </Link>
        <time className="event-row-sub" dateTime={e.startAt}>
          {formatInZone(new Date(e.startAt), e.timezone)}
        </time>
        <div className="event-row-seats">
          {e.capacity !== null ? <ProgressBar value={e.going} max={e.capacity} label={`${e.going} of ${e.capacity} seats taken`} /> : null}
          <span className="event-row-count">
            <strong>{e.going}</strong>
            <span className="muted"> {e.capacity === null ? 'going' : `/ ${e.capacity} going`}</span>
            {full && <Badge tone="warning">Full</Badge>}
          </span>
        </div>
      </div>
      <div className="event-row-actions">
        <Link className={buttonClass({variant: 'secondary', size: 'sm'})} to={`/events/${e.id}` as never} search={{tab: 'guests'} as never}>
          Guests
        </Link>
        <Link className={buttonClass({variant: 'ghost', size: 'sm'})} to={`/events/${e.id}` as never}>
          Manage
        </Link>
      </div>
    </li>
  );
}
