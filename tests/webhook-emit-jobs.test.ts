import {describe, expect, it, vi} from 'vitest';

import {emitCancelledIds, emitPromoted, emitSeated, JOB_EMIT_CAP} from '../src/server/webhook-emit';

const sent: {event: string; body: string}[] = [];
const jobs: number[] = [];
vi.mock('../src/platform/background', async orig => ({
  ...(await orig<typeof import('../src/platform/background')>()),
  sendJob: async (_u: string, _l: string, data: {items: {event: string; body: string}[]}) => {
    jobs.push(data.items.length);
    sent.push(...data.items);
    return {id: 'j'} as never;
  },
}));

const db = {webhookEndpoint: {findMany: async () => [{id: 'e1', events: ['rsvp.cancelled', 'rsvp.updated']}]}} as never;
const flush = () => new Promise(r => setTimeout(r, 30));
const bodies = () => sent.map(s => ({event: s.event, ...JSON.parse(s.body).data}));

describe('webhooks from background paths (no request, no viewer)', () => {
  it('emits rsvp.cancelled per released guest, capped', async () => {
    sent.length = 0;
    jobs.length = 0;
    emitCancelledIds(db, 'ev1', ['a', 'b']);
    await flush();
    expect(bodies().map(b => [b.event, b.rsvpId, b.status])).toEqual([['rsvp.cancelled', 'a', 'cancelled'], ['rsvp.cancelled', 'b', 'cancelled']]);
    sent.length = 0;
    jobs.length = 0;
    emitCancelledIds(db, 'ev1', Array.from({length: JOB_EMIT_CAP + 20}, (_, i) => `r${i}`));
    await flush();
    expect(sent).toHaveLength(JOB_EMIT_CAP);
    expect(jobs.length).toBeLessThanOrEqual(2); // a bulk emit is a handful of jobs, never one per event
  });
  it('emits rsvp.updated only for seated (confirm) promotions, not claim offers', async () => {
    sent.length = 0;
    emitSeated(db, 'ev1', [{rsvpId: 'a', kind: 'confirm'}, {rsvpId: 'b', kind: 'offer_claim'}]);
    await flush();
    expect(bodies().map(b => [b.rsvpId, b.status])).toEqual([['a', 'confirmed']]);
  });
  it('emitPromoted skips claim offers', async () => {
    sent.length = 0;
    emitPromoted(null, db, [{rsvp: {id: 'a', eventId: 'ev1', status: 'confirmed'}}, {rsvp: {id: 'b', eventId: 'ev1', status: 'waitlisted'}, claim: true}]);
    await flush();
    expect(bodies().map(b => b.rsvpId)).toEqual(['a']);
  });
});
