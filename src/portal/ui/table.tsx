import {type ReactNode, useEffect, useRef} from 'react';
import {createPortal} from 'react-dom';

import {Button} from './button';
import {ErrorNote, Skeleton} from './display';
import {Icon, type IconName} from './icon';

export type Column<Row> = {
  /** Unique per table. */
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  align?: 'start' | 'end';
  /** `shrink`: as narrow as its content (dates, statuses, actions). */
  width?: 'auto' | 'shrink';
  /** Hide this column on narrow screens (a secondary date, an id). */
  hideOnMobile?: boolean;
  /** The row's actions column: right-aligned, no header text, never stacked with a label. */
  actions?: boolean;
};

/**
 * THE table of the portal. It draws all three states itself, so no screen
 * forgets one: `loading` (skeleton rows), `error` (the message, in place) and
 * an `empty` state (pass an `<EmptyState>` with its call to action).
 *
 * On a phone each row becomes a card: every cell shows its column header as
 * its label (`data-label`), so nothing scrolls sideways.
 *
 * `busyKey`: the row an action is running on (`aria-busy`, dimmed): only that
 * row's buttons show pending (AGENTS.md "Per row").
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  loading,
  error,
  empty,
  busyKey,
}: {
  columns: Column<Row>[];
  rows: Row[] | undefined;
  rowKey: (row: Row) => string | number;
  /** What the table lists, for screen readers ("Users"). */
  caption: string;
  loading?: boolean;
  error?: Error | null;
  empty?: ReactNode;
  busyKey?: string | number | null;
}) {
  if (error && !rows?.length) return <ErrorNote error={error} />;
  if (!loading && rows && rows.length === 0) return <>{empty}</>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map(column => (
              <th
                key={column.key}
                scope="col"
                className={cellClass(column)}
                aria-label={column.actions ? 'Actions' : undefined}>
                {column.actions ? null : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && !rows?.length
            ? Array.from({length: 4}, (_, i) => (
                <tr key={`skeleton-${i}`} aria-hidden="true">
                  {columns.map(column => (
                    <td key={column.key} className={cellClass(column)}>
                      {column.actions ? null : <Skeleton width={i % 2 ? 'half' : 'full'} />}
                    </td>
                  ))}
                </tr>
              ))
            : rows?.map(row => {
                const key = rowKey(row);
                return (
                  <tr key={key} aria-busy={busyKey === key || undefined}>
                    {columns.map(column => (
                      <td
                        key={column.key}
                        className={cellClass(column)}
                        data-label={column.actions || typeof column.header !== 'string' ? undefined : column.header}>
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );
}

const cellClass = <Row,>(column: Column<Row>) =>
  [
    column.align === 'end' || column.actions ? 'cell-end' : '',
    column.width === 'shrink' || column.actions ? 'cell-shrink' : '',
    column.hideOnMobile ? 'cell-hide-mobile' : '',
    column.actions ? 'cell-actions' : '',
  ]
    .filter(Boolean)
    .join(' ') || undefined;

/** What `LoadMore` reads from a `useInfiniteQuery` result (pass the whole result). */
export type PagedQuery = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending?: boolean;
  isFetchNextPageError?: boolean;
  error?: Error | null;
  data?: {pages: unknown[]};
  fetchNextPage: () => unknown;
  refetch?: () => unknown;
};

/** Pages loaded by scrolling alone; after that, only the button (lists stay small: performance.md). */
const AUTO_PAGES = 6;

/**
 * THE paging footer of a keyset-paged list (`useInfiniteQuery`). Put it INSIDE the list's
 * `Card`, right after the `DataTable`. It says what is loaded ("Showing 50 events · more to
 * load"), has a secondary "Load more" button (pending "Loading…", disabled while it runs),
 * says "That's everything" on the last page, and shows a failed page in words with "Try again".
 *
 * `count`: rows loaded so far (never a `count()` query: there is no total). `noun`:
 * `['event', 'events']`. `auto` (default on): the next page loads when the footer is scrolled
 * into view, for the first few pages; the button stays for keyboards and screen readers.
 * Never page numbers: the lists are keyset-paged.
 */
export function LoadMore({
  query,
  count,
  noun = ['item', 'items'],
  auto = true,
}: {
  query: PagedQuery;
  count: number | undefined;
  noun?: [singular: string, plural: string];
  auto?: boolean;
}) {
  const footer = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const hadFocus = useRef(false);
  const {hasNextPage, isFetchingNextPage, fetchNextPage} = query;
  const failed = Boolean(query.error) && !isFetchingNextPage && Boolean(count);
  const pages = query.data?.pages.length ?? 0;
  const autoOn = auto && hasNextPage && !failed && !isFetchingNextPage && pages < AUTO_PAGES;

  // Scrolling the footer into view loads the next page. The observer's first report (the
  // footer's state on mount or after a page lands) is skipped, so a short list never loads
  // page after page on its own: only a scroll that brings the footer into view does.
  useEffect(() => {
    const node = footer.current;
    if (!autoOn || !node || typeof IntersectionObserver === 'undefined') return;
    let first = true;
    const observer = new IntersectionObserver(
      entries => {
        if (first) {
          first = false;
          return;
        }
        if (entries.some(entry => entry.isIntersecting)) void fetchNextPage();
      },
      {rootMargin: '0px 0px 160px 0px'}
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoOn, fetchNextPage]);

  // Keep focus where the person was: the button is disabled while it loads (the browser drops
  // focus), and gone after the last page (focus moves to the status line). Never to the top.
  useEffect(() => {
    if (isFetchingNextPage || !hadFocus.current) return;
    hadFocus.current = false;
    const target = hasNextPage || failed ? footer.current?.querySelector('button') : status.current;
    target?.focus({preventScroll: true});
  }, [isFetchingNextPage, hasNextPage, failed]);

  if (query.isPending || (!count && !hasNextPage)) return null;
  const shown = count ?? 0;
  const label = `${shown} ${shown === 1 ? noun[0] : noun[1]}`;
  const load = () => {
    hadFocus.current = Boolean(footer.current?.contains(document.activeElement));
    void (hasNextPage || query.isFetchNextPageError || !query.refetch ? fetchNextPage() : query.refetch());
  };

  return (
    <div className="load-more" ref={footer}>
      <p className="load-more-status" ref={status} tabIndex={-1} aria-live="polite">
        {hasNextPage ? (
          <span>
            Showing <strong>{label}</strong>
            <span className="muted"> · more to load</span>
          </span>
        ) : (
          <>
            <Icon name="check-circle" size={16} />
            <span>
              That's everything <span className="muted">· {label}</span>
            </span>
          </>
        )}
      </p>
      {failed && (
        <p className="load-more-error" role="alert">
          Couldn't load more: {query.error!.message}
        </p>
      )}
      {(hasNextPage || failed) && (
        <Button variant="secondary" size="sm" icon={failed ? 'refresh' : undefined} pending={isFetchingNextPage} pendingLabel="Loading…" onClick={load}>
          {failed ? 'Try again' : 'Load more'}
        </Button>
      )}
    </div>
  );
}

/**
 * The bar that floats at the bottom of the screen while rows are selected (YNAB, ClickUp, folk,
 * Aboard): the count, the few actions that matter as `BulkAction`s, a Clear. It sits over the
 * page, so nothing above or below it moves when it appears. Esc clears the selection.
 */
export function BulkBar({count, noun = 'selected', onClear, children}: {count: number; noun?: string; onClear: () => void; children: ReactNode}) {
  useEffect(() => {
    if (count === 0) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClear();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [count, onClear]);
  if (count === 0 || typeof document === 'undefined') return null;
  return createPortal(
    <div className="bulk-bar" role="region" aria-label="Bulk actions">
      <p className="bulk-bar-count" aria-live="polite">
        <strong>{count}</strong> {noun}
      </p>
      <div className="bulk-bar-actions">{children}</div>
      <button type="button" className="bulk-action bulk-clear" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}>
        <Icon name="x" size={16} />
      </button>
    </div>,
    document.body
  );
}

export function BulkAction({icon, label, onClick, disabled, danger, pending}: {icon: IconName; label: string; onClick: () => void; disabled?: boolean; danger?: boolean; pending?: boolean}) {
  return (
    <button type="button" className="bulk-action" data-danger={danger ? '' : undefined} aria-label={label} title={label} disabled={disabled || pending} aria-busy={pending || undefined} onClick={onClick}>
      {pending ? <span className="spinner" aria-hidden="true" /> : <Icon name={icon} size={16} />}
      <span className="bulk-action-label">{label}</span>
    </button>
  );
}
