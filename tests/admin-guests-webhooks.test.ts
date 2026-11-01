import {describe, expect, it} from 'vitest';

import {confirmationRuleFor} from '../src/server/jobs/guest-emails';
import {ADMIN_EMIT_CAP, webhookChangesFor} from '../src/server/routes/admin-guests';

const guest = (id: string, status: string) => ({id, name: 'N', email: 'n@x.com', response: 'going', status, ticketCode: null, waitlistPosition: null}) as never;

describe('admin guest webhook changes', () => {
  it('emits rsvp.updated per approved / declined / promoted guest, with the public payload shape', () => {
    const changes = webhookChangesFor('ev1', [
      {kind: 'confirmation', guest: guest('r1', 'confirmed')},
      {kind: 'declined', guest: guest('r2', 'declined')},
    ]);
    expect(changes).toEqual([
      {name: 'rsvp.updated', payload: {eventId: 'ev1', rsvpId: 'r1', status: 'confirmed', response: 'going'}},
      {name: 'rsvp.updated', payload: {eventId: 'ev1', rsvpId: 'r2', status: 'declined', response: 'going'}},
    ]);
  });
  it('a waitlist offer changes no status, so it emits nothing', () => {
    expect(webhookChangesFor('ev1', [{kind: 'waitlist_offer', guest: guest('r1', 'waitlisted'), claimExpiresAt: new Date()}])).toEqual([]);
  });
  it('removed guests emit rsvp.removed plus the promotions their seat caused', () => {
    const changes = webhookChangesFor('ev1', [{kind: 'confirmation', guest: guest('r9', 'confirmed')}], [{id: 'r1', status: 'confirmed', response: 'going'}]);
    expect(changes.map(c => [c.name, c.payload.rsvpId])).toEqual([['rsvp.removed', 'r1'], ['rsvp.updated', 'r9']]);
  });
  it('is bounded', () => {
    const notices = Array.from({length: ADMIN_EMIT_CAP + 50}, (_, i) => ({kind: 'confirmation' as const, guest: guest(`r${i}`, 'confirmed')}));
    expect(webhookChangesFor('ev1', notices)).toHaveLength(ADMIN_EMIT_CAP);
  });
});

describe('confirmationRuleFor', () => {
  const dbWith = (rule: unknown) => ({reminderRule: {findFirst: async () => rule}}) as never;
  it('uses the default copy without a rule', async () => {
    expect(await confirmationRuleFor(dbWith(null), 'ev1')).toEqual({skip: false, ruleId: null, copy: null});
  });
  it('skips a disabled rule', async () => {
    expect((await confirmationRuleFor(dbWith({id: 'k', enabled: false, subject: 's', body: 'b'}), 'ev1')).skip).toBe(true);
  });
  it('returns the host copy of an enabled rule', async () => {
    expect(await confirmationRuleFor(dbWith({id: 'k', enabled: true, subject: 'S', body: 'B'}), 'ev1')).toEqual({skip: false, ruleId: 'k', copy: {subject: 'S', body: 'B'}});
  });
});
