import {useInfiniteQuery} from '@tanstack/react-query';
import {type FormEvent, useState} from 'react';

import {type ContactFilter, type ContactRow, contactsExportUrl, contactsQuery, downloadExport} from '../guests-queries';
import {when} from '../shared';
import {
  Badge,
  Button,
  Card,
  type Column,
  DataTable,
  EmptyState,
  LoadMore,
  PageHeader,
  SearchInput,
  SegmentedControl,
  useToast,
} from '../ui';

const CONSENT_OPTIONS = [
  {value: 'yes' as const, label: 'Opted in'},
  {value: '' as const, label: 'Everyone'},
];

/**
 * `/dashboard/contacts`: everyone who RSVP'd to any event, once per email, newest data wins.
 * Opted in = the guest ticked marketing consent and confirmed it from the email link.
 */
export function Contacts() {
  const toast = useToast();
  const [filter, setFilter] = useState<ContactFilter>({q: '', consent: 'yes'});
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const contacts = useInfiniteQuery(contactsQuery(filter));
  const rows = contacts.data?.pages.flatMap(page => page.items);

  const runSearch = (event: FormEvent) => {
    event.preventDefault();
    setFilter(current => ({...current, q: search.trim()}));
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

  const columns: Column<ContactRow>[] = [
    {
      key: 'contact',
      header: 'Contact',
      cell: c => (
        <div>
          <span className="cell-title">{c.name}</span>
          <span className="cell-sub">{c.email}</span>
        </div>
      ),
    },
    {key: 'events', header: 'Events', width: 'shrink', cell: c => c.eventCount},
    {
      key: 'last',
      header: 'Last event',
      hideOnMobile: true,
      cell: c => (
        <div>
          <span className="cell-title">{c.lastEvent.title}</span>
          <span className="cell-sub">{when(c.lastEvent.startAt)}</span>
        </div>
      ),
    },
    {
      key: 'consent',
      header: 'Marketing',
      width: 'shrink',
      cell: c => (c.marketingConsent ? <Badge tone="success" icon="check">Opted in</Badge> : <span className="muted">No consent</span>),
    },
  ];

  return (
    <div className="app-page screen-contacts">
      <PageHeader
        title="Contacts"
        description="Everyone who has RSVP’d to any of your events, once per email."
        actions={
          <Button variant="secondary" icon="file" pending={exporting} pendingLabel="Exporting…" onClick={() => void exportCsv()}>
            Export CSV
          </Button>
        }
      />
      <div className="toolbar">
        <form role="search" onSubmit={runSearch} noValidate>
          <SearchInput
            label="Search contacts"
            placeholder="Name or email, then Enter"
            value={search}
            maxLength={120}
            autoComplete="off"
            onChange={event => {
              setSearch(event.target.value);
              if (!event.target.value && filter.q) setFilter(current => ({...current, q: ''}));
            }}
          />
        </form>
        <SegmentedControl
          label="Marketing consent"
          options={CONSENT_OPTIONS}
          value={filter.consent}
          onChange={consent => setFilter(current => ({...current, consent}))}
        />
      </div>
      <Card flush>
        <DataTable
          caption="Contacts"
          columns={columns}
          rows={rows}
          rowKey={c => c.email}
          loading={contacts.isPending}
          error={contacts.error}
          empty={
            <EmptyState icon="users" title={filter.q || filter.consent ? 'No contacts match' : 'No contacts yet'}>
              {filter.q || filter.consent
                ? 'Try another search, or show everyone instead of only people who opted in.'
                : 'People show here once they RSVP to an event.'}
            </EmptyState>
          }
        />
      </Card>
      <LoadMore query={contacts} />
    </div>
  );
}
