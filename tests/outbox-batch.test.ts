import {describe, expect, it, vi} from 'vitest';

vi.mock('../src/platform/config', () => ({
  config: {siteUrl: 'https://site.example.test', jwtSecret: 'test-secret-for-batch-reads-0123456789', production: false, ownerSecret: () => null},
}));

import {confirmationRuleFor, confirmationRulesFor} from '../src/server/jobs/guest-emails';
import {type Db, loadGuestMail, loadGuestMails} from '../src/server/jobs/shared';

const now = new Date('2026-11-16T10:00:00Z');
const brand = {senderName: 'The Studio', replyToEmail: 'host@example.test'};
const event = (over: Record<string, unknown> = {}) => ({
  title: 'Launch night', slug: 'launch-night', startAt: new Date('2026-12-01T18:00:00Z'), endAt: null, timezone: 'Europe/London',
  format: 'in_person', venueName: 'Hall', venueAddress: '1 Road', mapUrl: null, joinUrl: null, pollJoinCode: 'ABC123',
  thankYouLink: null, status: 'published', visibility: 'public', deletedAt: null, ...over,
});
const rsvp = (id: string, over: Record<string, unknown> = {}) => ({
  id, eventId: 'e1', name: `Guest ${id}`, email: `${id}@example.test`, response: 'going', status: 'confirmed', ticketCode: `T-${id}`,
  waitlistPosition: null, claimExpiresAt: null, event: event(), ...over,
});

const rows = [
  rsvp('11111111-1111-4111-8111-111111111111'),
  rsvp('22222222-2222-4222-8222-222222222222', {status: 'waitlisted', claimExpiresAt: new Date('2026-11-17T10:00:00Z')}),
  rsvp('33333333-3333-4333-8333-333333333333', {event: event({deletedAt: new Date('2026-11-01T00:00:00Z')})}),
];

function mailDb() {
  const findMany = vi.fn(async ({where}: {where: {id: {in: string[]}}}) => rows.filter(r => where.id.in.includes(r.id)));
  const findUnique = vi.fn(async ({where}: {where: {id: string}}) => rows.find(r => r.id === where.id) ?? null);
  return {db: {rsvp: {findMany, findUnique}} as unknown as Db, findMany, findUnique};
}

describe('loadGuestMails', () => {
  it('reads a round in ONE query and maps each row exactly as loadGuestMail does', async () => {
    const {db, findMany} = mailDb();
    const ids = [...rows.map(r => r.id), rows[0].id, '44444444-4444-4444-8444-444444444444'];
    const mails = await loadGuestMails(db, ids, now, {brand});
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.id.in).toHaveLength(4);
    expect([...mails.keys()].sort()).toEqual([rows[0].id, rows[1].id]);
    for (const row of rows) {
      expect(mails.get(row.id) ?? null).toEqual(await loadGuestMail(db, row.id, now, {brand}));
    }
  });

  it('reads nothing for an empty round', async () => {
    const {db, findMany} = mailDb();
    expect((await loadGuestMails(db, [], now, {brand})).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('confirmationRulesFor', () => {
  const ruleRows = [
    {id: 'k1', eventId: 'e1', enabled: true, subject: 'S1', body: 'B1'},
    {id: 'k2', eventId: 'e2', enabled: false, subject: 'S2', body: 'B2'},
  ];
  const ruleDb = () => {
    const findMany = vi.fn(async ({where}: {where: {eventId: {in: string[]}}}) => ruleRows.filter(r => where.eventId.in.includes(r.eventId)));
    const findFirst = vi.fn(async ({where}: {where: {eventId: string}}) => {
      const r = ruleRows.find(x => x.eventId === where.eventId);
      return r ? {id: r.id, enabled: r.enabled, subject: r.subject, body: r.body} : null;
    });
    return {db: {reminderRule: {findMany, findFirst}} as unknown as Db, findMany};
  };

  it('answers every event in ONE query, the same as confirmationRuleFor', async () => {
    const {db, findMany} = ruleDb();
    const rules = await confirmationRulesFor(db, ['e1', 'e2', 'e3', 'e1']);
    expect(findMany).toHaveBeenCalledTimes(1);
    for (const id of ['e1', 'e2', 'e3']) expect(rules.get(id)).toEqual(await confirmationRuleFor(db, id));
    expect(rules.get('e3')).toEqual({skip: false, ruleId: null, copy: null});
    expect(rules.get('e2')?.skip).toBe(true);
  });
});
