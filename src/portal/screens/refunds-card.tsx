import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';

import {refundsCountQuery} from '../refunds-queries';
import {buttonClass, Card, Icon} from '../ui';

/** "Refunds to finish": shown ONLY when something is waiting (count > 0). `eventId` scopes it to one event. */
export function RefundsCard({eventId}: {eventId?: string}) {
  const count = useQuery(refundsCountQuery(eventId)).data?.count ?? 0;
  if (count <= 0) return null;
  return (
    <Card
      title="Refunds to finish"
      actions={
        <Link className={buttonClass({variant: 'secondary', size: 'sm'})} to={'/refunds' as never}>
          Review
          <Icon name="arrow-right" size={16} />
        </Link>
      }>
      <p>
        {count === 1 ? '1 paid order needs' : `${count} paid orders need`} a refund. Refund {count === 1 ? 'it' : 'them'} in the platform dashboard.
      </p>
    </Card>
  );
}
