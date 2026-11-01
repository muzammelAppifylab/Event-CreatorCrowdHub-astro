import {describe, expect, it} from 'vitest';

import {checkedInPayload, emitWebhook, pollClosedPayload, rsvpPayload} from '../src/server/webhook-emit';

const sent: {list: string; data: {items: {event: string; body: string}[]}}[] = [];
import {vi} from 'vitest';
vi.mock('../src/platform/background', async orig => ({
  ...(await orig<typeof import('../src/platform/background')>()),
  sendJob: async (_u: string, list: string, data: never) => {
    sent.push({list, data});
    return {id: 'j'} as never;
  },
}));

const fakeDb = (events: string[]) =>
  ({webhookEndpoint: {findMany: async () => [{id: 'e1', events}]}}) as never;

const run = async (event: Parameters<typeof emitWebhook>[2], payload: unknown) => {
  sent.length = 0;
  emitWebhook(null, fakeDb([event]), event, payload);
  await new Promise(r => setTimeout(r, 20));
  return sent.flatMap(s => s.data.items.map(i => JSON.parse(i.body)));
};

describe('webhook emit payloads', () => {
  it('rsvp.created has ids and status only, no PII', async () => {
    const [body] = await run('rsvp.created', rsvpPayload({id: 'r1', eventId: 'ev1', status: 'confirmed', response: 'yes', ...{email: 'a@b.c', name: 'A'}}));
    expect(JSON.stringify(body)).toContain('"rsvpId":"r1"');
    expect(JSON.stringify(body)).not.toMatch(/a@b\.c|"name"/);
    expect(rsvpPayload({id: 'r1', eventId: 'ev1', status: 'confirmed', response: 'yes'})).toEqual({eventId: 'ev1', rsvpId: 'r1', status: 'confirmed', response: 'yes'});
  });
  it('guest.checked_in carries an ISO timestamp', async () => {
    const at = new Date('2026-01-02T03:04:05Z');
    expect(checkedInPayload({id: 'r1', eventId: 'ev1', checkedInAt: at})).toEqual({eventId: 'ev1', rsvpId: 'r1', checkedInAt: at.toISOString()});
    expect(await run('guest.checked_in', checkedInPayload({id: 'r1', eventId: 'ev1', checkedInAt: at}))).toHaveLength(1);
  });
  it('poll.closed has event and poll ids; unsubscribed events queue nothing', async () => {
    expect(pollClosedPayload({id: 'p1', eventId: 'ev1'})).toEqual({eventId: 'ev1', pollId: 'p1'});
    sent.length = 0;
    emitWebhook(null, fakeDb(['rsvp.created']), 'poll.closed', {});
    await new Promise(r => setTimeout(r, 20));
    expect(sent).toHaveLength(0);
  });
});
