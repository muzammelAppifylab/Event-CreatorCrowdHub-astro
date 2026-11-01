import {useState} from 'react';

import {SegmentedControl} from '../ui';
import {GuestsTab} from './guests';
import {InvitesTab} from './invites';

/**
 * One tab for everyone attached to an event: the people who answered, and the people you asked.
 * They used to be two tabs; every host moves between them (Luma keeps invites inside Guests too).
 * `?tab=guests&view=invites` opens the second view.
 */
export default function GuestsInvitesTab({eventId}: {eventId: string}) {
  const [view, setView] = useState<'guests' | 'invites'>(() => {
    try {
      return new URLSearchParams(window.location.search).get('view') === 'invites' ? 'invites' : 'guests';
    } catch {
      return 'guests';
    }
  });
  const pick = (next: 'guests' | 'invites') => {
    setView(next);
    try {
      const url = new URL(window.location.href);
      if (next === 'invites') url.searchParams.set('view', 'invites');
      else url.searchParams.delete('view');
      window.history.replaceState(window.history.state, '', url);
    } catch {
      /* the URL is a convenience only */
    }
  };
  return (
    <>
      <div className="guests-switch">
        <SegmentedControl
          label="Guests or invites"
          value={view}
          onChange={pick}
          options={[
            {value: 'guests', label: 'Guest list'},
            {value: 'invites', label: 'Invites'},
          ]}
        />
      </div>
      {view === 'guests' ? <GuestsTab eventId={eventId} /> : <InvitesTab eventId={eventId} />}
    </>
  );
}
