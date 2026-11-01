import {useInfiniteQuery, useMutation, useQueryClient} from '@tanstack/react-query';

import {formatMoney} from '../../lib/format';
import {markRefunded, type RefundRow, refundsQuery} from '../refunds-queries';
import {ago} from '../shared';
import {Button, Card, type Column, DataTable, EmptyState, ErrorNote, LoadMore, Notice, PageHeader, useConfirm, useToast} from '../ui';

/**
 * `/dashboard/refunds` (holders of `site:event:manage`): paid orders that need a refund (event
 * cancelled, a payment that could not be honoured, a seat lost). Refunds are issued in the
 * platform dashboard (docs/agent/payments.md); "Mark refunded" is the fallback when the
 * platform's `payment.refunded` event never closed the order.
 */
export function Refunds() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const list = useInfiniteQuery(refundsQuery);
  const rows = list.data?.pages.flatMap(p => p.items);

  const mark = useMutation({
    mutationFn: markRefunded,
    onSettled: () => queryClient.invalidateQueries({queryKey: ['refunds']}),
  });
  const busyKey = mark.isPending ? mark.variables : null;

  const ask = (row: RefundRow) =>
    void confirm({
      title: 'Mark this order as refunded?',
      body: `Only do this after you refunded ${formatMoney(row.amountCents, row.currency)} to ${row.guestName} in the platform dashboard. The order closes and the seat is freed.`,
      confirmLabel: 'Mark refunded',
      pendingLabel: 'Saving…',
      action: () => mark.mutateAsync(row.id),
    }).then(ok => ok && toast.success('Order marked as refunded.'));

  const columns: Column<RefundRow>[] = [
    {key: 'guest', header: 'Guest', cell: r => <span className="cell-title">{r.guestName}</span>},
    {key: 'event', header: 'Event', hideOnMobile: true, cell: r => r.eventTitle},
    {key: 'amount', header: 'Amount', width: 'shrink', align: 'end', cell: r => formatMoney(r.amountCents, r.currency)},
    {key: 'since', header: 'Since', width: 'shrink', cell: r => ago(r.since)},
    {
      key: 'actions',
      header: 'Actions',
      actions: true,
      cell: r => (
        <Button variant="secondary" size="sm" pending={busyKey === r.id} pendingLabel="Saving…" onClick={() => ask(r)}>
          Mark refunded
        </Button>
      ),
    },
  ];

  return (
    <div className="app-page refunds-screen">
      <PageHeader title="Refunds to finish" description="Paid orders that need their money back: a cancelled event, a payment that could not be honoured, a seat that was lost." />
      <Notice tone="info" title="Refunds are issued in the platform dashboard">
        Open the site's Payments tab in the platform dashboard, refund the payment there, and the order closes here by itself. If it is still listed after
        you refunded it, press Mark refunded.
      </Notice>
      {mark.error && <ErrorNote error={mark.error} />}
      <Card flush>
        <DataTable
          caption="Refunds to finish"
          columns={columns}
          rows={rows}
          rowKey={r => r.id}
          loading={list.isPending}
          error={list.error}
          busyKey={busyKey}
          empty={
            <EmptyState icon="check-circle" title="Nothing to refund">
              Every paid order is in good standing.
            </EmptyState>
          }
        />
        <LoadMore query={list} />
      </Card>
    </div>
  );
}
