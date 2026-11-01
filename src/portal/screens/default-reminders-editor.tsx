import {useState} from 'react';

import {
  DEFAULT_RULE_COPY,
  MAX_DEFAULT_REMINDER_RULES,
  RULE_OFFSET_LIMITS,
  type ReminderKind,
  type ReminderRuleValues,
} from '../../lib/event-schemas';
import {Button, Checkbox, Field} from '../ui';

export const remindersCopy = {
  title: 'Default emails',
  hint: 'Every new event starts with these. You can still change them per event under Messages.',
  before: 'Reminders before the start',
  beforeHint: 'Pick as many as you like. Turned-off times are kept, just not sent.',
  kinds: {
    confirmation: {label: 'Confirmation', hint: 'Sent as soon as someone RSVPs'},
    live_now: {label: 'We’re live', hint: 'Online and hybrid events, at the start time'},
    thank_you: {label: 'Thank you', hint: 'Sent after the event ends'},
  } satisfies Record<Exclude<ReminderKind, 'reminder'>, {label: string; hint: string}>,
};

const HOUR = 60;
const DAY = 24 * HOUR;

/** Common reminder offsets, in minutes before the start (negative, as stored). */
export const REMINDER_PRESETS = [-7 * DAY, -3 * DAY, -DAY, -3 * HOUR, -HOUR, -15] as const;

export type OffsetUnit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<OffsetUnit, number> = {minutes: 1, hours: HOUR, days: DAY};

/** "1 week", "3 days", "24 hours", "1 hour", "15 min". */
export function offsetLabel(offsetMinutes: number): string {
  const m = Math.abs(offsetMinutes);
  if (m === 7 * DAY) return '1 week';
  if (m >= 2 * DAY && m % DAY === 0) return `${m / DAY} days`;
  if (m >= HOUR && m % HOUR === 0) return m === HOUR ? '1 hour' : `${m / HOUR} hours`;
  return `${m} min`;
}

/** Splits minutes into the largest unit that divides them evenly (for a number + unit input). */
export function splitOffset(minutes: number): {amount: number; unit: OffsetUnit} {
  const m = Math.abs(Math.round(minutes));
  if (m > 0 && m % DAY === 0) return {amount: m / DAY, unit: 'days'};
  if (m > 0 && m % HOUR === 0) return {amount: m / HOUR, unit: 'hours'};
  return {amount: m, unit: 'minutes'};
}

/** Amount + unit back to whole minutes before the start (negative, as stored); NaN when not a positive number. */
export function beforeStartMinutes(amount: number, unit: OffsetUnit): number {
  if (!Number.isFinite(amount) || amount <= 0) return NaN;
  return -Math.round(amount * UNIT_MINUTES[unit]);
}

/** True when a "before the start" reminder offset is inside what the server accepts. */
export function reminderOffsetInRange(offsetMinutes: number): boolean {
  const {min, max} = RULE_OFFSET_LIMITS.reminder;
  return Number.isInteger(offsetMinutes) && offsetMinutes >= min && offsetMinutes <= max && offsetMinutes !== 0;
}

function newReminder(offsetMinutes: number): ReminderRuleValues {
  const base = DEFAULT_RULE_COPY.reminder;
  // The stock subject says "Tomorrow", which is only right for 24h.
  const subject = offsetMinutes === base.offsetMinutes ? base.subject : `Starting in ${offsetLabel(offsetMinutes)}: {{event.title}}`;
  return {kind: 'reminder', offsetMinutes, enabled: true, subject, body: base.body};
}

/**
 * Pure: turn reminder offsets on/off. Off keeps the rule (and any custom copy) disabled.
 * New offsets are skipped once `max` rules exist.
 */
export function setReminderOffsets(rules: ReminderRuleValues[], enabledOffsets: number[], max = MAX_DEFAULT_REMINDER_RULES): ReminderRuleValues[] {
  const wanted = new Set(enabledOffsets);
  const next = rules.map(r => (r.kind === 'reminder' ? {...r, enabled: wanted.has(r.offsetMinutes)} : r));
  for (const offset of wanted) {
    if (next.length >= max) break;
    if (!next.some(r => r.kind === 'reminder' && r.offsetMinutes === offset)) next.push(newReminder(offset));
  }
  return next;
}

