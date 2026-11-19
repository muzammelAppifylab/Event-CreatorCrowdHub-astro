import {Hono} from 'hono';

import {Prisma} from '../../generated/prisma/client';
import {requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {PERMISSIONS} from '../permissions';

/**
 * Events dashboard numbers. Mount: `.route('/overview', adminOverviewRoutes)` -> `GET /overview`.
 *
 * Bounded: at most UPCOMING_LIMIT upcoming events, ONE grouped count over those events' RSVPs
 * (rsvps_event_status_idx), and the newest RECENT_LIMIT RSVPs of those events. No table-wide count().
 * Guest names only (no emails); the route needs `site:event:manage`.
 */
export const UPCOMING_LIMIT = 10;
export const RECENT_LIMIT = 8;

export const WINDOW_DAYS = 30;
/** The events the 30-day card looks at: the newest by start, so every count stays on an index prefix (event_id). */
export const METRIC_EVENT_LIMIT = 100;

export type PeriodMetrics = {rsvps: number; views: number; checkins: number};

/** The two windows ending at `now`: the last N days and the N before. Pure. */
export function periodWindows(now: Date, days = WINDOW_DAYS) {
  const ms = days * 86_400_000;
  const t = now.getTime();
  return {current: {from: new Date(t - ms), to: new Date(t)}, previous: {from: new Date(t - 2 * ms), to: new Date(t - ms)}};
}

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

type MetricRow = {
  rsvps_now: number;
  rsvps_before: number;
  checkins_now: number;
  checkins_before: number;
  views_now: number;
  views_before: number;
};
type RecentRow = {id: string; eventId: string; name: string; status: string; response: string; seats: number; createdAt: Date};

/**
 * One round trip: four reads in `Promise.all`. The upcoming events and the metric events are a
 * subquery in each statement (the same order and limit as the list), never a list of ids read
 * first and sent back.
 */
export const adminOverviewRoutes = new Hono().get('/', withViewer, requireAuth, requirePermission(PERMISSIONS.EVENT_MANAGE), withDb, async c => {
  const db = c.var.db;
  const now = new Date();
  const win = periodWindows(now);
  const upcomingIds = Prisma.sql`
    SELECT id FROM events
    WHERE deleted_at IS NULL AND status = 'published' AND end_at >= ${now}::timestamptz
    ORDER BY start_at ASC, id ASC LIMIT ${UPCOMING_LIMIT}`;
  const [upcoming, metricRows, groups, recent] = await Promise.all([
    db.event.findMany({
      where: {deletedAt: null, status: 'published', endAt: {gte: now}},
      orderBy: [{startAt: 'asc'}, {id: 'asc'}],
      take: UPCOMING_LIMIT,
      select: {id: true, title: true, startAt: true, timezone: true, capacity: true},
    }),
    // The 30-day card: the newest METRIC_EVENT_LIMIT events by start, both windows in one statement.
    db.$queryRaw<MetricRow[]>`
      WITH ev AS (SELECT id FROM events WHERE deleted_at IS NULL ORDER BY start_at DESC, id DESC LIMIT ${METRIC_EVENT_LIMIT}),
      r AS (
        SELECT
          (count(*) FILTER (WHERE created_at >= ${win.current.from}::timestamptz AND created_at < ${win.current.to}::timestamptz))::int AS rsvps_now,
          (count(*) FILTER (WHERE created_at >= ${win.previous.from}::timestamptz AND created_at < ${win.previous.to}::timestamptz))::int AS rsvps_before,
          (count(*) FILTER (WHERE checked_in_at >= ${win.current.from}::timestamptz AND checked_in_at < ${win.current.to}::timestamptz))::int AS checkins_now,
          (count(*) FILTER (WHERE checked_in_at >= ${win.previous.from}::timestamptz AND checked_in_at < ${win.previous.to}::timestamptz))::int AS checkins_before
        FROM rsvps WHERE event_id IN (SELECT id FROM ev)
          AND (created_at >= ${win.previous.from}::timestamptz OR checked_in_at >= ${win.previous.from}::timestamptz)
      ),
      v AS (
        SELECT
          (count(*) FILTER (WHERE created_at >= ${win.current.from}::timestamptz))::int AS views_now,
          (count(*) FILTER (WHERE created_at < ${win.current.from}::timestamptz))::int AS views_before
        FROM page_views WHERE event_id IN (SELECT id FROM ev)
          AND created_at >= ${win.previous.from}::timestamptz AND created_at < ${win.current.to}::timestamptz
      )
      SELECT * FROM r, v`,
    db.$queryRaw<StatusGroup[]>`
      SELECT r.event_id::text AS "eventId", r.status::text AS status, count(*)::int AS guests, coalesce(sum(r.seats), 0)::int AS seats
      FROM rsvps r WHERE r.event_id IN (${upcomingIds})
      GROUP BY r.event_id, r.status`,
    db.$queryRaw<RecentRow[]>`
      SELECT r.id::text AS id, r.event_id::text AS "eventId", r.name, r.status::text AS status, r.response::text AS response,
        r.seats::int AS seats, r.created_at AS "createdAt"
      FROM rsvps r WHERE r.event_id IN (${upcomingIds})
      ORDER BY r.created_at DESC, r.id DESC LIMIT ${RECENT_LIMIT}`,
  ]);
  const m = metricRows[0];
  const metricsNow: PeriodMetrics = {rsvps: m?.rsvps_now ?? 0, views: m?.views_now ?? 0, checkins: m?.checkins_now ?? 0};
  const metricsBefore: PeriodMetrics = {rsvps: m?.rsvps_before ?? 0, views: m?.views_before ?? 0, checkins: m?.checkins_before ?? 0};
  const {totals, perEvent} = summarize(groups);
  const titles = new Map(upcoming.map(e => [e.id, e.title]));
  return c.json({
    last30: {windowDays: WINDOW_DAYS, current: metricsNow, previous: metricsBefore},
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
      createdAt: new Date(r.createdAt).toISOString(),
    })),
  });
});
