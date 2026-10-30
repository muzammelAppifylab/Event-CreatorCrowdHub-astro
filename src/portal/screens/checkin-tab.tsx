import {CheckinEvent} from './checkin-event';

/** The hub's Check-in tab: the door list of this event (see `event-tabs.ts`). */
export default function CheckinTab({eventId}: {eventId: string}) {
  return <CheckinEvent eventId={eventId} />;
}
