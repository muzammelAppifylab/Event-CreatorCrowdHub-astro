import {addDays, endOfMonth, endOfWeek, startOfMonth, startOfWeek} from 'date-fns';

/** The weeks (arrays of 7 days) that cover `month`, padded with the neighbouring months' days. */
export function buildMonthGrid(month: Date, weekStartsOn: 0 | 1 = 0): Date[][] {
  const first = startOfWeek(startOfMonth(month), {weekStartsOn});
  const last = endOfWeek(endOfMonth(month), {weekStartsOn});
  const weeks: Date[][] = [];
  let day = first;
  while (day <= last) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}
