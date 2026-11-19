import {type FormEvent, useState} from 'react';

import {fromLocalInput, toLocalInput} from '../../lib/event-schemas';
import {ApiError} from '../api';
import {useEventLifecycle, useEventsNav} from '../events-queries';
import {Button, DateTimeField, Field, Icon, Modal, Notice, SegmentedControl, useConfirm, useToast} from '../ui';

type GuestCounts = {confirmed: number; waitlisted: number; pending: number};
export type HubActionEvent = {
  id: string;
  title: string;
  status: 'draft' | 'published' | 'cancelled';
  endAt: string;
  startAt: string;
  timezone: string;
  counts?: GuestCounts;
  /** The server's own rule (`hasHeld` on the event payload): held or awaiting-payment guests, or a paid order. */
  hasHeld?: boolean;
};

/**
 * Does anyone still hold or wait for a place, or has anyone paid? Then the server refuses unpublish and
 * delete (409 `event_has_guests`). Decided by the payload's `hasHeld`, the same rule the server applies
 * (it also counts awaiting-payment guests and paid orders, which `counts` leaves out); the counts are
 * only a fallback for a payload without it. The 409 stays the safety net.
 */
export const hasGuests = (e: Pick<HubActionEvent, 'counts' | 'hasHeld'>) =>
  e.hasHeld ?? (!!e.counts && e.counts.confirmed + e.counts.waitlisted + e.counts.pending > 0);

/**
 * Cancel is the only way out for an event people expect: the server refuses to unpublish or delete one
 * with guests or paid tickets (409 `event_has_guests`). So it is offered for every published event, ended
 * or not, and for a draft that still has guests (a leftover from before that rule).
 */
/**
 * Runs `run` unless a run on the same `flight` flag is still going; a call made meanwhile does nothing and
 * resolves `undefined` (a double click on a button whose work has not finished). The flag is a ref, so it
 * holds between two clicks that land before React re-renders the button as pending.
 */
export async function guarded<T>(flight: {current: boolean}, run: () => Promise<T>): Promise<T | undefined> {
  if (flight.current) return undefined;
  flight.current = true;
  try {
    return await run();
  } finally {
    flight.current = false;
  }
}

export const canCancel =(e: Pick<HubActionEvent, 'status' | 'counts' | 'hasHeld'>) => e.status === 'published' || (e.status === 'draft' && hasGuests(e));

/** Unpublish is offered only when the server will accept it: a published event nobody holds a place in. */
export const canUnpublish = (e: Pick<HubActionEvent, 'status' | 'counts' | 'hasHeld'>) => e.status === 'published' && !hasGuests(e);

/** Delete is offered only for a draft the server will delete. */
export const canDelete = (e: Pick<HubActionEvent, 'status' | 'counts' | 'hasHeld'>) => e.status === 'draft' && !hasGuests(e);

const FIELD_LABELS: Record<string, string> = {
  title: 'Title', description: 'Description', startAt: 'Start', endAt: 'End', timezone: 'Time zone', format: 'Format',
  venueName: 'Venue', venueAddress: 'Address', joinUrl: 'Join link', capacity: 'Capacity', slug: 'Link',
};

/** The server's 409 for an incomplete draft, as a list a person can act on. */
export function PublishProblems({error}: {error: ApiError}) {
  const fields = Object.entries(error.fields);
  return (
    <Notice tone="warning" title="This event can't be published yet">
      {fields.length ? (
        <ul>
          {fields.map(([key, message]) => (
            <li key={key}>
              {FIELD_LABELS[key] ? `${FIELD_LABELS[key]}: ` : ''}
              {message}
            </li>
          ))}
        </ul>
      ) : (
        error.message
      )}
    </Notice>
  );
}

