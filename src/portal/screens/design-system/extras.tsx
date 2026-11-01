import {format} from 'date-fns';
import {useState} from 'react';

import {Accordion, AspectRatio, Calendar, Card, Collapsible, Command, Pagination, Popover, Separator} from '../../ui';

/** Gallery: the extra kit pieces (popover, disclosure, separator, aspect ratio, pagination, command, calendar). */

const COMMANDS = [
  {value: 'events', label: 'Events', group: 'Go to', hint: 'G E'},
  {value: 'guests', label: 'Guests', group: 'Go to', hint: 'G G'},
  {value: 'new', label: 'New event', group: 'Actions'},
  {value: 'export', label: 'Export guests', group: 'Actions', disabled: true},
];

export function Extras() {
  const [date, setDate] = useState<Date | null>(null);
  const [page, setPage] = useState(3);
  const [picked, setPicked] = useState('');
  return (
    <div className="kit-section">
      <Card title="Popover and date picker" description="Click outside or Esc closes; focus returns to the button.">
        <div className="kit-row">
          <Popover trigger="Open popover" align="start">
            <p>Popover content.</p>
          </Popover>
          <Popover trigger={date ? format(date, 'PPP') : 'Pick a date'} align="start">
            {(close) => (
              <Calendar
                selected={date}
                onSelect={(d) => {
                  setDate(d);
                  close();
                }}
              />
            )}
          </Popover>
        </div>
      </Card>
      <Card title="Accordion and collapsible">
        <Accordion
          items={[
            {value: 'a', title: 'What is Marquee?', content: 'An events platform.'},
            {value: 'b', title: 'Can I export guests?', content: 'Yes, as CSV.'},
          ]}
        />
        <Separator />
        <Collapsible trigger="More details">Hidden until opened.</Collapsible>
      </Card>
      <Card title="Aspect ratio and pagination">
        <div className="ds-aspect-demo">
          <AspectRatio ratio="16/9">
            <div className="ds-chip ds-chip-tall" />
          </AspectRatio>
        </div>
        <Pagination page={page} pageCount={9} onPageChange={setPage} />
      </Card>
      <Card title="Command" description={picked ? `Chose: ${picked}` : 'Type, arrow keys, Enter.'}>
        <Command items={COMMANDS} onSelect={(i) => setPicked(i.label)} />
      </Card>
      <Card title="Calendar">
        <Calendar selected={date} onSelect={setDate} isDisabled={(d) => d.getDay() === 0} />
      </Card>
    </div>
  );
}
