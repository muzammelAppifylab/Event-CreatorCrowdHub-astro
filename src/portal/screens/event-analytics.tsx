import {useQuery} from '@tanstack/react-query';

import {eventAnalyticsQuery, type Ratio} from '../checkin-queries';
import {BarChart, Card, type Column, DataTable, EmptyState, ErrorNote, LoadingBlock, Sparkline, Stat} from '../ui';

const percent = (r: Ratio) => (r.value === null ? '—' : `${Math.round(r.value * 100)}%`);
const dayLabel = (iso: string) => new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', timeZone: 'UTC'}).format(new Date(`${iso}T00:00:00Z`));

type SourceRow = {source: string | null; views: number; rsvps: number};

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
  ];

  return (
    <div className="screen-analytics">
      <div className="stat-grid">
        <Stat label="Page views" value={data ? data.views : null} icon="globe" hint="Unique visitors per day, added up">
          {views.length > 1 && <Sparkline values={views} label={`Page views per day, ${views.length} days`} />}
        </Stat>
        <Stat label="RSVPs" value={data ? data.rsvps.total : null} icon="users" hint={data ? `${data.rsvps.going} going` : undefined} />
        <Stat label="Conversion" value={data ? percent(data.conversion) : null} icon="trending-up" hint={data?.conversion.reason ?? 'RSVPs per page view'} />
        <Stat label="Show rate" value={data ? percent(data.showRate) : null} icon="check-circle" hint={data?.showRate.reason ?? 'Checked in or attended, of going'} />
      </div>

      <Card title="Page views over time" description={data ? `${days.length} day${days.length === 1 ? '' : 's'}` : undefined}>
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

      <Card flush title="Where visitors come from" description="By the utm_source of the link they used.">
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
    </div>
  );
}
