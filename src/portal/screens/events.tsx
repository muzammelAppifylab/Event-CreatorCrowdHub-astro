import {useInfiniteQuery, useMutation, useQueryClient} from '@tanstack/react-query';
import {useRef, useState} from 'react';

import {formatInZone} from '../../domain/time';
import {
  type AdminEventSummary,
  type CancelPreview,
  type EventListTab,
  EVENT_LIST_TABS,
  fromLocalInput,
  toLocalInput,
} from '../../lib/event-schemas';
import {api, ApiError, read} from '../api';
import {eventsListQuery, fieldAria, focusFirstInvalid, useEventsNav} from '../events-queries';
import {
  Badge,
  Button,
  Card,
  type Column,
  DataTable,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  LoadMore,
  Menu,
  Modal,
  PageHeader,
  SearchInput,
  StatusBadge,
  Tabs,
  useConfirm,
  useToast,
  DateTimeField,
} from '../ui';

const TAB_LABELS: Record<EventListTab, string> = {upcoming: 'Upcoming', past: 'Past', drafts: 'Drafts'};
const STATUS_TONES = {draft: 'neutral', published: 'success', cancelled: 'danger'} as const;
const FORMAT_LABELS = {in_person: 'In person', online: 'Online', hybrid: 'Hybrid'} as const;
const VISIBILITY_LABELS = {public: 'Public', unlisted: 'Unlisted', private: 'Private'} as const;
const EMPTY_TEXT: Record<EventListTab, string> = {
  upcoming: 'Create an event and share the link. Every guest lands in your Guests list.',
  past: 'Events move here once they end, with their guest lists kept.',
  drafts: 'Saved but unpublished events wait here until you publish them.',
};
const EMPTY_TITLE: Record<EventListTab, string> = {upcoming: 'No upcoming events', past: 'No past events yet', drafts: 'No drafts'};
const EMPTY_ACTION: Record<EventListTab, string> = {upcoming: 'Create your first event', past: 'See upcoming events', drafts: 'Start a draft'};
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const MONTH = (e: AdminEventSummary) => new Intl.DateTimeFormat('en', {month: 'short', timeZone: e.timezone}).format(new Date(e.startAt));
const DAY = (e: AdminEventSummary) => new Intl.DateTimeFormat('en', {day: 'numeric', timeZone: e.timezone}).format(new Date(e.startAt));
const when = (e: AdminEventSummary) => formatInZone(new Date(e.startAt), e.timezone);

