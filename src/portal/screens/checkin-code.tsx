import {useMutation, useQuery} from '@tanstack/react-query';
import {Link, useParams} from '@tanstack/react-router';

import {ApiError, call, type DoorGuest, type DoorEvent, type DoorToggle, doorTime, eventWhen, partyName} from '../checkin-queries';
import {useCanCheckIn} from '../shared';
import {Badge, Button, buttonClass, Card, EmptyState, ErrorNote, Notice, PageHeader, useToast} from '../ui';

type ByCode = {event: DoorEvent; guest: DoorGuest};

const STATUS_WORDS: Record<string, string> = {
  pending: 'awaiting approval',
  waitlisted: 'on the waitlist',
  declined: 'not going',
  cancelled: 'cancelled',
  awaiting_payment: 'awaiting payment',
};

/** `/dashboard/checkin/code/$code`: what a ticket QR opens. Confirm the guest, then check them in. */
export function CheckinCode() {
  const params = useParams({strict: false}) as {code?: string};
  const code = (params.code ?? '').trim().toUpperCase();
  const toast = useToast();
  // A read-only viewer (`viewEvents` only) sees the guest, never Check in or Undo.
  const canCheckIn = useCanCheckIn();
  const lookup = useQuery({
    queryKey: ['checkin', 'code', code],
    queryFn: () => call<ByCode>(`/checkin/codes/${encodeURIComponent(code)}`),
    retry: false,
  });
  const toggle = useMutation({
    mutationFn: (checkedIn: boolean) => call<DoorToggle>(`/checkin/codes/${encodeURIComponent(code)}`, {checkedIn}),
    onSuccess: (res, checkedIn) => {
      toast.success(checkedIn ? `${res.guest.name} checked in.` : `Check-in undone for ${res.guest.name}.`);
      void lookup.refetch();
    },
    onError: error =>
      toast.danger(
        error instanceof ApiError && error.status === 409
          ? "That guest isn't confirmed, so they can't be checked in."
          : error instanceof Error
            ? error.message
            : 'Something went wrong. Try again.'
      ),
  });

  if (lookup.error instanceof ApiError && lookup.error.status === 404) {
    return (
      <div className="app-page screen-checkin">
        <EmptyState
          icon="users"
          title="Ticket not found"
          action={
            <Link to={'/checkin' as never} className={buttonClass({variant: 'secondary'})}>
              Door list
            </Link>
          }>
          No guest has the code {code}. Check it against the guest's ticket, or search the door list.
        </EmptyState>
      </div>
    );
  }
  if (lookup.error) return <ErrorNote error={lookup.error} />;
  if (!lookup.data) return <p className="muted">Looking up ticket…</p>;

  const {event, guest} = lookup.data;
  const checkedIn = guest.checkedInAt !== null;
  // Only a confirmed guest can be checked in (the server answers 409 otherwise); an undo is always allowed.
  const confirmed = guest.status === 'confirmed';
  return (
    <div className="app-page screen-checkin">
      <PageHeader
        title={event.title}
        description={eventWhen(event.startAt, event.timezone)}
        actions={
          <Link to={`/checkin/${event.id}` as never} className={buttonClass({variant: 'secondary'})}>
            Door list
          </Link>
        }
      />
      <Card title={partyName(guest)} description={`Ticket ${guest.ticketCode}`}>
        <p>{checkedIn ? <Badge>Checked in {doorTime(guest.checkedInAt!, event.timezone)}</Badge> : <Badge>Not checked in</Badge>}</p>
        {!checkedIn && !confirmed ? (
          <Notice tone="warning" title="Not confirmed">
            This guest is {STATUS_WORDS[guest.status] ?? guest.status.replace(/_/g, ' ')}, so they can't be checked in. Check the door list or ask
            the host.
          </Notice>
        ) : !canCheckIn ? null : (
          <Button
            size="lg"
            variant={checkedIn ? 'secondary' : 'primary'}
            pending={toggle.isPending}
            pendingLabel={checkedIn ? 'Undoing…' : 'Checking in…'}
            onClick={() => toggle.mutate(!checkedIn)}>
            {checkedIn ? 'Undo check-in' : 'Check in'}
          </Button>
        )}
      </Card>
    </div>
  );
}
