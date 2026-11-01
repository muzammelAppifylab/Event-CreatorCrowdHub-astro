import {addDays, addMonths, format, isSameDay, isSameMonth, startOfDay} from 'date-fns';
import {type KeyboardEvent, useEffect, useRef, useState} from 'react';

import {buildMonthGrid} from './calendar-grid';
import {Icon} from './icon';

export {buildMonthGrid} from './calendar-grid';

type CalendarProps = {
  selected?: Date | null;
  onSelect: (day: Date) => void;
  /** Days for which this returns true cannot be picked. */
  isDisabled?: (day: Date) => boolean;
  weekStartsOn?: 0 | 1;
  label?: string;
};

/** A month grid date picker. Arrow keys move by day/week, PageUp/PageDown by month, Home/End to week ends. */
export function Calendar({selected, onSelect, isDisabled, weekStartsOn = 0, label = 'Calendar'}: CalendarProps) {
  const today = startOfDay(new Date());
  const [focus, setFocus] = useState<Date>(startOfDay(selected ?? today));
  const [month, setMonth] = useState<Date>(focus);
  const grid = useRef<HTMLTableElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  }, [focus]);

  const go = (day: Date) => {
    moved.current = true;
    setFocus(day);
    setMonth(day);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const offset = (focus.getDay() - weekStartsOn + 7) % 7;
    const keys: Record<string, Date> = {
      ArrowLeft: addDays(focus, -1),
      ArrowRight: addDays(focus, 1),
      ArrowUp: addDays(focus, -7),
      ArrowDown: addDays(focus, 7),
      PageUp: addMonths(focus, -1),
      PageDown: addMonths(focus, 1),
      Home: addDays(focus, -offset),
      End: addDays(focus, 6 - offset),
    };
    const next = keys[event.key];
    if (!next) return;
    event.preventDefault();
    go(next);
  };

  const weeks = buildMonthGrid(month, weekStartsOn);
  const head = weeks[0].map((d) => ({short: format(d, 'EEEEEE'), full: format(d, 'EEEE')}));
  // The one tab stop: the focused day when it is on screen, else the 1st of the shown month.
  const isStop = (d: Date) => (isSameMonth(focus, month) ? isSameDay(d, focus) : isSameDay(d, startOfDay(month)) && d.getDate() === 1);

  return (
    <div className="calendar" role="group" aria-label={label}>
      <div className="calendar-head">
        <button type="button" className="calendar-nav" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
          <Icon name="arrow-left" size={16} />
        </button>
        <div className="calendar-title" aria-live="polite">{format(month, 'MMMM yyyy')}</div>
        <button type="button" className="calendar-nav" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
          <Icon name="arrow-right" size={16} />
        </button>
      </div>
      <table className="calendar-grid" role="grid" aria-label={format(month, 'MMMM yyyy')} ref={grid} onKeyDown={onKeyDown}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h.full} scope="col" abbr={h.full}>{h.short}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0].toISOString()}>
              {week.map((day) => {
                const outside = !isSameMonth(day, month);
                const isSel = !!selected && isSameDay(day, selected);
                const cls = ['calendar-day', outside && 'is-outside', isSameDay(day, today) && 'is-today', isSel && 'is-selected'].filter(Boolean).join(' ');
                return (
                  <td key={day.toISOString()} role="gridcell" aria-selected={isSel}>
                    <button
                      type="button"
                      className={cls}
                      tabIndex={isStop(day) ? 0 : -1}
                      disabled={isDisabled?.(day) ?? false}
                      aria-label={format(day, 'EEEE, MMMM d, yyyy')}
                      aria-current={isSameDay(day, today) ? 'date' : undefined}
                      onClick={() => {
                        setFocus(day);
                        onSelect(day);
                      }}>
                      {format(day, 'd')}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
