import {useInfiniteQuery} from '@tanstack/react-query';
import {Link, useNavigate} from '@tanstack/react-router';
import {type FormEvent, useCallback, useMemo, useState} from 'react';

import {
  CONTACT_PAGE_SIZES,
  type ContactFilter,
  type ContactRow,
  contactsExportUrl,
  contactsQuery,
  downloadExport,
  EMPTY_CONTACT_FILTER,
} from '../guests-queries';
import {eventsListQuery} from '../events-queries';
import {ago, useCanManageEvents, when} from '../shared';
import {
  Avatar,
  Badge,
  BulkAction,
  BulkBar,
  Button,
  Card,
  type Column,
  DataTable,
  EmptyState,
  IconButton,
  Menu,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  useToast,
} from '../ui';

type View = 'all' | 'opted_in' | 'repeat' | 'attended';

const VIEW_OPTIONS: {value: View; label: string}[] = [
  {value: 'all', label: 'All contacts'},
  {value: 'opted_in', label: 'Opted in'},
  {value: 'repeat', label: 'Repeat guests'},
  {value: 'attended', label: 'Attended'},
];

const VIEW_FILTER: Record<View, Pick<ContactFilter, 'consent' | 'repeat' | 'attended'>> = {
  all: {consent: '', repeat: '', attended: ''},
  opted_in: {consent: 'yes', repeat: '', attended: ''},
  repeat: {consent: '', repeat: 'yes', attended: ''},
  attended: {consent: '', repeat: '', attended: 'yes'},
};

const viewOf = (f: ContactFilter): View => (f.consent ? 'opted_in' : f.repeat ? 'repeat' : f.attended ? 'attended' : 'all');

/** A CSV cell: quoted, and neutralised when a spreadsheet would read it as a formula. */
const cell = (value: string | number) => {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};

function downloadRows(rows: ContactRow[]) {
  const lines = [
    ['Name', 'Email', 'Events', 'Attended', 'Last event', 'First seen', 'Marketing consent'],
    ...rows.map(c => [c.name, c.email, c.eventCount, c.attendedCount, c.lastEvent.title, c.firstSeenAt, c.marketingConsent ? 'Yes' : 'No']),
  ].map(line => line.map(cell).join(','));
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'contacts-selected.csv';
  link.click();
  URL.revokeObjectURL(url);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * `/dashboard/contacts`: everyone who RSVP'd to any event, once per email, newest data wins.
 * Opted in = the guest ticked marketing consent and confirmed it from the email link.
 *
 * Paging walks the server's keyset pages forward and back from what is already loaded (never a
 * count): "Showing 1–50", Next fetches the following page.
 */
