import {format, isValid, parse, startOfDay} from 'date-fns';
import {useEffect, useRef} from 'react';

import {Calendar} from './calendar';
import {Icon} from './icon';
import {Popover} from './popover';

const STORE = "yyyy-MM-dd'T'HH:mm";
const HOURS = Array.from({length: 24}, (_, i) => i);
const MINUTES = Array.from({length: 12}, (_, i) => i * 5);

const pad = (n: number) => String(n).padStart(2, '0');

type DateTimeFieldProps = {
  id?: string;
  name?: string;
  /** `YYYY-MM-DDTHH:mm` (what `<input type="datetime-local">` used), or '' when empty. */
  value: string;
  /** Same shape as an input's change event, so `{...form.field(name)}` spreads straight in. */
  onChange: (event: {target: {value: string}}) => void;
  onBlur?: () => void;
  ref?: (node: HTMLElement | null) => void;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  /** Time used when a day is picked and no time is set yet. */
  defaultTime?: string;
  placeholder?: string;
};

/** A date + time field: the kit's Calendar and an hour / minute picker in one popover. */
export function DateTimeField({id, value, onChange, onBlur, ref, defaultTime = '09:00', placeholder = 'Pick a date and time', ...aria}: DateTimeFieldProps) {
  const parsed = value ? parse(value, STORE, new Date()) : null;
  const current = parsed && isValid(parsed) ? parsed : null;
  const emit = (next: Date) => onChange({target: {value: format(next, STORE)}});

  const pickDay = (day: Date) => {
    const [h, m] = (current ? format(current, 'HH:mm') : defaultTime).split(':').map(Number);
    emit(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m));
  };
  const pickTime = (hours: number, minutes: number) => {
    const day = current ?? startOfDay(new Date());
    emit(new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes));
  };

  return (
    <div className="datetime-field" ref={ref} tabIndex={-1} onBlur={onBlur}>
      <Popover
        align="start"
        triggerClassName="datetime-trigger"
        trigger={
          <>
            <Icon name="calendar" size={16} />
            <span className={current ? undefined : 'muted'}>{current ? format(current, 'EEE, d MMM yyyy · HH:mm') : placeholder}</span>
          </>
        }>
        <div className="datetime-panel">
          <Calendar selected={current} onSelect={pickDay} label="Pick a date" />
          <TimeColumns hours={current?.getHours() ?? null} minutes={current?.getMinutes() ?? null} onPick={pickTime} />
        </div>
      </Popover>
      <input type="hidden" id={id} value={value} readOnly {...aria} />
    </div>
  );
}

function TimeColumns({hours, minutes, onPick}: {hours: number | null; minutes: number | null; onPick: (h: number, m: number) => void}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelectorAll<HTMLElement>('[aria-pressed="true"]').forEach(el => el.scrollIntoView({block: 'nearest'}));
  }, []);
  const minuteList = minutes !== null && !MINUTES.includes(minutes) ? [...MINUTES, minutes].sort((a, b) => a - b) : MINUTES;
  return (
    <div className="time-picker" ref={root} role="group" aria-label="Pick a time">
      <div className="time-col" role="group" aria-label="Hour">
        {HOURS.map(h => (
          <button key={h} type="button" className="time-cell" aria-pressed={h === hours} onClick={() => onPick(h, minutes ?? 0)}>
            {pad(h)}
          </button>
        ))}
      </div>
      <div className="time-col" role="group" aria-label="Minute">
        {minuteList.map(m => (
          <button key={m} type="button" className="time-cell" aria-pressed={m === minutes} onClick={() => onPick(hours ?? 9, m)}>
            {pad(m)}
          </button>
        ))}
      </div>
    </div>
  );
}
