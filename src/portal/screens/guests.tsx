import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {type FormEvent, useState} from 'react';

import {ApiError} from '../api';
import {
  answerText,
  type BulkAction,
  type BulkResult,
  downloadExport,
  type GuestFilter,
  type GuestRow,
  type GuestStatus,
  guestCount,
  guestDataUrl,
  guestQuery,
  guestsExportUrl,
  guestsQuery,
  NO_GUEST_FILTER,
  sendJson,
  summarizeBulk,
} from '../guests-queries';
import {ago, when} from '../shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  type Column,
  DataTable,
  DefinitionList,
  Drawer,
  EmptyState,
  ErrorNote,
  Field,
  LoadingBlock,
  LoadMore,
  Menu,
  Notice,
  PageHeader,
  rules,
  SearchInput,
  Select,
  Stat,
  StatusBadge,
  type Tone,
  useConfirm,
  useForm,
  useToast,
} from '../ui';

const STATUS_TONES: Record<GuestStatus, Tone> = {
  confirmed: 'success',
  pending: 'warning',
  waitlisted: 'info',
  awaiting_payment: 'warning',
  declined: 'neutral',
  cancelled: 'neutral',
};
const STATUS_LABELS: Record<GuestStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending',
  waitlisted: 'Waitlisted',
  awaiting_payment: 'Awaiting payment',
  declined: 'Declined',
  cancelled: 'Cancelled',
};
const RESPONSE_LABELS = {going: 'Going', maybe: 'Maybe', not_going: 'Can’t go'} as const;
const STATUS_OPTIONS = [
  {value: '', label: 'All statuses'},
  ...(Object.keys(STATUS_LABELS) as GuestStatus[]).map(value => ({value, label: STATUS_LABELS[value]})),
];
const TIMELINE_LABELS: Record<string, string> = {
  rsvped: 'RSVP’d',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  updated: 'Last updated',
};

const CONFIRM: Record<BulkAction, (n: number) => {title: string; body: string; label: string; danger: boolean}> = {
  approve: n => ({
    title: `Approve ${guestCount(n)}?`,
    body: 'Approved guests get a seat, or join the waitlist if the event is full. They are emailed.',
    label: 'Approve',
    danger: false,
  }),
  decline: n => ({
    title: `Decline ${guestCount(n)}?`,
    body: 'Their requests are marked declined and do not hold a seat. They are emailed.',
    label: 'Decline',
    danger: true,
  }),
  promote: n => ({
    title: `Promote ${guestCount(n)} from the waitlist?`,
    body: 'Guests are promoted in waitlist order while seats last. On paid events they get a link to claim and pay.',
    label: 'Promote',
    danger: false,
  }),
  remove: n => ({
    title: `Remove ${guestCount(n)}?`,
    body: 'This deletes their RSVP, answers and message history, and frees their seat. Guests who paid cannot be removed (erase them instead). It cannot be undone.',
    label: 'Remove',
    danger: true,
  }),
  erase: n => ({
    title: `Erase ${guestCount(n)}?`,
    body: 'Their name, email, answers and message history are removed. Payment records are kept for accounting. It cannot be undone.',
    label: 'Erase',
    danger: true,
  }),
};

/**
 * The guests tab of an event (`/dashboard/events/$id`): filter and search, pick guests for bulk
 * actions, open one in a drawer. `eventId` is the event's uuid.
 */