export function Contacts() {
  const toast = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ContactFilter>(EMPTY_CONTACT_FILTER);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState<number>(CONTACT_PAGE_SIZES[1]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<Map<string, ContactRow>>(new Map());
  const [exporting, setExporting] = useState(false);
  // Read-only viewers (no `manageEvents`): the list and each profile, no selection, bulk actions or export.
  const canManage = useCanManageEvents();

  const contacts = useInfiniteQuery(contactsQuery(filter, limit));
  const upcoming = useInfiniteQuery(eventsListQuery('upcoming'));
  const past = useInfiniteQuery(eventsListQuery('past'));
  const eventOptions = useMemo(
    () => [
      {value: '', label: 'Any event'},
      ...[...(upcoming.data?.pages ?? []), ...(past.data?.pages ?? [])]
        .flatMap(page => page.events)
        .map(e => ({value: e.id, label: e.title})),
    ],
    [upcoming.data, past.data]
  );

  const pages = contacts.data?.pages ?? [];
  const page = pages[Math.min(pageIndex, Math.max(pages.length - 1, 0))];
  const rows = page?.items;
  const start = pageIndex * limit + 1;
  const hasNext = pageIndex + 1 < pages.length || Boolean(page?.nextBefore);
  const filtered = Boolean(filter.q || filter.consent || filter.repeat || filter.attended || filter.event);

  const change = (next: Partial<ContactFilter>) => {
    setFilter(current => ({...current, ...next}));
    setPageIndex(0);
    setSelected(new Map());
  };
  const runSearch = (event: FormEvent) => {
    event.preventDefault();
    change({q: search.trim()});
  };
  const clear = () => {
    setSearch('');
    change(EMPTY_CONTACT_FILTER);
  };
  const next = async () => {
    if (pageIndex + 1 >= pages.length) await contacts.fetchNextPage();
    setPageIndex(index => index + 1);
    setSelected(new Map());
  };
  const prev = () => {
    setPageIndex(index => Math.max(0, index - 1));
    setSelected(new Map());
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const {truncated} = await downloadExport(contactsExportUrl(filter), 'contacts.csv');
      toast.success(truncated ? 'Exported the first 20,000 contacts.' : 'Contacts exported.');
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : 'The export failed.');
    } finally {
      setExporting(false);
    }
  };

  const copy = (text: string, done: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(done))
      .catch(() => toast.danger('Copying was blocked by the browser.'));

  const toggle = (c: ContactRow, on: boolean) =>
    setSelected(current => {
      const nextMap = new Map(current);
      if (on) nextMap.set(c.email, c);
      else nextMap.delete(c.email);
      return nextMap;
    });
  const allOnPage = Boolean(rows?.length) && rows!.every(c => selected.has(c.email));
  const clearSelection = useCallback(() => setSelected(new Map()), []);
  const chosen = [...selected.values()];
  const optedIn = chosen.filter(c => c.marketingConsent);

  // Keyed by the contact's newest RSVP id: an email address never goes in a URL.
  const open = (key: string) => void navigate({to: '/contacts/$key', params: {key}});

  const allColumns: Column<ContactRow>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select every contact shown"
          checked={allOnPage}
          onChange={event => setSelected(event.target.checked ? new Map(rows?.map(c => [c.email, c])) : new Map())}
        />
      ),
      width: 'shrink',
      cell: c => <input type="checkbox" aria-label={`Select ${c.name}`} checked={selected.has(c.email)} onChange={event => toggle(c, event.target.checked)} />,
    },
    {
      key: 'contact',
      header: 'Contact',
      cell: c => (
        <span className="person">
          <Avatar name={c.name} size="sm" />
          <span className="person-text">
            <Link className="person-name" to="/contacts/$key" params={{key: c.key}}>
              {c.name}
            </Link>
            <span className="person-detail">{c.email}</span>
          </span>
        </span>
      ),
    },
    {key: 'events', header: 'Events', width: 'shrink', cell: c => c.eventCount},
    {
      key: 'attended',
      header: 'Attended',
      width: 'shrink',
      hideOnMobile: true,
      cell: c => (
        <span>
          <strong>{c.attendedCount}</strong>
          <span className="muted"> / {c.eventCount}</span>
        </span>
      ),
    },
    {
      key: 'last',
      header: 'Last event',
      hideOnMobile: true,
      cell: c => (
        <div>
          <span className="cell-title">
            <Link to={`/events/${c.lastEvent.id}` as never}>{c.lastEvent.title}</Link>
          </span>
          <span className="cell-sub">{when(c.lastEvent.startAt)}</span>
        </div>
      ),
    },
    {
      key: 'first',
      header: 'First seen',
      width: 'shrink',
      hideOnMobile: true,
      cell: c => <time dateTime={c.firstSeenAt} title={when(c.firstSeenAt)}>{ago(c.firstSeenAt)}</time>,
    },
    {
      key: 'consent',
      header: 'Marketing',
      width: 'shrink',
      cell: c => (c.marketingConsent ? <Badge tone="success" icon="check">Opted in</Badge> : <span className="muted">No consent</span>),
    },
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: c => (
        <Menu
          label={`Actions for ${c.name}`}
          items={[
            {label: 'View profile', icon: 'user', onSelect: () => open(c.key)},
            {label: 'Open last event', icon: 'calendar', onSelect: () => void navigate({to: `/events/${c.lastEvent.id}` as never})},
            {label: 'Send an email', icon: 'mail', onSelect: () => window.location.assign(`mailto:${c.email}`)},
            {label: 'Copy email', icon: 'copy', onSelect: () => copy(c.email, 'Email copied')},
          ]}
        />
      ),
    },
  ];
  const columns = canManage ? allColumns : allColumns.filter(c => c.key !== 'select');

  return (
    <div className="app-page screen-contacts" data-selecting={selected.size > 0 ? '' : undefined}>
      <PageHeader
        title="Contacts"
        description="Every guest across your events, once per email."
        actions={
          canManage && (
            <Button variant="secondary" icon="file" pending={exporting} pendingLabel="Exporting…" onClick={() => void exportCsv()}>
              {filtered ? 'Export filtered CSV' : 'Export CSV'}
            </Button>
          )
        }
      />

      <div className="toolbar contacts-toolbar">
        <SegmentedControl label="Show contacts" value={viewOf(filter)} onChange={view => change(VIEW_FILTER[view])} options={VIEW_OPTIONS} />
        <div className="toolbar-group contacts-filters">
          <form role="search" onSubmit={runSearch} noValidate>
            <SearchInput
              label="Search contacts"
              placeholder="Name or email, then Enter"
              value={search}
              maxLength={120}
              autoComplete="off"
              onChange={event => {
                setSearch(event.target.value);
                if (!event.target.value && filter.q) change({q: ''});
              }}
            />
          </form>
          <Select aria-label="Filter by event" value={filter.event} options={eventOptions} onChange={event => change({event: event.target.value})} />
          <Button variant="ghost" icon="x" onClick={clear} disabled={!filtered}>
            Clear filters
          </Button>
        </div>
      </div>

      {canManage && (
      <BulkBar count={chosen.length} noun={chosen.length === 1 ? 'contact selected' : 'contacts selected'} onClear={clearSelection}>
        <BulkAction icon="copy" label="Copy emails" onClick={() => copy(chosen.map(c => c.email).join(', '), `${plural(chosen.length, 'email')} copied`)} />
        <BulkAction
          icon="check"
          label={`Copy opted-in (${optedIn.length})`}
          disabled={optedIn.length === 0}
          onClick={() => copy(optedIn.map(c => c.email).join(', '), `${plural(optedIn.length, 'opted-in email')} copied`)}
        />
        <BulkAction icon="file" label="Export selected" onClick={() => downloadRows(chosen)} />
      </BulkBar>
      )}

      <Card
        flush
        footer={
          Boolean(rows?.length) && (
            <div className="table-pager">
              <span className="muted" aria-live="polite">
                Showing {start}–{start + rows!.length - 1}
                {hasNext ? '+' : ''}
              </span>
              <div className="pager-controls">
                <label className="pager-size">
                  <span className="muted">Rows per page</span>
                  <Select
                    aria-label="Contacts per page"
                    value={String(limit)}
                    options={CONTACT_PAGE_SIZES.map(n => ({value: String(n), label: String(n)}))}
                    onChange={event => {
                      setLimit(Number(event.target.value));
                      setPageIndex(0);
                      setSelected(new Map());
                    }}
                  />
                </label>
                <span className="pager-page">Page {pageIndex + 1}</span>
                <IconButton variant="secondary" icon="arrow-left" label="Previous page" disabled={pageIndex === 0 || contacts.isFetchingNextPage} onClick={prev} />
                <IconButton variant="secondary" icon="arrow-right" label="Next page" pending={contacts.isFetchingNextPage} disabled={!hasNext} onClick={() => void next()} />
              </div>
            </div>
          )
        }>
        <DataTable
          caption="Contacts"
          columns={columns}
          rows={rows}
          rowKey={c => c.email}
          loading={contacts.isPending || (contacts.isFetchingNextPage && !rows)}
          error={contacts.error}
          empty={
            <EmptyState
              icon="users"
              title={filtered ? 'No contacts match' : 'No contacts yet'}
              action={
                filtered ? (
                  <Button variant="secondary" onClick={clear}>
                    Clear filters
                  </Button>
                ) : undefined
              }>
              {filtered ? 'Try another search or filter.' : 'Guests appear here once they RSVP to one of your events.'}
            </EmptyState>
          }
        />
      </Card>
    </div>
  );
}