/** Duplicate: new dates are required so the copy never inherits a past start. */
function DuplicateDialog({event, onClose}: {event: HubActionEvent; onClose: () => void}) {
  const {duplicate} = useEventLifecycle();
  const go = useEventsNav();
  const toast = useToast();
  const [title, setTitle] = useState(`Copy of ${event.title}`.slice(0, 120));
  // The copy starts a week after the later of the original's start and now, and lasts as long as the original,
  // so the dates are sensible but never inherited from a past event. Change them freely.
  const length = Math.max(Date.parse(event.endAt) - Date.parse(event.startAt), 60 * 60 * 1000);
  const shifted = (days: number) => {
    const from = Math.max(Date.parse(event.startAt), Date.now());
    const startMs = from + days * 24 * 60 * 60 * 1000;
    return {start: toLocalInput(new Date(startMs).toISOString(), event.timezone), end: toLocalInput(new Date(startMs + length).toISOString(), event.timezone)};
  };
  const [start, setStart] = useState(() => shifted(7).start);
  const [end, setEnd] = useState(() => shifted(7).end);
  const [preset, setPreset] = useState<'7' | '14' | '30' | 'custom'>('7');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pick = (value: '7' | '14' | '30') => {
    const next = shifted(Number(value));
    setPreset(value);
    setStart(next.start);
    setEnd(next.end);
    setErrors(current => ({...current, startAt: '', endAt: ''}));
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const startAt = fromLocalInput(start, event.timezone);
    const endAt = fromLocalInput(end, event.timezone);
    const next: Record<string, string> = {};
    if (!title.trim() || title.trim().length > 120) next.title = 'A title needs 1 to 120 characters.';
    if (!startAt) next.startAt = 'Enter a start date and time.';
    if (!endAt) next.endAt = 'Enter an end date and time.';
    if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) next.endAt = 'End must be after the start.';
    setErrors(next);
    if (Object.keys(next).length || !startAt || !endAt) return;
    duplicate.mutate(
      {id: event.id, title: title.trim(), startAt, endAt},
      {
        onSuccess: ({event: created}) => {
          toast.success('Draft copy created.');
          onClose();
          go(`/events/${created.id}/edit`);
        },
        onError: err => setErrors(err instanceof ApiError && Object.keys(err.fields).length ? err.fields : {form: err.message}),
      }
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!duplicate.isPending}
      title="Duplicate event"
      description={`A new draft based on “${event.title}”. Nothing goes live until you publish it.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={duplicate.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="dup-form" pending={duplicate.isPending} pendingLabel="Duplicating…">
            Duplicate
          </Button>
        </>
      }>
      <form id="dup-form" className="form-stack dup-form" noValidate onSubmit={submit}>
        <Field id="dup-title" label="Title" error={errors.title}>
          <input id="dup-title" value={title} maxLength={120} onChange={ev => setTitle(ev.target.value)} aria-invalid={errors.title ? true : undefined} />
        </Field>

        <div className="dup-when">
          <div className="dup-when-head">
            <span className="dup-label">When</span>
            <SegmentedControl
              label="Start the copy"
              value={preset as '7' | '14' | '30'}
              onChange={pick}
              options={[
                {value: '7', label: 'In 1 week'},
                {value: '14', label: '2 weeks'},
                {value: '30', label: '1 month'},
              ]}
            />
          </div>
          <div className="form-grid dup-dates">
            <Field id="dup-start" label="Starts" error={errors.startAt}>
              <DateTimeField
                id="dup-start"
                value={start}
                onChange={ev => {
                  setStart(ev.target.value);
                  setPreset('custom');
                }}
                aria-invalid={errors.startAt ? true : undefined}
              />
            </Field>
            <Field id="dup-end" label="Ends" error={errors.endAt}>
              <DateTimeField
                id="dup-end"
                value={end}
                onChange={ev => {
                  setEnd(ev.target.value);
                  setPreset('custom');
                }}
                aria-invalid={errors.endAt ? true : undefined}
              />
            </Field>
          </div>
          <p className="dup-zone">
            <Icon name="globe" size={14} />
            Times are in {event.timezone.replace(/_/g, ' ')}.
          </p>
        </div>

        <ul className="dup-copied" aria-label="What is copied">
          <li>
            <Icon name="check" size={14} />
            Questions, tickets, reminders and polls (votes reset)
          </li>
          <li data-off="">
            <Icon name="x" size={14} />
            Guests, orders and messages stay with the original
          </li>
        </ul>
        {errors.form && <Notice tone="danger">{errors.form}</Notice>}
      </form>
    </Modal>
  );
}

/** The lifecycle buttons of the hub header: Publish / Unpublish, Duplicate, Delete (Cancel lives in the Events list's row menu). */
export function HubActions({event, onPublishProblem}: {event: HubActionEvent; onPublishProblem: (error: ApiError | null) => void}) {
  const {publish, unpublish, remove} = useEventLifecycle();
  const confirm = useConfirm();
  const toast = useToast();
  const go = useEventsNav();
  const [duplicating, setDuplicating] = useState(false);

  const doPublish = () => {
    onPublishProblem(null);
    publish.mutate(event.id, {
      onSuccess: () => toast.success('Event published.'),
      onError: err => (err instanceof ApiError && err.status === 409 ? onPublishProblem(err) : toast.danger(err.message)),
    });
  };

  const doDelete = () =>
    void confirm({
      title: `Delete “${event.title}”?`,
      body: 'This draft will be removed. Only drafts can be deleted.',
      confirmLabel: 'Delete draft',
      pendingLabel: 'Deleting…',
      action: async () => {
        await remove.mutateAsync(event.id);
        toast.success('Draft deleted.');
        go('/events');
      },
    });

  return (
    <>
      <Button variant="secondary" icon="copy" onClick={() => setDuplicating(true)}>
        Duplicate
      </Button>
      {event.status === 'draft' && (
        <>
          {canDelete(event) && (
            <Button variant="ghost" icon="trash" onClick={doDelete}>
              Delete
            </Button>
          )}
          <Button pending={publish.isPending} pendingLabel="Publishing…" onClick={doPublish}>
            Publish
          </Button>
        </>
      )}
      {canUnpublish(event) && (
        <Button
          variant="secondary"
          pending={unpublish.isPending}
          pendingLabel="Unpublishing…"
          onClick={() => unpublish.mutate(event.id, {onSuccess: () => toast.success('Event is a draft again.'), onError: err => toast.danger(err.message)})}>
          Unpublish
        </Button>
      )}
      {duplicating && <DuplicateDialog event={event} onClose={() => setDuplicating(false)} />}
    </>
  );
}
