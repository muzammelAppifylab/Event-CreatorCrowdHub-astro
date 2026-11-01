import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link, useParams} from '@tanstack/react-router';
import {type FormEvent, useRef, useState} from 'react';

import {
  ApiError,
  attendeesQuery,
  call,
  type DoorCounts,
  type DoorGuest,
  doorListQuery,
  type DoorToggle,
  doorTime,
  eventWhen,
  partyName,
} from '../checkin-queries';
import {
  Badge,
  Button,
  buttonClass,
  Card,
  Checkbox,
  type Column,
  DataTable,
  EmptyState,
  ErrorNote,
  Field,
  LoadMore,
  Notice,
  PageHeader,
  SearchInput,
  Stat,
  useToast,
} from '../ui';

const STATUS_WORDS: Record<string, string> = {
  pending: 'Pending',
  waitlisted: 'Waitlisted',
  declined: 'Declined',
  cancelled: 'Cancelled',
  awaiting_payment: 'Awaiting payment',
};

const failureMessage = (error: unknown, who?: string) => {
  if (error instanceof ApiError && error.status === 409) return `${who ?? 'That guest'} isn't confirmed, so they can't be checked in.`;
  if (error instanceof ApiError && error.status === 404) return 'No guest has that ticket code. Check it and try again.';
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
};

