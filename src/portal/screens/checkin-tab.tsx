import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';

import {doorListQuery} from '../checkin-queries';
import {buttonClass, Card, ErrorNote, Icon, LoadingBlock} from '../ui';
import {OnlineAttendance} from './checkin-event';

/** The hub's Check-in tab: the live count, a way to the door screen, and online attendance for online and hybrid events. */
export default function CheckinTab({eventId}: {eventId: string}) {
  const list = useQuery(doorListQuery(eventId, ''));
  if (list.isPending) return <LoadingBlock rows={2} />;
  if (list.error || !list.data) return <ErrorNote error={list.error ?? new Error('We couldn’t load check-in.')} />;
  const {event, counts} = list.data;
  return (
    <div className="app-page screen-checkin-tab">
      <Card
        title="Door check-in"
        description={`${counts.checkedInSeats} of ${counts.expectedSeats} seats checked in (${counts.checkedInGuests} of ${counts.expectedGuests} RSVPs). Works on a phone. Check-in staff only see names and ticket codes.`}
        actions={
          <Link to={'/checkin/$eventId' as never} params={{eventId} as never} className={buttonClass({size: 'lg'})}>
            <Icon name="check" size={18} />
            Open door screen
          </Link>
        }
      />
      {event.format !== 'in_person' && list.data.canManage && <OnlineAttendance eventId={eventId} />}
    </div>
  );
}
