import {useQueryClient} from '@tanstack/react-query';
import {type FormEvent, useState} from 'react';

import {fromLocalInput} from '../../lib/event-schemas';
import {formatMoney} from '../../lib/format';
import {ApiError} from '../api';
import {cancelPreviewQuery, useEventLifecycle, useEventsNav} from '../events-queries';
import {Button, Field, Modal, Notice, useConfirm, useToast} from '../ui';

export type HubActionEvent = {id: string; title: string; status: 'draft' | 'published' | 'cancelled'; endAt: string; startAt: string; timezone: string};

/** Cancel only makes sense for a live event that hasn't ended. */
export const canCancel = (e: Pick<HubActionEvent, 'status' | 'endAt'>) => e.status === 'published' && Date.parse(e.endAt) > Date.now();

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
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

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
      description="Questions, tickets and email reminders are copied into a new draft. Pick its dates."
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
      <form id="dup-form" noValidate onSubmit={submit}>
        <Field id="dup-title" label="Title" error={errors.title}>
          <input id="dup-title" value={title} maxLength={120} onChange={ev => setTitle(ev.target.value)} aria-invalid={errors.title ? true : undefined} />
        </Field>
        <div className="form-grid">
          <Field id="dup-start" label="Starts" error={errors.startAt}>
            <input id="dup-start" type="datetime-local" value={start} onChange={ev => setStart(ev.target.value)} aria-invalid={errors.startAt ? true : undefined} />
          </Field>
          <Field id="dup-end" label="Ends" error={errors.endAt} hint={`Times are in ${event.timezone}.`}>
            <input id="dup-end" type="datetime-local" value={end} onChange={ev => setEnd(ev.target.value)} aria-invalid={errors.endAt ? true : undefined} />
          </Field>
        </div>
        {errors.form && <Notice tone="danger">{errors.form}</Notice>}
      </form>
    </Modal>
  );
}

/** The lifecycle buttons of the hub header: Publish / Unpublish, Duplicate, Cancel event, Delete. */
export function HubActions({event, onPublishProblem}: {event: HubActionEvent; onPublishProblem: (error: ApiError | null) => void}) {
  const {publish, unpublish, cancel, remove} = useEventLifecycle();
  const queryClient = useQueryClient();
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

  const doCancel = async () => {
    let body: string;
    try {
      const p = await queryClient.fetchQuery(cancelPreviewQuery(event.id));
      const refund = p.currency ? formatMoney(p.refundTotalCents, p.currency) : null;
      body =
        `${p.guestsToEmail} ${p.guestsToEmail === 1 ? 'guest' : 'guests'} will be emailed. ` +
        (p.ordersToRefund
          ? `${p.ordersToRefund} paid ${p.ordersToRefund === 1 ? 'order' : 'orders'} will be refunded${refund ? ` (${refund} in total)` : ''}. `
          : 'No payments to refund. ') +
        'This can’t be undone.';
    } catch {
      body = 'We could not count who this affects. Guests will be emailed and paid tickets refunded. This can’t be undone.';
    }
    await confirm({
      title: `Cancel “${event.title}”?`,
      body,
      confirmLabel: 'Cancel event',
      pendingLabel: 'Cancelling…',
      action: async () => {
        await cancel.mutateAsync(event.id);
        toast.success('Event cancelled.');
      },
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
          <Button variant="ghost" icon="trash" onClick={doDelete}>
            Delete
          </Button>
          <Button pending={publish.isPending} pendingLabel="Publishing…" onClick={doPublish}>
            Publish
          </Button>
        </>
      )}
      {event.status === 'published' && (
        <Button
          variant="secondary"
          pending={unpublish.isPending}
          pendingLabel="Unpublishing…"
          onClick={() => unpublish.mutate(event.id, {onSuccess: () => toast.success('Event is a draft again.'), onError: err => toast.danger(err.message)})}>
          Unpublish
        </Button>
      )}
      {canCancel(event) && (
        <Button variant="danger" onClick={() => void doCancel()}>
          Cancel event
        </Button>
      )}
      {duplicating && <DuplicateDialog event={event} onClose={() => setDuplicating(false)} />}
    </>
  );
}
