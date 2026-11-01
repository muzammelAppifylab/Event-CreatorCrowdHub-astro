import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {PERMISSIONS} from '../permissions';

/**
 * Event analytics for people who manage events (ported from CreatorCrowdHub, US-32).
 * Mount: `.route('/analytics', adminAnalyticsRoutes)`.
 *
 *   GET /analytics/events/:eventId   KPIs (incl. paid revenue, poll participation), views per day, utm sources (`site:event:manage`)
 *
 * Every number is one aggregate scoped to the event (indexes: page_views (event_id, created_at),
 * rsvps (event_id)); nothing counts a whole table. Views are unique visitors per UTC day, summed
 * (the visitor hash is salted daily, so one person on two days counts twice, by design).
 */

const DAY_MS = 86_400_000;
export const VIEWS_WINDOW_DAYS = 14;
export const MAX_SOURCES = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------ pure metrics --

export type Ratio = {value: number | null; numerator: number; denominator: number; reason: string | null};

export function ratio(numerator: number, denominator: number, reasonIfEmpty: string): Ratio {
  if (denominator <= 0) return {value: null, numerator, denominator, reason: reasonIfEmpty};
  return {value: numerator / denominator, numerator, denominator, reason: null};
}

/** "YYYY-MM-DD" of `at` in UTC. */
export const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/** Lowercased, trimmed, 64 chars; empty means "no source" (direct, shared link, QR). */
export function normaliseSource(raw: string | null | undefined): string | null {
  const s = raw?.trim().toLowerCase().slice(0, 64);
  return s ? s : null;
}

export type DayRange = {firstDay: string; lastDay: string};

/**
 * The chart covers the event's lifetime (creation to end, or today if sooner) when that is 14 days
 * or less, else the last 14 days of it. Never an inverted range.
 */
export function viewsDayRange(event: {createdAt: Date; endAt: Date}, now: Date): DayRange {
  const last = event.endAt < now ? event.endAt : now;
  const earliest = new Date(Date.parse(`${utcDay(last)}T00:00:00Z`) - (VIEWS_WINDOW_DAYS - 1) * DAY_MS);
  const first = event.createdAt > earliest ? event.createdAt : earliest;
  return first > last ? {firstDay: utcDay(last), lastDay: utcDay(last)} : {firstDay: utcDay(first), lastDay: utcDay(last)};
}

export function zeroFillDays(range: DayRange, counts: {date: string; count: number}[]): {date: string; views: number}[] {
  const byDay = new Map(counts.map(c => [c.date, c.count]));
  const out: {date: string; views: number}[] = [];
  for (let t = Date.parse(`${range.firstDay}T00:00:00Z`); t <= Date.parse(`${range.lastDay}T00:00:00Z`); t += DAY_MS) {
    const date = utcDay(new Date(t));
    out.push({date, views: byDay.get(date) ?? 0});
  }
  return out;
}

export type SourceCount = {source: string | null; count: number};
export type SourceRow = {source: string | null; views: number; rsvps: number};

export function topSources(views: SourceCount[], rsvps: SourceCount[], limit = MAX_SOURCES): SourceRow[] {
  const rows = new Map<string, SourceRow>();
  const key = (s: string | null) => s ?? '\u0000direct';
  const add = (c: SourceCount, field: 'views' | 'rsvps') => {
    const source = normaliseSource(c.source);
    const row = rows.get(key(source)) ?? {source, views: 0, rsvps: 0};
    row[field] += c.count;
    rows.set(key(source), row);
  };
  views.forEach(c => add(c, 'views'));
  rsvps.forEach(c => add(c, 'rsvps'));
  return [...rows.values()]
    .sort((a, b) => b.views - a.views || b.rsvps - a.rsvps || (a.source ?? '').localeCompare(b.source ?? ''))
    .slice(0, limit);
}

export type RsvpAgg = {response: string; status: string; count: number; showedUp: number};

/** Confirmed "going" guests: the show-rate denominator. A Maybe never counts as going. */
export const goingCount = (rows: RsvpAgg[]) =>
  rows.reduce((n, r) => (r.status === 'confirmed' && r.response === 'going' ? n + r.count : n), 0);

/** Confirmed guests who answered Maybe (they hold no seat). */
export const maybeCount = (rows: RsvpAgg[]) =>
  rows.reduce((n, r) => (r.status === 'confirmed' && r.response === 'maybe' ? n + r.count : n), 0);

/** Guests on the waitlist, whatever they answered. */
export const waitlistedCount = (rows: RsvpAgg[]) => rows.reduce((n, r) => (r.status === 'waitlisted' ? n + r.count : n), 0);

/** Checked in or marked attended ÷ going, once the event is over (before that, check-ins still arrive). */
export function showRate(rows: RsvpAgg[], ended: boolean): Ratio {
  const going = goingCount(rows);
  const showed = rows.reduce((n, r) => (r.status === 'confirmed' && r.response === 'going' ? n + r.showedUp : n), 0);
  if (!ended) return {value: null, numerator: showed, denominator: going, reason: 'Available after the event ends.'};
  return ratio(showed, going, 'No confirmed going guests.');
}

