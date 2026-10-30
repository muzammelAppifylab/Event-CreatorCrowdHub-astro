import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';

import {doorEventsQuery, type DoorEvent, eventWhen} from '../checkin-queries';
import {Badge, buttonClass, Card, type Column, DataTable, EmptyState, PageHeader} from '../ui';

const FORMAT_LABEL = {in_person: 'In person', online: 'Online', hybrid: 'Hybrid'} as const;

/** `/dashboard/checkin`: pick the event to work the door of. */
export function Checkin() {
  const events = useQuery(doorEventsQuery);
  const columns: Column<DoorEvent>[] = [
    {
      key: 'title',
      header: 'Event',
      cell: e => (
        <>
          <span className="cell-title">{e.title}</span>
          <span className="muted"> {eventWhen(e.startAt, e.timezone)}</span>
        </>
      ),
    },
    {key: 'format', header: 'Format', width: 'shrink', hideOnMobile: true, cell: e => <Badge>{FORMAT_LABEL[e.format]}</Badge>},
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: e => (
        <Link to={'/checkin/$eventId' as never} params={{eventId: e.id} as never} className={buttonClass({size: 'md'})}>
          Open door list
        </Link>
      ),
    },
  ];
  return (
    <div className="app-page screen-checkin">
      <PageHeader title="Check-in" description="Pick an event, then search guests or enter a ticket code to check them in." />
      <Card flush>
        <DataTable
          caption="Events open for check-in"
          columns={columns}
          rows={events.data?.events}
          rowKey={e => e.id}
          loading={events.isPending}
          error={events.error}
          empty={
            <EmptyState icon="users" title="No events to check in">
              Published events that are upcoming, or ended in the last day, show here.
            </EmptyState>
          }
        />
      </Card>
    </div>
  );
}
