import {describe, expect, it} from 'vitest';

import {Collector, parseReminderRules, type ReminderRuleValues} from '../src/lib/event-schemas';
import {
  beforeStartMinutes,
  offsetLabel,
  REMINDER_PRESETS,
  setKindEnabled,
  setReminderOffsets,
  splitOffset,
} from '../src/portal/screens/default-reminders-editor';

const tomorrow: ReminderRuleValues = {kind: 'reminder', offsetMinutes: -1440, enabled: true, subject: 'Custom', body: 'Mine'};

const valid = (rules: ReminderRuleValues[]) => {
  const c = new Collector();
  const out = parseReminderRules(c, rules, 'rules');
  return c.ok && out?.length === rules.length;
};

describe('default reminder offsets', () => {
  it('labels offsets the way creators say them', () => {
    expect(REMINDER_PRESETS.map(offsetLabel)).toEqual(['1 week', '3 days', '24 hours', '3 hours', '1 hour', '15 min']);
  });

  it('adds new offsets with valid copy and keeps turned-off ones (with their copy) disabled', () => {
    const added = setReminderOffsets([tomorrow], [-1440, -60]);
    expect(added.map(r => [r.offsetMinutes, r.enabled])).toEqual([
      [-1440, true],
      [-60, true],
    ]);
    expect(added[1]!.subject).toBe('Starting in 1 hour: {{event.title}}');
    expect(valid(added)).toBe(true);

    const off = setReminderOffsets(added, [-60]);
    expect(off[0]).toEqual({...tomorrow, enabled: false});
  });

  it('toggles the other emails, adding stock copy the first time', () => {
    const on = setKindEnabled([], 'thank_you', true);
    expect(on).toHaveLength(1);
    expect(valid(on)).toBe(true);
    expect(setKindEnabled(on, 'thank_you', false)[0]!.enabled).toBe(false);
    expect(setKindEnabled([], 'live_now', false)).toEqual([]);
  });

  it('stops adding past the limit', () => {
    expect(setReminderOffsets([tomorrow], [-1440, -60], 1)).toHaveLength(1);
    expect(setKindEnabled([tomorrow], 'confirmation', true, 1)).toHaveLength(1);
  });

  it('converts between minutes, hours and days', () => {
    expect(splitOffset(-2880)).toEqual({amount: 2, unit: 'days'});
    expect(splitOffset(-180)).toEqual({amount: 3, unit: 'hours'});
    expect(splitOffset(-45)).toEqual({amount: 45, unit: 'minutes'});
    expect(beforeStartMinutes(2, 'days')).toBe(-2880);
    expect(beforeStartMinutes(3, 'hours')).toBe(-180);
    expect(beforeStartMinutes(0, 'minutes')).toBeNaN();
  });
});
