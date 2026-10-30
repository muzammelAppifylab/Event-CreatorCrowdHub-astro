import {Hono} from 'hono';

import {requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {PERMISSIONS} from '../permissions';

/**
 * Events dashboard numbers. Mount: `.route('/overview', adminOverviewRoutes)` -> `GET /overview`.
 *
 * Bounded: at most UPCOMING_LIMIT upcoming events, ONE groupBy over those events' RSVPs
 * (rsvps_event_status_idx), and the newest RECENT_LIMIT RSVPs of those events. No table-wide count().
 */
export const UPCOMING_LIMIT = 10;
export const RECENT_LIMIT = 8;

export type StatusGroup = {eventId: string; status: string; guests: number; seats: number};

/** Fold groupBy rows into per-event and total numbers. Pure, so it is unit-tested. */
export function summarize(groups: StatusGroup[]) {
  const totals = {going: 0, waitlisted: 0, pending: 0};
  const perEvent: Record<string, {going: number; waitlisted: number; pending: number}> = {};
  for (const g of groups) {
    const slot = (perEvent[g.eventId] ??= {going: 0, waitlisted: 0, pending: 0});
    if (g.status === 'confirmed') {
      slot.going += g.seats;
      totals.going += g.seats;
    } else if (g.status === 'waitlisted') {
      slot.waitlisted += g.guests;
      totals.waitlisted += g.guests;
    } else if (g.status === 'pending') {
      slot.pending += g.guests;
      totals.pending += g.guests;
    }
  }
  return {totals, perEvent};
}

export const adminOverviewRoutes = new Hono().get('/', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
  const db = c.var.db;
  const upcoming = await db.event.findMany({
    where: {deletedAt: null, status: 'published', endAt: {gte: new Date()}},
    orderBy: {startAt: 'asc'},
    take: UPCOMING_LIMIT,
    select: {id: true, title: true, startAt: true, timezone: true, capacity: true},
  });
  const ids = upcoming.map(e => e.id);
  const [groups, recent] = ids.length
    ? await Promise.all([
        db.rsvp.groupBy({by: ['eventId', 'status'], where: {eventId: {in: ids}}, _count: {_all: true}, _sum: {seats: true}}),
        db.rsvp.findMany({
          where: {eventId: {in: ids}},
          orderBy: {createdAt: 'desc'},
          take: RECENT_LIMIT,
          select: {id: true, eventId: true, name: true, status: true, response: true, seats: true, createdAt: true},
        }),
      ])
    : [[], []];
  const {totals, perEvent} = summarize(
    groups.map(g => ({eventId: g.eventId, status: g.status, guests: g._count._all, seats: g._sum.seats ?? 0}))
  );
  const titles = new Map(upcoming.map(e => [e.id, e.title]));
  return c.json({
    totals: {upcomingEvents: upcoming.length, hasMore: upcoming.length === UPCOMING_LIMIT, ...totals},
    events: upcoming.map(e => ({
      id: e.id,
      title: e.title,
      startAt: e.startAt.toISOString(),
      timezone: e.timezone,
      capacity: e.capacity,
      ...(perEvent[e.id] ?? {going: 0, waitlisted: 0, pending: 0}),
    })),
    recent: recent.map(r => ({
      id: r.id,
      eventId: r.eventId,
      eventTitle: titles.get(r.eventId) ?? '',
      name: r.name,
      status: r.status,
      response: r.response,
      seats: r.seats,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});