/** Pure: turn a non-reminder email on/off, adding it with stock copy the first time. */
export function setKindEnabled(rules: ReminderRuleValues[], kind: Exclude<ReminderKind, 'reminder'>, enabled: boolean, max = MAX_DEFAULT_REMINDER_RULES): ReminderRuleValues[] {
  if (rules.some(r => r.kind === kind)) return rules.map(r => (r.kind === kind ? {...r, enabled} : r));
  if (!enabled || rules.length >= max) return rules;
  const {offsetMinutes, subject, body} = DEFAULT_RULE_COPY[kind];
  return [...rules, {kind, offsetMinutes, enabled: true, subject, body}];
}

/** Which emails, and which reminder offsets, new events start with. */
export function DefaultRemindersEditor({value, onChange, error}: {value: ReminderRuleValues[]; onChange: (rules: ReminderRuleValues[]) => void; error?: string}) {
  const [amount, setAmount] = useState('2');
  const [unit, setUnit] = useState<OffsetUnit>('days');
  const [customError, setCustomError] = useState('');
  const reminders = value.filter(r => r.kind === 'reminder');
  const offsets = [...new Set([...REMINDER_PRESETS, ...reminders.map(r => r.offsetMinutes)])].sort((a, b) => a - b);
  const enabled = reminders.filter(r => r.enabled).map(r => r.offsetMinutes);
  const isOn = (kind: ReminderKind) => value.some(r => r.kind === kind && r.enabled);

  const toggle = (offset: number) => onChange(setReminderOffsets(value, enabled.includes(offset) ? enabled.filter(o => o !== offset) : [...enabled, offset]));
  const addCustom = () => {
    const minutes = beforeStartMinutes(Number(amount), unit);
    if (!reminderOffsetInRange(minutes)) {
      setCustomError('Pick a whole time from 1 minute to 14 days before the start.');
      return;
    }
    if (value.length >= MAX_DEFAULT_REMINDER_RULES && !reminders.some(r => r.offsetMinutes === minutes)) {
      setCustomError(`You can have up to ${MAX_DEFAULT_REMINDER_RULES} default emails.`);
      return;
    }
    setCustomError('');
    onChange(setReminderOffsets(value, [...new Set([...enabled, minutes])]));
  };

  return (
    <fieldset className="form-stack">
      <legend>{remindersCopy.title}</legend>
      <p className="muted">{remindersCopy.hint}</p>

      <div className="form-stack">
        <strong id="default-reminder-offsets">{remindersCopy.before}</strong>
        <div className="toolbar-group" role="group" aria-labelledby="default-reminder-offsets">
          {offsets.map(offset => (
            <Button key={offset} variant={enabled.includes(offset) ? 'primary' : 'secondary'} size="sm" aria-pressed={enabled.includes(offset)} onClick={() => toggle(offset)}>
              {offsetLabel(offset)}
            </Button>
          ))}
        </div>
        <p className="muted">{remindersCopy.beforeHint}</p>
        <div className="form-grid">
          <Field id="default-reminder-amount" label="Custom time" error={customError}>
            <input id="default-reminder-amount" type="number" inputMode="numeric" min={1} value={amount} onChange={ev => setAmount(ev.target.value)} />
          </Field>
          <Field id="default-reminder-unit" label="Unit">
            <select id="default-reminder-unit" value={unit} onChange={ev => setUnit(ev.target.value as OffsetUnit)}>
              <option value="minutes">Minutes before</option>
              <option value="hours">Hours before</option>
              <option value="days">Days before</option>
            </select>
          </Field>
        </div>
        <div>
          <Button variant="secondary" size="sm" onClick={addCustom}>
            Add this reminder
          </Button>
        </div>
      </div>

      {(['confirmation', 'live_now', 'thank_you'] as const).map(kind => (
        <Checkbox key={kind} label={remindersCopy.kinds[kind].label} description={remindersCopy.kinds[kind].hint} checked={isOn(kind)} onChange={on => onChange(setKindEnabled(value, kind, on))} />
      ))}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
