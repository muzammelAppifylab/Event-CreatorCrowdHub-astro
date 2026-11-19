import {describe, expect, it} from 'vitest';
import {promoteWaitlist} from '../src/server/waitlist-promote';

/** A recording stand-in for the transaction: just the calls promoteWaitlist makes. */
function fakeTx(waitlisted: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  const tx = {
    rsvp: {
      findFirst: async (args: {where: {status: string}}) => {
        calls.push('rsvp.findFirst');
        const row = waitlisted.find(r => r.status === args.where.status);
        return row ? {id: row.id} : null;
      },
      findMany: async () => {
        calls.push('rsvp.findMany');
        return waitlisted.filter(r => r.response === 'going');
      },
      aggregate: async () => {
        calls.push('rsvp.aggregate');
        return {_sum: {seats: 0}};
      },
      groupBy: async () => {
        calls.push('rsvp.groupBy');
        return [];
      },
      updateMany: async () => {
        calls.push('rsvp.updateMany');
        return {count: 1};
      },
    },
    ticketType: {
      findMany: async () => {
        calls.push('ticketType.findMany');
        return [];
      },
    },
    $executeRaw: async () => {
      calls.push('$executeRaw');
      return 0;
    },
  };
  return {tx: tx as never, calls};
}

const event = {id: '00000000-0000-4000-8000-000000000001', capacity: 10};
const now = new Date('2026-11-13T12:00:00Z');

describe('promoteWaitlist skips when nobody is waitlisted', () => {
  it('makes one probe and no seat reads, line read or renumber', async () => {
    const {tx, calls} = fakeTx([]);
    expect(await promoteWaitlist(tx, event, now)).toEqual({promotions: [], failed: []});
    expect(calls).toEqual(['rsvp.findFirst']);
  });

  it('still runs the planner for a host pick, so it reports why it failed', async () => {
    const {tx, calls} = fakeTx([]);
    const out = await promoteWaitlist(tx, event, now, {only: new Set(['00000000-0000-4000-8000-000000000009'])});
    expect(out.promotions).toEqual([]);
    expect(out.failed).toHaveLength(1);
    expect(calls).not.toContain('rsvp.findFirst');
    expect(calls).toContain('$executeRaw');
  });

  it('does the full work when someone is waitlisted', async () => {
    const row = {id: '00000000-0000-4000-8000-000000000002', status: 'waitlisted', response: 'going', seats: 1,
      waitlistPosition: 1, createdAt: now, claimExpiresAt: null, ticketTypeId: null};
    const {tx, calls} = fakeTx([row]);
    const out = await promoteWaitlist(tx, event, now);
    expect(out.promotions).toEqual([{kind: 'confirm', rsvpId: row.id, seats: 1}]);
    expect(calls[0]).toBe('rsvp.findFirst');
    expect(calls).toContain('rsvp.findMany');
    expect(calls).toContain('rsvp.updateMany');
    expect(calls.at(-1)).toBe('$executeRaw');
  });

  it('a waitlisted row that is not going still gets renumbered', async () => {
    const row = {id: '00000000-0000-4000-8000-000000000003', status: 'waitlisted', response: 'maybe'};
    const {tx, calls} = fakeTx([row]);
    expect(await promoteWaitlist(tx, event, now)).toEqual({promotions: [], failed: []});
    expect(calls.at(-1)).toBe('$executeRaw');
  });
});
