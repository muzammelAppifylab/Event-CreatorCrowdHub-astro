import {useQuery} from '@tanstack/react-query';

import {eventAnalyticsQuery, type Ratio} from '../checkin-queries';
import {BarChart, Card, type Column, DataTable, EmptyState, ErrorNote, LoadingBlock, Sparkline, Stat} from '../ui';

const percent = (r: Ratio) => (r.value === null ? '—' : `${Math.round(r.value * 100)}%`);
const dayLabel = (iso: string) => new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', timeZone: 'UTC'}).format(new Date(`${iso}T00:00:00Z`));

type SourceRow = {source: string | null; views: number; rsvps: number};

type StatusRow = {label: string; count: number; share: number};

type Revenue = {currency: string; amountCents: number; orders: number};
function money(r: Revenue): string {
  try {
    return new Intl.NumberFormat('en-GB', {style: 'currency', currency: r.currency}).format(r.amountCents / 100);
  } catch {
    return `${(r.amountCents / 100).toFixed(2)} ${r.currency}`;
  }
}
/** Paid orders (refunds excluded); further currencies are listed, never added together. */
const revenueHint = (rows: Revenue[]) =>
  rows.length === 0 ? 'No paid tickets yet' : [`${rows.reduce((n, r) => n + r.orders, 0)} paid orders`, ...rows.slice(1).map(money)].join(' · ');

/**
 * Analytics for one event: KPIs, page views over time, views and RSVPs by utm source.
 * A building block (not a route): the event hub embeds `<EventAnalytics eventId={id} />`.
 * Reads `GET /site-api/analytics/events/:id` (needs `site:event:manage`).
 */
export function EventAnalytics({eventId}: {eventId: string}) {
  const query = useQuery(eventAnalyticsQuery(eventId));
  const data = query.data;

  if (query.error && !data) return <ErrorNote error={query.error} title="Analytics could not load" />;

  const days = data?.viewsByDay ?? [];
  const views = days.map(d => d.views);
  const sourceColumns: Column<SourceRow>[] = [
    {key: 'source', header: 'Source', cell: s => <span className="cell-title">{s.source ?? 'Direct or shared link'}</span>},
    {key: 'views', header: 'Views', width: 'shrink', align: 'end', cell: s => s.views},
    {key: 'rsvps', header: 'RSVPs', width: 'shrink', align: 'end', cell: s => s.rsvps},
    {key: 'conversion', header: 'Conversion', width: 'shrink', align: 'end', cell: s => (s.views > 0 ? `${Math.round((s.rsvps / s.views) * 100)}%` : '—')},
  ];
  const statusRows: StatusRow[] =
    data && data.rsvps.total > 0
      ? [
          {label: 'Going', count: data.rsvps.going},
          {label: 'Maybe', count: data.rsvps.maybe},
          {label: 'Waitlisted', count: data.rsvps.waitlisted},
        ].map(r => ({...r, share: Math.round((r.count / data.rsvps.total) * 100)}))
      : [];
  const statusColumns: Column<StatusRow>[] = [
    {key: 'label', header: 'Status', cell: r => <span className="cell-title">{r.label}</span>},
    {key: 'count', header: 'RSVPs', width: 'shrink', align: 'end', cell: r => r.count},
    {key: 'share', header: 'Share', width: 'shrink', align: 'end', cell: r => `${r.share}%`},
  ];

  return (
    <div className="app-page screen-analytics">
      <div className="stat-grid">
        <Stat label="Views" value={data ? data.views : null} icon="globe" hint={data && data.views === 0 ? 'No visits yet' : 'Unique per day'}>
          {views.length > 1 && <Sparkline values={views} label={`Page views per day, ${views.length} days`} />}
        </Stat>
        <Stat label="RSVPs" value={data ? data.rsvps.total : null} icon="users" hint={data ? `${data.rsvps.going} going` : undefined} />
        <Stat label="Conversion" value={data ? percent(data.conversion) : null} icon="trending-up" hint={data?.conversion.reason ?? 'RSVPs per page view'} />
        <Stat label="Show rate" value={data ? percent(data.showRate) : null} icon="check-circle" hint={data?.showRate.reason ?? 'Checked in or attended, of going'} />
        <Stat
          label="Revenue"
          value={data ? (data.revenue.length === 0 ? '—' : money(data.revenue[0]!)) : null}
          icon="trending-up"
          hint={data ? revenueHint(data.revenue) : undefined}
        />
        <Stat
          label="Poll participation"
          value={data ? percent(data.pollParticipation) : null}
          icon="zap"
          hint={data?.pollParticipation.reason ?? `${data?.pollParticipation.numerator ?? 0} answers from ${data?.pollParticipation.denominator ?? 0} confirmed guests`}
        />
      </div>

      <Card title="Page views" description={data ? `${days.length} day${days.length === 1 ? '' : 's'}` : undefined}>
        {data && days.length > 0 ? (
          <BarChart label="Page views per day" data={days.map(d => ({label: dayLabel(d.date), value: d.views}))} />
        ) : data ? (
          <EmptyState icon="activity" title="No page views yet">
            Views show up once people open the event page.
          </EmptyState>
        ) : (
          <LoadingBlock rows={3} />
        )}
      </Card>

      <Card flush title="RSVPs by status">
        <DataTable
          caption="RSVPs by status"
          columns={statusColumns}
          rows={data ? statusRows : undefined}
          rowKey={r => r.label}
          loading={query.isPending}
          error={query.error}
          empty={
            <EmptyState icon="users" title="No RSVPs yet">
              Responses appear here once guests RSVP.
            </EmptyState>
          }
        />
      </Card>

      <Card flush title="Top sources" description="By the utm_source of the link they used.">
        <DataTable
          caption="Page views and RSVPs by source"
          columns={sourceColumns}
          rows={data?.sources}
          rowKey={s => s.source ?? '(direct)'}
          loading={query.isPending}
          error={query.error}
          empty={
            <EmptyState icon="globe" title="No sources yet">
              Share links ending in ?utm_source=newsletter to see which ones bring guests.
            </EmptyState>
          }
        />
      </Card>

      {data && (
        <p className="muted">
          Updated <time dateTime={data.generatedAt}>{new Date(data.generatedAt).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})}</time>. Days are counted in UTC.
        </p>
      )}
    </div>
  );
}