/** `/dashboard/events` for holders of `site:event:manage`: every event, by tab. */
export function Events() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const go = useEventsNav();
  const [tab, setTab] = useState<EventListTab>('upcoming');
  const [copying, setCopying] = useState<AdminEventSummary | null>(null);
  const events = useInfiniteQuery(eventsListQuery(tab));
  const [search, setSearch] = useState('');
  const all = events.data?.pages.flatMap(page => page.events);
  const needle = search.trim().toLowerCase();
  const rows = needle ? all?.filter(e => `${e.title} ${e.slug}`.toLowerCase().includes(needle)) : all;
  const refresh = () => queryClient.invalidateQueries({queryKey: ['events']});

  const publish = useMutation({
    mutationFn: (e: AdminEventSummary) => read(api['admin-events'][':id'].publish.$post({param: {id: e.id}})),
    onSuccess: (_d, e) => {
      toast.success(`Published “${e.title}”.`);
      return refresh();
    },
  });
  const unpublish = useMutation({
    mutationFn: (e: AdminEventSummary) => read(api['admin-events'][':id'].unpublish.$post({param: {id: e.id}})),
    onSuccess: (_d, e) => {
      toast.success(`“${e.title}” is a draft again.`);
      return refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: (e: AdminEventSummary) => read(api['admin-events'][':id'].cancel.$post({param: {id: e.id}})),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (e: AdminEventSummary) => read(api['admin-events'][':id'].$delete({param: {id: e.id}})),
    onSuccess: refresh,
  });
  const preview = useMutation({
    mutationFn: (e: AdminEventSummary) => read<CancelPreview>(api['admin-events'][':id']['cancel-preview'].$get({param: {id: e.id}})),
  });

  const busyKey =
    (publish.isPending && publish.variables?.id) ||
    (unpublish.isPending && unpublish.variables?.id) ||
    (cancel.isPending && cancel.variables?.id) ||
    (remove.isPending && remove.variables?.id) ||
    (preview.isPending && preview.variables?.id) ||
    null;
  const rowError = publish.error ?? unpublish.error ?? preview.error;

  const askCancel = async (e: AdminEventSummary) => {
    const p = await preview.mutateAsync(e).catch(() => null);
    if (!p) return;
    const money = p.ordersToRefund
      ? ` ${p.ordersToRefund} paid ${p.ordersToRefund === 1 ? 'order needs' : 'orders need'} a refund (${(p.refundTotalCents / 100).toFixed(2)} ${p.currency ?? ''}).`
      : '';
    void confirm({
      title: `Cancel “${e.title}”?`,
      body: `The event page shows as cancelled and ${p.guestsToEmail} ${p.guestsToEmail === 1 ? 'guest is' : 'guests are'} affected.${money} This can’t be undone.`,
      confirmLabel: 'Cancel event',
      pendingLabel: 'Cancelling…',
      action: () => cancel.mutateAsync(e),
    }).then(ok => ok && toast.success(`Cancelled “${e.title}”.`));
  };
  const askDelete = (e: AdminEventSummary) =>
    void confirm({
      title: `Delete “${e.title}”?`,
      body: 'The draft is removed. Only drafts can be deleted; cancel a published event instead.',
      confirmLabel: 'Delete draft',
      pendingLabel: 'Deleting…',
      action: () => remove.mutateAsync(e),
    }).then(ok => ok && toast.success(`Deleted “${e.title}”.`));

  const columns: Column<AdminEventSummary>[] = [
    {
      key: 'title',
      header: 'Event',
      cell: e => (
        <div className="event-cell">
          <div className="event-date" aria-hidden="true">
            <span className="event-date-month">{MONTH(e)}</span>
            <span className="event-date-day">{DAY(e)}</span>
          </div>
          <div>
          <span className="cell-title">
            <a
              href={`/dashboard/events/${e.id}`}
              onClick={ev => {
                if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
                ev.preventDefault();
                go(`/events/${e.id}`);
              }}>
              {e.title}
            </a>
          </span>
          <span className="cell-sub">
            {FORMAT_LABELS[e.format]} · /e/{e.slug}
          </span>
          </div>
        </div>
      ),
    },
    {key: 'when', header: 'Date', width: 'shrink', cell: e => when(e)},
    {
      key: 'status',
      header: 'Status',
      width: 'shrink',
      cell: e => <StatusBadge tone={STATUS_TONES[e.status]}>{e.status === 'draft' ? 'Draft' : e.status === 'published' ? 'Published' : 'Cancelled'}</StatusBadge>,
    },
    {key: 'visibility', header: 'Visibility', width: 'shrink', hideOnMobile: true, cell: e => VISIBILITY_LABELS[e.visibility]},
    {
      key: 'guests',
      header: 'Going',
      width: 'shrink',
      hideOnMobile: true,
      cell: e => (
        <span>
          <strong>{e.counts.confirmed}</strong>
          <span className="muted"> / {e.capacity ?? 'No limit'}</span>
          {e.counts.waitlisted > 0 && (
            <>
              {' '}
              <Badge tone="warning">{e.counts.waitlisted} waiting</Badge>
            </>
          )}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: e =>
        busyKey === e.id ? (
          <IconButton icon="more" label={`Working on “${e.title}”`} size="sm" pending />
        ) : (
          <Menu
            label={`Actions for “${e.title}”`}
            disabled={busyKey !== null}
            items={[
              {label: 'Open event hub', icon: 'dashboard', onSelect: () => go(`/events/${e.id}`)},
              {label: 'Guests', icon: 'users', onSelect: () => go(`/events/${e.id}?tab=guests`)},
              {label: 'Edit', icon: 'pencil', onSelect: () => go(`/events/${e.id}/edit`)},
              e.status === 'draft'
                ? {label: 'Publish', icon: 'check-circle', onSelect: () => publish.mutate(e)}
                : e.status === 'published'
                  ? {label: 'Unpublish', icon: 'ban', onSelect: () => unpublish.mutate(e)}
                  : {label: 'Cancelled', icon: 'ban', disabled: true, onSelect: () => undefined},
              {label: 'Duplicate', icon: 'copy', onSelect: () => setCopying(e)},
              {label: 'View public page', icon: 'external', disabled: e.status !== 'published', onSelect: () => void window.open(`/e/${encodeURIComponent(e.slug)}`, '_blank', 'noopener')},
              'separator',
              ...(e.status === 'published' ? [{label: 'Cancel event', icon: 'x' as const, danger: true, onSelect: () => void askCancel(e)}] : []),
              ...(e.status === 'draft' ? [{label: 'Delete draft', icon: 'trash' as const, danger: true, onSelect: () => askDelete(e)}] : []),
            ]}
          />
        ),
    },
  ];

  return (
    <div className="app-page screen-events">
      <PageHeader
        title="Events"
        description="Everything you're running, have run, or are still drafting."
        actions={
          <Button icon="plus" onClick={() => go('/events/new')}>
            Create event
          </Button>
        }
      />

      {rowError && <ErrorNote error={rowError} />}

      <Tabs
        label="Event lists"
        value={tab}
        onChange={setTab}
        items={EVENT_LIST_TABS.map(value => ({value, label: TAB_LABELS[value]}))}>
        <div className="toolbar">
          <SearchInput label="Search events" placeholder="Search loaded events by title" value={search} onChange={ev => setSearch(ev.target.value)} />
        </div>
        <Card flush>
          <DataTable
            caption={`${TAB_LABELS[tab]} events`}
            columns={columns}
            rows={rows}
            rowKey={e => e.id}
            loading={events.isPending}
            error={events.error}
            busyKey={busyKey}
            empty={
              needle ? (
                <EmptyState icon="search" title="No matching events">
                  Nothing in {TAB_LABELS[tab]} matches “{search.trim()}”.
                </EmptyState>
              ) : (
              <EmptyState
                icon={tab === 'drafts' ? 'file' : 'clock'}
                title={EMPTY_TITLE[tab]}
                action={
                  tab === 'past' ? (
                    <Button variant="secondary" onClick={() => setTab('upcoming')}>
                      {EMPTY_ACTION[tab]}
                    </Button>
                  ) : (
                    <Button icon="plus" onClick={() => go('/events/new')}>
                      {EMPTY_ACTION[tab]}
                    </Button>
                  )
                }>
                {EMPTY_TEXT[tab]}
              </EmptyState>
              )
            }
          />
        </Card>
        <LoadMore query={events} />
      </Tabs>

      <DuplicateModal
        event={copying}
        onClose={() => setCopying(null)}
        onDone={created => {
          setCopying(null);
          toast.success('Copy saved as a draft');
          void refresh();
          go(`/events/${created}`);
        }}
      />
    </div>
  );
}

/** Asks for the copy's new dates (in the event's own timezone), then duplicates. */
function DuplicateModal({event, onClose, onDone}: {event: AdminEventSummary | null; onClose: () => void; onDone: (id: string) => void}) {
  return event ? <DuplicateForm key={event.id} event={event} onClose={onClose} onDone={onDone} /> : <Modal open={false} onClose={onClose} title="Duplicate event" />;
}

function DuplicateForm({event, onClose, onDone}: {event: AdminEventSummary; onClose: () => void; onDone: (id: string) => void}) {
  const shifted = (iso: string) => toLocalInput(new Date(new Date(iso).getTime() + WEEK_MS).toISOString(), event.timezone);
  const [title, setTitle] = useState(`${event.title} (copy)`.slice(0, 120));
  const [start, setStart] = useState(shifted(event.startAt));
  const [end, setEnd] = useState(shifted(event.endAt));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const copy = useMutation({
    mutationFn: (body: {title: string; startAt: string; endAt: string}) =>
      read<{event: {id: string}}>(api['admin-events'][':id'].duplicate.$post({param: {id: event.id}, json: body})),
    onSuccess: ({event: created}) => onDone(created.id),
    onError: err => {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setErrors(err.fields);
        focusFirstInvalid(formRef.current);
      }
    },
  });
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const startAt = fromLocalInput(start, event.timezone);
    const endAt = fromLocalInput(end, event.timezone);
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = 'Enter a title.';
    if (!startAt) next.startAt = 'Enter a valid date and time.';
    if (!endAt) next.endAt = 'Enter a valid date and time.';
    if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) next.endAt = 'End must be after the start.';
    setErrors(next);
    if (Object.keys(next).length) return focusFirstInvalid(formRef.current);
    copy.mutate({title: title.trim(), startAt: startAt!, endAt: endAt!});
  };
  const failed = copy.error && !(copy.error instanceof ApiError && Object.keys(copy.error.fields).length);
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!copy.isPending}
      title="Duplicate event"
      description={`Copies settings, questions, tickets, reminders and polls (with votes reset). Guests and orders stay with the original. The copy starts as a draft. Times are in the event's timezone, ${event.timezone.replace(/_/g, ' ')}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={copy.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="duplicate-event" pending={copy.isPending} pendingLabel="Copying…">
            Create copy
          </Button>
        </>
      }>
      <form ref={formRef} id="duplicate-event" className="form-stack" noValidate onSubmit={submit}>
        <Field id="dup-title" label="Title of the copy" error={errors.title}>
          <input id="dup-title" {...fieldAria('dup-title', errors.title)} value={title} onChange={ev => setTitle(ev.target.value)} maxLength={120} autoComplete="off" />
        </Field>
        <div className="form-grid">
          <Field id="dup-start" label="Starts" error={errors.startAt}>
            <DateTimeField id="dup-start" {...fieldAria('dup-start', errors.startAt)} value={start} onChange={ev => setStart(ev.target.value)} />
          </Field>
          <Field id="dup-end" label="Ends" error={errors.endAt}>
            <DateTimeField id="dup-end" {...fieldAria('dup-end', errors.endAt)} value={end} onChange={ev => setEnd(ev.target.value)} />
          </Field>
        </div>
        {failed && <ErrorNote error={copy.error!} />}
      </form>
    </Modal>
  );
}
