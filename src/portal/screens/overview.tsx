import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';

import {firstJobsQuery, firstUsersQuery, healthQuery, siteQuery, twoFactorQuery} from '../queries';
import {formatInZone} from '../../domain/time';
import {type OverviewData, overviewQuery} from '../overview-queries';
import {ago, useMe, when} from '../shared';
import {Badge, buttonClass, Card, type Column, DataTable, EmptyState, ErrorNote, Icon, type IconName, LoadingBlock, Notice, PageHeader, ProgressBar, Stat} from '../ui';

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
  const twoFactor = useQuery(twoFactorQuery);
  // Under the screens' own query keys, so a save there refreshes these too.
  const users = useQuery({...firstUsersQuery, enabled: Boolean(abilities?.manageUsers)});
  const jobs = useQuery({...firstJobsQuery, enabled: Boolean(abilities?.manageJobs)});
  const events = useQuery({...overviewQuery, enabled: Boolean(me.data)});
  const ev = events.data;
  const firstName = viewer?.name?.split(/\s+/)[0];

  // The checklist: only steps this person can do, each done from real data.
  const steps: {label: string; detail: string; done: boolean | undefined; to?: string; icon: IconName}[] = [
    {
      label: 'Confirm your email',
      detail: 'So you can always get back in.',
      done: viewer?.emailVerified,
      icon: 'mail',
    },
    {
      label: 'Turn on two-step sign-in',
      detail: 'A code from your phone, so a password alone is not enough.',
      done: twoFactor.data?.enabled,
      to: '/account',
      icon: 'lock',
    },
  ];
  if (abilities?.manageUsers)
    steps.push({
      label: 'Give someone else admin access',
      detail: 'So the site never depends on one person.',
      done: users.data ? users.data.users.filter(user => user.roles.some(role => role === 'admin' || role === 'owner')).length > 1 : undefined,
      to: '/users',
      icon: 'user-plus',
    });
  if (abilities?.manageJobs)
    steps.push({
      label: 'Post your first job',
      detail: 'It shows on the public job board at once.',
      done: jobs.data ? jobs.data.jobs.length > 0 : undefined,
      to: '/jobs',
      icon: 'briefcase',
    });
  const done = steps.filter(step => step.done).length;
  const setupLeft = steps.some(step => step.done === false);

  const upcoming = ev?.events ?? [];
  const noEvents = Boolean(ev) && upcoming.length === 0 && ev!.recent.length === 0;

  const checklist = setupLeft ? (
    <Card
      title="Finish setting up"
      actions={
        <span className="muted">
          {done} of {steps.length} done
        </span>
      }
      flush
      className="checklist-card">
      <div className="card-body checklist-progress">
        <ProgressBar value={done} max={steps.length} label="Setup progress" />
      </div>
      <ul className="list">
        {steps.map(step => {
          const body = (
            <>
              <span className="checklist-mark" data-done={step.done ? '' : undefined}>
                <Icon name="check" size={14} />
              </span>
              <span className="list-row-text">
                <span className="list-row-title">{step.label}</span>
                <span className="list-row-sub">{step.detail}</span>
              </span>
              <span className="list-row-end">{step.done ? 'Done' : 'To do'}</span>
              {step.to && !step.done && <Icon name="chevron-right" size={16} className="muted" />}
            </>
          );
          return (
            <li key={step.label} className="list-row checklist-row" data-done={step.done ? '' : undefined}>
              {step.to && !step.done ? (
                <Link className="checklist-link" to={step.to}>
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  ) : null;

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
            <Link className={buttonClass()} to={'/events/new' as never}>
              <Icon name="plus" size={18} />
              Create event
            </Link>
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

      {checklist}

      {events.error && <ErrorNote error={events.error} />}
      {events.isPending && events.fetchStatus !== 'idle' && <LoadingBlock rows={2} />}
      {noEvents && (
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
      {ev && !noEvents && (
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
];