/** `/dashboard/checkin/$eventId`: the door screen. Big targets, one search, one ticket-code field. */
export function CheckinEvent({eventId: eventIdProp}: {eventId?: string} = {}) {
  const params = useParams({strict: false}) as {eventId?: string};
  const eventId = eventIdProp ?? params.eventId ?? '';
  const queryClient = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [lastScan, setLastScan] = useState<DoorGuest | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  const list = useQuery({...doorListQuery(eventId, q), placeholderData: previous => previous});
  const refreshList = () => queryClient.invalidateQueries({queryKey: ['checkin', 'list', eventId]});

  const toggle = useMutation({
    mutationFn: ({ticketCode, checkedIn}: {ticketCode: string; checkedIn: boolean; guest: DoorGuest}) =>
      call<DoorToggle>(`/checkin/codes/${encodeURIComponent(ticketCode)}`, {checkedIn}),
    onSuccess: (_, vars) => {
      if (!vars.checkedIn) setLastScan(prev => (prev && prev.ticketCode === vars.ticketCode ? null : prev));
      toast.success(vars.checkedIn ? `${vars.guest.name} checked in.` : `Check-in undone for ${vars.guest.name}.`);
      return refreshList();
    },
    onError: (error, vars) => toast.danger(failureMessage(error, vars.guest.name)),
  });

  const scan = useMutation({
    mutationFn: (ticketCode: string) => call<DoorToggle>(`/checkin/codes/${encodeURIComponent(ticketCode)}`, {checkedIn: true}),
    onSuccess: res => {
      setLastScan(res.guest);
      setCode('');
      setCodeError('');
      void refreshList();
      codeInput.current?.focus();
    },
    onError: error => {
      setLastScan(null);
      setCodeError(failureMessage(error));
    },
  });

  function submitCode(e: FormEvent) {
    e.preventDefault();
    const value = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(value)) {
      setCodeError('Enter the ticket code: 4 to 12 letters and numbers.');
      codeInput.current?.focus();
      return;
    }
    scan.mutate(value);
  }

  const data = list.data;
  const event = data?.event;
  const counts: DoorCounts | undefined = data?.counts;
  const busyCode = toggle.isPending ? toggle.variables.ticketCode : null;

  const columns: Column<DoorGuest>[] = [
    {
      key: 'name',
      header: 'Guest',
      cell: g => (
        <>
          <span className="cell-title">{partyName(g)}</span>
          <span className="muted"> {g.ticketCode}</span>
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'shrink',
      cell: g =>
        g.checkedInAt && event ? (
          <Badge tone="success" icon="check">
            In at {doorTime(g.checkedInAt, event.timezone)}
          </Badge>
        ) : g.status !== 'confirmed' ? (
          <Badge tone="warning">{STATUS_WORDS[g.status] ?? g.status}</Badge>
        ) : (
          <Badge>Not in yet</Badge>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: g => {
        const checkedIn = g.checkedInAt !== null;
        return (
          <Button
            size="lg"
            variant={checkedIn ? 'secondary' : 'primary'}
            aria-label={`${checkedIn ? 'Undo check-in for' : 'Check in'} ${g.name}`}
            disabled={busyCode !== null && busyCode !== g.ticketCode}
            pending={busyCode === g.ticketCode}
            pendingLabel={checkedIn ? 'Undoing…' : 'Checking in…'}
            onClick={() => toggle.mutate({ticketCode: g.ticketCode, checkedIn: !checkedIn, guest: g})}>
            {checkedIn ? 'Undo' : 'Check in'}
          </Button>
        );
      },
    },
  ];

  if (list.error instanceof ApiError && list.error.status === 404) {
    return (
      <div className="app-page screen-checkin">
        <EmptyState
          icon="users"
          title="Event not found"
          action={
            <Link to={'/checkin' as never} className={buttonClass({variant: 'secondary'})}>
              Back to events
            </Link>
          }>
          It may be unpublished or deleted.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="app-page screen-checkin">
      <PageHeader
        title={event?.title ?? 'Door list'}
        description={event ? eventWhen(event.startAt, event.timezone) : undefined}
        actions={
          <Link to={'/checkin' as never} className={buttonClass({variant: 'secondary'})}>
            All events
          </Link>
        }
      />

      <Stat
        label="Checked in"
        value={counts ? `${counts.checkedInSeats} / ${counts.expectedSeats}` : null}
        icon="users"
        hint={counts ? `${counts.checkedInGuests} of ${counts.expectedGuests} parties` : undefined}
      />

      <Card title="Ticket code" description="Type or scan a ticket code, then press Check in.">
        <form className="toolbar" noValidate onSubmit={submitCode}>
          <Field label="Ticket code" id="door-code" error={codeError}>
            <input
              id="door-code"
              ref={codeInput}
              autoFocus
              enterKeyHint="go"
              value={code}
              onChange={e => {
                setCode(e.target.value);
                setCodeError('');
              }}
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={12}
              placeholder="e.g. K7M2QX9A"
              aria-invalid={codeError ? true : undefined}
              aria-describedby={codeError ? 'door-code-error' : undefined}
            />
          </Field>
          <Button type="submit" size="lg" icon="check" pending={scan.isPending} pendingLabel="Checking in…">
            Check in
          </Button>
        </form>
        {lastScan && (
          <Notice tone="success" title={`${partyName(lastScan)} is checked in`}>
            Ticket {lastScan.ticketCode}
            {lastScan.checkedInAt && event ? `, at ${doorTime(lastScan.checkedInAt, event.timezone)}` : ''}.
          </Notice>
        )}
      </Card>

      <Card flush title="Guests" description="Search by name or ticket code.">
        <form
          className="toolbar"
          role="search"
          onSubmit={e => {
            e.preventDefault();
            setQ(draft.trim());
          }}>
          <SearchInput label="Search guests by name or ticket code" placeholder="Name or ticket code" value={draft} onChange={e => setDraft(e.target.value)} autoComplete="off" />
          <Button type="submit" variant="secondary" pending={list.isFetching && !list.isPending} pendingLabel="Searching…">
            Search
          </Button>
          {q && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft('');
                setQ('');
              }}>
              Clear
            </Button>
          )}
        </form>
        <DataTable
          caption="Guests"
          columns={columns}
          rows={data?.guests}
          rowKey={g => g.ticketCode}
          loading={list.isPending}
          error={list.error}
          busyKey={busyCode}
          empty={
            <EmptyState icon={q ? 'search' : 'users'} title={q ? `No guest matches "${q}"` : 'No confirmed guests yet'}>
              {q ? 'Check the spelling, or try the ticket code.' : 'Confirmed guests appear here for check-in.'}
            </EmptyState>
          }
        />
        {data && data.guests.length >= 200 && <p className="muted">Showing the first 200 guests. Search to narrow the list.</p>}
      </Card>

      {data?.canManage && event && event.format !== 'in_person' && <OnlineAttendance eventId={event.id} />}
    </div>
  );
}