/** Unique voters (devices that answered at least one poll) ÷ confirmed guests. Anonymous devices can include non-guests, so it may pass 100%. */
export const pollParticipation = (votes: number, confirmedGuests: number) => ratio(votes, confirmedGuests, 'No confirmed guests.');

export type RevenueRow = {currency: string; amountCents: number; orders: number};

/** Paid orders only (refunded, pending, expired excluded by the query); biggest currency first, upper-cased. */
export function revenueByCurrency(rows: RevenueRow[]): RevenueRow[] {
  const by = new Map<string, RevenueRow>();
  for (const r of rows) {
    const currency = r.currency.toUpperCase();
    const row = by.get(currency) ?? {currency, amountCents: 0, orders: 0};
    row.amountCents += r.amountCents;
    row.orders += r.orders;
    by.set(currency, row);
  }
  return [...by.values()].sort((a, b) => b.amountCents - a.amountCents || a.currency.localeCompare(b.currency));
}

/** RSVPs received ÷ unique views. */
export const conversion = (rsvps: number, views: number) => ratio(rsvps, views, 'No page views recorded yet.');

// ------------------------------------------------------------------ route --

const eventParam = validator('param', (value, c) => {
  const id = typeof value.eventId === 'string' ? value.eventId : '';
  if (!UUID.test(id)) return c.json(problem('not_found', 'Event not found.'), 404);
  return {eventId: id.toLowerCase()};
});

export const adminAnalyticsRoutes = new Hono().get(
  '/events/:eventId',
  eventParam,
  withViewer,
  requireAuth,
  requirePermission(PERMISSIONS.EVENT_MANAGE),
  withDb,
  async c => {
    const {eventId} = c.req.valid('param');
    const db = c.var.db;
    const event = await db.event.findFirst({
      where: {id: eventId, deletedAt: null},
      select: {id: true, format: true, createdAt: true, endAt: true},
    });
    if (!event) return c.json(problem('not_found', 'Event not found.'), 404);

    const now = new Date();
    const range = viewsDayRange(event, now);
    const from = new Date(`${range.firstDay}T00:00:00Z`);
    const to = new Date(Date.parse(`${range.lastDay}T00:00:00Z`) + DAY_MS);

    const [rsvpRows, views, daily, viewSources, rsvpSources, revenueRows, voterRows] = await Promise.all([
      db.$queryRaw<RsvpAgg[]>`
        select response::text as response, status::text as status, count(*)::int as count,
               (count(*) filter (where checked_in_at is not null or attended = true))::int as "showedUp"
        from rsvps where event_id = ${eventId}::uuid group by response, status`,
      db.pageView.count({where: {eventId}}),
      db.$queryRaw<{date: string; count: number}[]>`
        select to_char(day, 'YYYY-MM-DD') as date, count(*)::int as count
        from page_views
        where event_id = ${eventId}::uuid and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz
        group by 1`,
      // Sources are visitor-supplied strings: only the top few, never every distinct value.
      db.$queryRaw<{source: string | null; count: number}[]>`
        select utm_source as source, count(*)::int as count
        from page_views where event_id = ${eventId}::uuid
        group by utm_source order by count(*) desc limit ${MAX_SOURCES * 2}`,
      db.$queryRaw<{source: string | null; count: number}[]>`
        select utm_source as source, count(*)::int as count
        from rsvps where event_id = ${eventId}::uuid
        group by utm_source order by count(*) desc limit ${MAX_SOURCES * 2}`,
      // Paid revenue per currency: orders reach the event through rsvps (event_id index) and ticket_orders_rsvp_id_idx.
      db.$queryRaw<RevenueRow[]>`
        select o.currency as currency, coalesce(sum(o.amount_cents), 0)::int as "amountCents", count(*)::int as orders
        from ticket_orders o join rsvps r on r.id = o.rsvp_id
        where r.event_id = ${eventId}::uuid and o.status = 'paid'
        group by o.currency limit 10`,
      // UNIQUE voters (distinct device tokens across the event's polls), via poll_votes_poll_voter_uq and polls.event_id.
      db.$queryRaw<{voters: number}[]>`
        select count(distinct v.voter_token)::int as voters
        from poll_votes v join polls p on p.id = v.poll_id
        where p.event_id = ${eventId}::uuid`,
    ]);

    const ended = event.endAt < now;
    const total = rsvpRows.reduce((n, r) => n + r.count, 0);
    const confirmedGuests = rsvpRows.reduce((n, r) => (r.status === 'confirmed' ? n + r.count : n), 0);
    const checkedIn = rsvpRows.reduce((n, r) => n + r.showedUp, 0);
    return c.json({
      eventId: event.id,
      generatedAt: now.toISOString(),
      ended,
      views,
      rsvps: {total, going: goingCount(rsvpRows), maybe: maybeCount(rsvpRows), waitlisted: waitlistedCount(rsvpRows), checkedIn},
      conversion: conversion(total, views),
      showRate: showRate(rsvpRows, ended),
      viewsByDay: zeroFillDays(range, daily),
      sources: topSources(viewSources, rsvpSources),
      revenue: revenueByCurrency(revenueRows),
      pollParticipation: pollParticipation(voterRows[0]?.voters ?? 0, confirmedGuests),
    });
  }
);