export function GuestsTab({eventId}: {eventId: string}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [filter, setFilter] = useState<GuestFilter>(NO_GUEST_FILTER);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const guests = useInfiniteQuery(guestsQuery(eventId, filter));
  const rows = guests.data?.pages.flatMap(page => page.items);
  const first = guests.data?.pages[0];
  const filtered = Object.values(filter).some(Boolean);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['guests', eventId]});

  const bulk = useMutation({
    mutationFn: ({action, rsvpIds}: {action: BulkAction; rsvpIds: string[]}) =>
      sendJson<BulkResult>('POST', `/events/${eventId}/guests/bulk`, {action, rsvpIds}),
    onSuccess: result => {
      const summary = summarizeBulk(result);
      if (summary.ok) toast.success(summary.message);
      else toast.danger(summary.message);
      setSelected(new Set());
      return refresh();
    },
  });

  // Only the row being acted on shows pending; a bulk action dims no single row.
  const busyId = bulk.isPending && bulk.variables?.rsvpIds.length === 1 ? bulk.variables.rsvpIds[0] : null;

  const ask = (action: BulkAction, ids: string[]) => {
    const text = CONFIRM[action](ids.length);
    void confirm({
      title: text.title,
      body: text.body,
      confirmLabel: `${text.label} ${guestCount(ids.length)}`,
      pendingLabel: 'Working…',
      tone: text.danger ? 'danger' : 'primary',
      action: () => bulk.mutateAsync({action, rsvpIds: ids}),
    });
  };

  const runSearch = (event: FormEvent) => {
    event.preventDefault();
    setFilter(current => ({...current, q: search.trim()}));
  };
  const clear = () => {
    setFilter(NO_GUEST_FILTER);
    setSearch('');
  };
  const toggle = (id: string, on: boolean) =>
    setSelected(current => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const exportCsv = async () => {
    setExporting(true);
    try {
      const {truncated} = await downloadExport(guestsExportUrl(eventId, filter), 'guests.csv');
      toast.success(truncated ? 'Exported the first 20,000 guests.' : 'Guest list exported.');
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : 'The export failed.');
    } finally {
      setExporting(false);
    }
  };

  const allOnPage = Boolean(rows?.length) && rows!.every(g => selected.has(g.id));
  const columns: Column<GuestRow>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select every guest shown"
          checked={allOnPage}
          onChange={event => setSelected(event.target.checked ? new Set(rows?.map(g => g.id)) : new Set())}
        />
      ),
      width: 'shrink',
      cell: g => (
        <input
          type="checkbox"
          aria-label={`Select ${g.name}`}
          checked={selected.has(g.id)}
          onChange={event => toggle(g.id, event.target.checked)}
        />
      ),
    },
    {
      key: 'guest',
      header: 'Guest',
      cell: g => (
        <div>
          <span className="cell-title">
            <Button variant="link" onClick={() => setOpen(g.id)}>
              {g.name}
            </Button>
          </span>
          <span className="cell-sub">{g.email}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'shrink',
      cell: g => (
        <StatusBadge tone={STATUS_TONES[g.status]}>
          {STATUS_LABELS[g.status]}
          {g.status === 'waitlisted' && g.waitlistPosition ? ` #${g.waitlistPosition}` : ''}
        </StatusBadge>
      ),
    },
    {key: 'response', header: 'Response', width: 'shrink', hideOnMobile: true, cell: g => RESPONSE_LABELS[g.response]},
    {key: 'seats', header: 'Seats', width: 'shrink', hideOnMobile: true, cell: g => g.seats},
    {key: 'ticket', header: 'Ticket', hideOnMobile: true, cell: g => g.ticketTypeName ?? <span className="muted">Free</span>},
    {key: 'code', header: 'Code', width: 'shrink', hideOnMobile: true, cell: g => <code>{g.ticketCode}</code>},
    {key: 'payment', header: 'Payment', width: 'shrink', hideOnMobile: true, cell: g => g.paymentStatus ?? <span className="muted">—</span>},
    ...(first?.questions ?? []).map(q => ({
      key: `q-${q.id}`,
      header: q.label,
      hideOnMobile: true,
      cell: (g: GuestRow) => answerText(g.answers[q.id]) || <span className="muted">—</span>,
    })),
    {
      key: 'checked',
      header: 'Checked in',
      width: 'shrink',
      hideOnMobile: true,
      cell: g => (g.checkedInAt ? <Badge tone="success" icon="check">{ago(g.checkedInAt)}</Badge> : <span className="muted">No</span>),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: g => (
        <Menu
          label={`Actions for ${g.name}`}
          disabled={bulk.isPending}
          items={[
            {label: 'View details', icon: 'file', onSelect: () => setOpen(g.id)},
            ...(g.status === 'pending'
              ? [
                  {label: 'Approve', icon: 'check' as const, onSelect: () => ask('approve', [g.id])},
                  {label: 'Decline', icon: 'ban' as const, onSelect: () => ask('decline', [g.id])},
                ]
              : []),
            ...(g.status === 'waitlisted' ? [{label: 'Promote', icon: 'trending-up' as const, onSelect: () => ask('promote', [g.id])}] : []),
            'separator' as const,
            {label: 'Remove', icon: 'trash', danger: true, onSelect: () => ask('remove', [g.id])},
            {label: 'Erase personal data', icon: 'lock', danger: true, onSelect: () => ask('erase', [g.id])},
          ]}
        />
      ),
    },
  ];

  const ids = [...selected];
  const counts = first?.statusCounts ?? {};
  return (
    <div className="app-page screen-guests">
      <div className="grid-3">
        <Stat label="Confirmed" value={first ? String(counts.confirmed ?? 0) : null} icon="check-circle" />
        <Stat label="Pending approval" value={first ? String(counts.pending ?? 0) : null} icon="clock" />
        <Stat label="Waitlisted" value={first ? String(counts.waitlisted ?? 0) : null} icon="users" />
      </div>

      <div className="toolbar">
        <form role="search" onSubmit={runSearch} noValidate>
          <SearchInput
            label="Search guests"
            placeholder="Name, email or ticket code, then Enter"
            value={search}
            maxLength={120}
            autoComplete="off"
            onChange={event => {
              setSearch(event.target.value);
              if (!event.target.value && filter.q) setFilter(current => ({...current, q: ''}));
            }}
          />
        </form>
        <div className="toolbar-group">
          <Select
            aria-label="Status"
            value={filter.status}
            options={STATUS_OPTIONS}
            onChange={event => setFilter(current => ({...current, status: event.target.value}))}
          />
          {first && first.ticketTypes.length > 0 && (
            <Select
              aria-label="Ticket type"
              value={filter.ticketTypeId}
              options={[{value: '', label: 'All tickets'}, ...first.ticketTypes.map(t => ({value: t.id, label: t.name}))]}
              onChange={event => setFilter(current => ({...current, ticketTypeId: event.target.value}))}
            />
          )}
          <Checkbox
            label="Checked in"
            checked={filter.checkedIn === 'yes'}
            onChange={on => setFilter(current => ({...current, checkedIn: on ? 'yes' : ''}))}
          />
          {filtered && (
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear filters
            </Button>
          )}
          <Button variant="secondary" icon="file" pending={exporting} pendingLabel="Exporting…" onClick={() => void exportCsv()}>
            Export CSV
          </Button>
        </div>
      </div>

      {selected.size > 0 && (
        <Notice
          title={`${guestCount(selected.size)} selected`}
          action={
            <div className="toolbar-group">
              <Button size="sm" icon="check" disabled={bulk.isPending} onClick={() => ask('approve', ids)}>
                Approve
              </Button>
              <Button size="sm" variant="secondary" disabled={bulk.isPending} onClick={() => ask('decline', ids)}>
                Decline
              </Button>
              <Button size="sm" variant="secondary" disabled={bulk.isPending} onClick={() => ask('promote', ids)}>
                Promote
              </Button>
              <Menu
                label="More bulk actions"
                disabled={bulk.isPending}
                items={[
                  {label: 'Remove', icon: 'trash', danger: true, onSelect: () => ask('remove', ids)},
                  {label: 'Erase personal data', icon: 'lock', danger: true, onSelect: () => ask('erase', ids)},
                  'separator',
                  {label: 'Clear selection', icon: 'x', onSelect: () => setSelected(new Set())},
                ]}
              />
            </div>
          }
        />
      )}

      <Card flush>
        <DataTable
          caption="Guests"
          columns={columns}
          rows={rows}
          rowKey={g => g.id}
          busyKey={busyId}
          loading={guests.isPending}
          error={guests.error}
          empty={
            filtered ? (
              <EmptyState icon="search" title="No guests match" action={<Button variant="secondary" onClick={clear}>Clear filters</Button>}>
                Try another search or clear the filters.
              </EmptyState>
            ) : (
              <EmptyState icon="users" title="No guests yet">
                RSVPs show up here as soon as people respond.
              </EmptyState>
            )
          }
        />
      </Card>
      <LoadMore query={guests} />

      <GuestDrawer eventId={eventId} rsvpId={open} onClose={() => setOpen(null)} onAction={(action, id) => {
          setOpen(null);
          ask(action, [id]);
        }} />
    </div>
  );
}