/** The `email` column of a CSV (header match), else every cell that looks like an address. At most 1000. */
export function emailsFromCsv(text: string): string[] {
  const lines = text.split(/\r?\n/).slice(0, 5000);
  const cells = (line: string) => line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
  const header = cells(lines[0] ?? '').map(c => c.toLowerCase());
  const col = header.findIndex(c => c === 'email' || c === 'user email' || c === 'email address');
  const out = new Set<string>();
  lines.forEach((line, i) => {
    const row = cells(line);
    const candidates = col >= 0 ? (i === 0 ? [] : [row[col] ?? '']) : row;
    for (const c of candidates) if (/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(c)) out.add(c.toLowerCase());
  });
  return [...out].slice(0, 1000);
}

/** Hosts only: who attended an online or hybrid event, by hand or from an attendee export. */
export function OnlineAttendance({eventId}: {eventId: string}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const attendees = useInfiniteQuery(attendeesQuery(eventId));
  const rows = attendees.data?.pages.flatMap(p => p.attendees);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fileError, setFileError] = useState('');
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const refresh = () => queryClient.invalidateQueries({queryKey: ['checkin', 'attendees', eventId]});
  const base = `/checkin/events/${encodeURIComponent(eventId)}`;

  const mark = useMutation({
    mutationFn: (ids: string[]) => call<{updated: number}>(`${base}/attendance`, {rsvpIds: ids, attended: true}),
    onSuccess: res => {
      toast.success(`${res.updated} marked attended.`);
      setSelected(new Set());
      void refresh();
    },
    onError: error => toast.danger(failureMessage(error)),
  });

  const upload = useMutation({
    mutationFn: (emails: string[]) => call<{matched: number; unmatched: string[]}>(`${base}/attendance/import`, {emails}),
    onSuccess: res => {
      toast.success(`${res.matched} marked attended.`);
      setUnmatched(res.unmatched);
      void refresh();
    },
    onError: error => setFileError(failureMessage(error)),
  });

  async function onFile(file: File | undefined) {
    setFileError('');
    setUnmatched([]);
    if (!file) return;
    if (file.size > 512 * 1024) return setFileError('That file is too large (limit 500 KB). Export fewer columns or split it.');
    const emails = emailsFromCsv(await file.text());
    if (emails.length === 0) return setFileError('No email addresses found. The file needs an "email" column.');
    upload.mutate(emails);
  }

  return (
    <Card title="Online attendance" description="Mark who joined online so follow-ups reach attendees and no-shows correctly.">
      <Field label="Attendee CSV" id="attendance-file" hint="Any CSV with an email column, such as a Zoom attendee report. Guests are matched by email." error={fileError}>
        <input id="attendance-file" type="file" accept=".csv,text/csv" disabled={upload.isPending} onChange={e => void onFile(e.target.files?.[0])} />
      </Field>
      {upload.isPending && <p className="muted">Matching attendees…</p>}
      {unmatched.length > 0 && (
        <Notice tone="warning" title={`${unmatched.length} email${unmatched.length === 1 ? '' : 's'} didn't match a guest`}>
          {unmatched.join(', ')}
        </Notice>
      )}

      <h3>Mark by hand</h3>
      {attendees.error && !rows?.length ? (
        <ErrorNote error={attendees.error} />
      ) : attendees.isPending ? (
        <p className="muted">Loading guests…</p>
      ) : rows && rows.length === 0 ? (
        <EmptyState icon="users" title="No confirmed guests">
          Confirmed guests can be marked as attended here.
        </EmptyState>
      ) : (
        <>
          <div>
            {rows?.map(a => (
              <div key={a.id}>
                <Checkbox
                  label={a.name}
                  description={a.attended ? `${a.email} (attended)` : a.email}
                  checked={selected.has(a.id)}
                  onChange={on =>
                    setSelected(prev => {
                      const next = new Set(prev);
                      if (on) next.add(a.id);
                      else next.delete(a.id);
                      return next;
                    })
                  }
                />
              </div>
            ))}
          </div>
          <LoadMore query={attendees} />
          <Button size="lg" disabled={selected.size === 0} pending={mark.isPending} pendingLabel="Saving…" onClick={() => mark.mutate([...selected])}>
            {selected.size > 0 ? `Mark ${selected.size} attended` : 'Mark selected attended'}
          </Button>
        </>
      )}
    </Card>
  );
}