const GUEST_RULES = {
  name: [rules.required('Enter a name.'), rules.maxLength(120)],
  email: [rules.required('Enter an email address.'), rules.maxLength(254)],
  plusOnes: [rules.pattern(/^(10|[0-9])$/, 'Plus-ones are a whole number from 0 to 10.')],
};

/** One guest: details, answers, timeline and an edit form. */
function GuestDrawer({
  eventId,
  rsvpId,
  onClose,
  onAction,
}: {
  eventId: string;
  rsvpId: string | null;
  onClose: () => void;
  onAction: (action: BulkAction, id: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const detail = useQuery({...guestQuery(eventId, rsvpId ?? ''), enabled: Boolean(rsvpId)});
  const guest = detail.data;
  const form = useForm({name: '', email: '', plusOnes: '0', marketingConsent: false as boolean}, GUEST_RULES);
  const [loaded, setLoaded] = useState<string | null>(null);
  // Fill the form once per opened guest (and again after a save).
  if (guest && loaded !== `${guest.id}:${guest.updatedAt}`) {
    setLoaded(`${guest.id}:${guest.updatedAt}`);
    form.reset({name: guest.name, email: guest.email, plusOnes: String(guest.plusOnes), marketingConsent: guest.marketingConsent});
  }

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => sendJson<unknown>('PATCH', `/events/${eventId}/guests/${rsvpId}`, body),
    onSuccess: (_data, body) => {
      toast.success(body.checkedIn === undefined ? 'Guest updated.' : body.checkedIn ? 'Checked in.' : 'Check-in undone.');
      return queryClient.invalidateQueries({queryKey: ['guests', eventId]});
    },
    onError: err => err instanceof ApiError && form.setServerErrors(err.fields),
  });
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (!rsvpId) return;
    setDownloading(true);
    try {
      await downloadExport(guestDataUrl(eventId, rsvpId), 'guest-data.json');
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : 'The download failed.');
    } finally {
      setDownloading(false);
    }
  };
  const close = () => {
    if (save.isPending) return;
    setLoaded(null);
    save.reset();
    onClose();
  };

  return (
    <Drawer
      open={Boolean(rsvpId)}
      onClose={close}
      title={guest?.name ?? 'Guest'}
      description={guest ? `${STATUS_LABELS[guest.status]} · ticket ${guest.ticketCode}` : undefined}
      dismissible={!save.isPending}
      onSubmit={form.submit(values =>
        save.mutate({
          name: values.name,
          email: values.email,
          plusOnes: Number(values.plusOnes),
          marketingConsent: values.marketingConsent,
        })
      )}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            Close
          </Button>
          <Button type="submit" pending={save.isPending && save.variables?.checkedIn === undefined} pendingLabel="Saving…" disabled={!guest || save.isPending}>
            Save changes
          </Button>
        </>
      }>
      {detail.isPending && rsvpId && <LoadingBlock />}
      {detail.error && <ErrorNote error={detail.error} />}
      {guest && (
        <>
          {save.error && !(save.error instanceof ApiError && Object.keys(save.error.fields).length) && <ErrorNote error={save.error} />}
          <Field label="Name" id="f-name" error={form.error('name')}>
            <input type="text" autoComplete="off" maxLength={120} {...form.field('name')} />
          </Field>
          <Field label="Email" id="f-email" error={form.error('email')}>
            <input type="email" autoComplete="off" maxLength={254} {...form.field('email')} />
          </Field>
          <Field label="Plus-ones" id="f-plusOnes" error={form.error('plusOnes')} hint="Changes the seats this guest holds.">
            <input type="number" inputMode="numeric" min={0} max={10} {...form.field('plusOnes')} />
          </Field>
          <Checkbox
            label="Marketing consent"
            description="Turning it on needs the guest’s own confirmation; you can switch it off here."
            checked={form.values.marketingConsent}
            disabled={!guest.marketingConsent}
            onChange={on => form.set('marketingConsent', on)}
          />

          <h3>Details</h3>
          <DefinitionList
            items={[
              {label: 'Response', value: RESPONSE_LABELS[guest.response]},
              {label: 'Seats', value: guest.seats},
              {label: 'Ticket', value: guest.ticketTypeName ?? 'Free'},
              {label: 'Payment', value: guest.paymentStatus ?? '—'},
              {label: 'Source', value: guest.source},
              {label: 'Checked in', value: guest.checkedInAt ? when(guest.checkedInAt) : 'No'},
              ...(guest.status === 'waitlisted' ? [{label: 'Waitlist position', value: guest.waitlistPosition ?? '—'}] : []),
            ]}
          />

          {guest.questions.length > 0 && (
            <>
              <h3>Answers</h3>
              <DefinitionList items={guest.questions.map(q => ({label: q.label, value: answerText(guest.answers[q.id]) || '—'}))} />
            </>
          )}

          <h3>Timeline</h3>
          <DefinitionList items={guest.timeline.map(t => ({label: TIMELINE_LABELS[t.kind] ?? t.kind, value: when(t.at)}))} />

          <div className="toolbar-group">
            {guest.status === 'pending' && (
              <>
                <Button variant="secondary" onClick={() => onAction('approve', guest.id)}>Approve</Button>
                <Button variant="secondary" onClick={() => onAction('decline', guest.id)}>Decline</Button>
              </>
            )}
            {guest.status === 'waitlisted' && (
              <Button variant="secondary" onClick={() => onAction('promote', guest.id)}>Promote from waitlist</Button>
            )}
            {guest.status === 'confirmed' && (
              <Button
                variant="secondary"
                icon="check"
                pending={save.isPending && save.variables?.checkedIn !== undefined}
                pendingLabel="Saving…"
                disabled={save.isPending}
                onClick={() => save.mutate({checkedIn: !guest.checkedInAt})}>
                {guest.checkedInAt ? 'Undo check-in' : 'Check in'}
              </Button>
            )}
            <Button variant="secondary" icon="file" pending={downloading} pendingLabel="Preparing…" onClick={() => void download()}>
              Download data (JSON)
            </Button>
            <Button variant="danger" icon="trash" onClick={() => onAction('remove', guest.id)}>
              Remove
            </Button>
          </div>
        </>
      )}
    </Drawer>
  );
}
