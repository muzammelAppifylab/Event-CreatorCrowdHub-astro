import {infiniteQueryOptions, queryOptions} from '@tanstack/react-query';

import {siteFetch} from '../platform/browser';
import {read} from './api';

/**
 * The guest-management reads and helpers, ONCE (same rule as `queries.ts`):
 * guests, invites, messages and contacts. Browser-safe: nothing from
 * `src/server` is imported. Calls go through `siteFetch` to
 * `/site-api/event-admin/...` (docs/porting/guests.md), so this file does not
 * depend on the typed client until the routes are mounted.
 *
 * Query keys start with `'guests'`, `'invites'`, `'messages'` or `'contacts'`:
 * a save invalidates by prefix.
 */

export const ADMIN = '/site-api/event-admin';

const JSON_HEADERS = {'content-type': 'application/json'};

export const getJson = <T>(path: string) => read<T>(siteFetch(`${ADMIN}${path}`));

export const sendJson = <T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
  read<T>(
    siteFetch(`${ADMIN}${path}`, {
      method,
      ...(body === undefined ? {} : {headers: JSON_HEADERS, body: JSON.stringify(body)}),
    })
  );

const qs = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
};

/* ── Guests ─────────────────────────────────────────────────────────── */

export type GuestStatus = 'pending' | 'confirmed' | 'waitlisted' | 'declined' | 'cancelled' | 'awaiting_payment';
export type GuestResponse = 'going' | 'maybe' | 'not_going';
export type AnswerValue = string | string[] | boolean;

export type GuestRow = {
  id: string;
  name: string;
  email: string;
  response: GuestResponse;
  status: GuestStatus;
  plusOnes: number;
  seats: number;
  ticketCode: string;
  ticketTypeId: string | null;
  ticketTypeName: string | null;
  paymentStatus: string | null;
  marketingConsent: boolean;
  checkedInAt: string | null;
  attended: boolean | null;
  waitlistPosition: number | null;
  source: string;
  createdAt: string;
  answers: Record<string, AnswerValue>;
};

export type GuestQuestion = {id: string; label: string; type: string};
export type GuestTicketType = {id: string; name: string; priceCents: number; currency: string};

export type GuestsPage = {
  items: GuestRow[];
  questions: GuestQuestion[];
  ticketTypes: GuestTicketType[];
  statusCounts: Record<string, number> | null;
  nextBefore: string | null;
};

export type GuestDetail = GuestRow & {
  confirmedAt: string | null;
  claimExpiresAt: string | null;
  updatedAt: string;
  questions: GuestQuestion[];
  timeline: {kind: string; at: string}[];
};

export type GuestFilter = {status: string; response: string; ticketTypeId: string; checkedIn: string; q: string};
export const NO_GUEST_FILTER: GuestFilter = {status: '', response: '', ticketTypeId: '', checkedIn: '', q: ''};

export type BulkAction = 'approve' | 'decline' | 'promote' | 'remove' | 'erase';
export type BulkResult = {action: BulkAction; succeeded: string[]; failed: {rsvpId: string; reason: string}[]};

export const guestsQuery = (eventId: string, filter: GuestFilter) =>
  infiniteQueryOptions({
    queryKey: ['guests', eventId, 'list', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) => getJson<GuestsPage>(`/events/${eventId}/guests${qs({...filter, before: pageParam})}`),
    getNextPageParam: last => last.nextBefore ?? undefined,
  });

export const guestQuery = (eventId: string, rsvpId: string) =>
  queryOptions({
    queryKey: ['guests', eventId, 'detail', rsvpId],
    queryFn: () => getJson<GuestDetail>(`/events/${eventId}/guests/${rsvpId}`),
  });

export const guestsExportUrl = (eventId: string, filter: GuestFilter) => `${ADMIN}/events/${eventId}/guests/export.csv${qs(filter)}`;
export const contactsExportUrl = (filter: ContactFilter) =>
  `${ADMIN}/contacts/export.csv${qs({q: filter.q, consent: filter.consent, repeat: filter.repeat, attended: filter.attended, event: filter.event})}`;

/* ── Contacts ───────────────────────────────────────────────────────── */

export type ContactRow = {
  email: string;
  name: string;
  eventCount: number;
  lastEvent: {id: string; title: string; startAt: string};
  marketingConsent: boolean;
  attendedCount: number;
  firstSeenAt: string;
};
export type ContactFilter = {q: string; consent: 'yes' | ''; repeat: 'yes' | ''; attended: 'yes' | ''; event: string};
export const EMPTY_CONTACT_FILTER: ContactFilter = {q: '', consent: '', repeat: '', attended: '', event: ''};
export const CONTACT_PAGE_SIZES = [25, 50, 100] as const;

export const contactsQuery = (filter: ContactFilter, limit: number = CONTACT_PAGE_SIZES[1]) =>
  infiniteQueryOptions({
    queryKey: ['contacts', filter, limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) =>
      getJson<{items: ContactRow[]; nextBefore: string | null}>(
        `/contacts${qs({q: filter.q, consent: filter.consent, repeat: filter.repeat, attended: filter.attended, event: filter.event, limit: String(limit), before: pageParam})}`
      ),
    getNextPageParam: last => last.nextBefore ?? undefined,
  });

export type ContactDetail = {
  contact: {email: string; name: string; eventCount: number; attendedCount: number; firstSeenAt: string; marketingConsent: boolean};
  rsvps: {
    id: string;
    eventId: string;
    eventTitle: string;
    startAt: string;
    timezone: string;
    response: GuestResponse;
    status: string;
    seats: number;
    plusOnes: number;
    ticketCode: string;
    checkedInAt: string | null;
    attended: boolean | null;
    source: string;
    createdAt: string;
  }[];
};

export const contactDetailQuery = (email: string) =>
  queryOptions({
    queryKey: ['contacts', 'detail', email],
    queryFn: () => getJson<ContactDetail>(`/contacts/detail${qs({email})}`),
  });

/* ── Invites ────────────────────────────────────────────────────────── */

export type InviteRow = {
  id: string;
  email: string;
  name: string | null;
  status: 'queued' | 'sent' | 'bounced' | 'responded';
  rsvpResponse: GuestResponse | null;
  sentAt: string | null;
  lastResentAt: string | null;
  link: string;
};
export type CreateInvitesResult = {queued: number; sent: number; skippedInvalid: string[]; skippedDuplicate: string[]};

export const invitesQuery = (eventId: string) =>
  infiniteQueryOptions({
    queryKey: ['invites', eventId, 'list'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) =>
      getJson<{items: InviteRow[]; nextBefore: string | null}>(`/events/${eventId}/invites${qs({before: pageParam})}`),
    getNextPageParam: last => last.nextBefore ?? undefined,
  });

export const resendPreviewQuery = (eventId: string) =>
  queryOptions({
    queryKey: ['invites', eventId, 'resend-preview'],
    queryFn: () => getJson<{count: number}>(`/events/${eventId}/invites/resend-preview`),
  });

export const shareKitQuery = (eventId: string) =>
  queryOptions({
    queryKey: ['invites', eventId, 'share-kit'],
    queryFn: () => getJson<{title: string; slug: string; base: string; eventUrl: string; published: boolean}>(`/events/${eventId}/share-kit`),
  });

/* ── Messages ───────────────────────────────────────────────────────── */

export type Segment = 'going' | 'maybe' | 'waitlisted' | 'pending' | 'checked_in' | 'no_show' | 'all';
export type ReminderKind = 'confirmation' | 'reminder' | 'live_now' | 'thank_you';

export const SEGMENTS: readonly Segment[] = ['going', 'maybe', 'waitlisted', 'pending', 'checked_in', 'no_show', 'all'];
export const SEGMENT_LABELS: Record<Segment, string> = {
  going: 'Going',
  maybe: 'Maybe',
  waitlisted: 'Waitlisted',
  pending: 'Pending approval',
  checked_in: 'Checked in',
  no_show: 'No-shows',
  all: 'All active guests',
};

export const REMINDER_KIND_LABELS: Record<ReminderKind, string> = {
  confirmation: 'Confirmation',
  reminder: 'Reminder',
  live_now: 'We’re live',
  thank_you: 'Thank you',
};

/** Offset bounds per kind, in minutes: the SAME limits `admin-messages.ts` enforces. */
export const RULE_OFFSET_LIMITS: Record<ReminderKind, {min: number; max: number}> = {
  confirmation: {min: 0, max: 0},
  reminder: {min: -14 * 24 * 60, max: 0},
  live_now: {min: -60, max: 60},
  thank_you: {min: 0, max: 7 * 24 * 60},
};

/** Starting copy when a host adds a rule. */
export const DEFAULT_RULE_COPY: Record<ReminderKind, {offsetMinutes: number; subject: string; body: string}> = {
  confirmation: {
    offsetMinutes: 0,
    subject: "You're in: {{event.title}}",
    body: "Hi {{guest.first_name}},\n\nThanks for your RSVP. We've saved your place for {{event.start_local}}.",
  },
  reminder: {
    offsetMinutes: -24 * 60,
    subject: 'Tomorrow: {{event.title}}',
    body: "Hi {{guest.first_name}},\n\nA quick reminder that {{event.title}} starts {{event.start_local}}.\n\nTaking part in the live poll? Join with this link when we start: {{poll.join_url}}\n\nCan't make it any more? Update your RSVP: {{rsvp.manage_url}}",
  },
  live_now: {
    offsetMinutes: 0,
    subject: "We're live: {{event.title}}",
    body: "Hi {{guest.first_name}},\n\nWe're starting now. Join here: {{event.join_url}}",
  },
  thank_you: {
    offsetMinutes: 120,
    subject: 'Thanks for coming to {{event.title}}',
    body: "Hi {{guest.first_name}},\n\nThank you for joining us. We'd love your feedback.",
  },
};

export type RuleRow = {
  id: string;
  eventId: string;
  kind: ReminderKind;
  offsetMinutes: number;
  enabled: boolean;
  subject: string;
  body: string;
};
export type MessageLogRow = {
  id: string;
  segment: Segment;
  subject: string;
  sentCount: number;
  failedCount: number;
  sentBy: number | null;
  createdAt: string;
};
export type BroadcastResult = {message: MessageLogRow; failed: number};
export type EmailPreview = {
  subject: string;
  html: string;
  text: string;
  recipient: {name: string; sample: boolean};
  unknownTags: string[];
};

export const rulesQuery = (eventId: string) =>
  queryOptions({
    queryKey: ['messages', eventId, 'rules'],
    queryFn: () => getJson<{rules: RuleRow[]}>(`/events/${eventId}/messages/rules`),
  });

export const segmentsQuery = (eventId: string) =>
  queryOptions({
    queryKey: ['messages', eventId, 'segments'],
    queryFn: () => getJson<{counts: Record<Segment, number>; eventEnded: boolean}>(`/events/${eventId}/messages/segments`),
  });

export const messageLogQuery = (eventId: string) =>
  infiniteQueryOptions({
    queryKey: ['messages', eventId, 'log'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) =>
      getJson<{items: MessageLogRow[]; nextBefore: string | null}>(`/events/${eventId}/messages${qs({before: pageParam})}`),
    getNextPageParam: last => last.nextBefore ?? undefined,
  });

/* ── Pure helpers (unit-tested) ─────────────────────────────────────── */

export type OffsetUnit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<OffsetUnit, number> = {minutes: 1, hours: 60, days: 1440};

function unitFor(minutes: number): OffsetUnit {
  if (minutes >= 2880 && minutes % 1440 === 0) return 'days';
  if (minutes !== 0 && minutes % 60 === 0) return 'hours';
  return 'minutes';
}

function amountWords(minutes: number): string {
  const unit = unitFor(minutes);
  const n = minutes / UNIT_MINUTES[unit];
  return `${n} ${n === 1 ? unit.slice(0, -1) : unit}`;
}

/** "24 hours before", "At the start", "2 hours after the end", "Straight after the RSVP". */
export function describeOffset(kind: ReminderKind, offsetMinutes: number): string {
  if (kind === 'confirmation') return 'Straight after the RSVP';
  if (kind === 'thank_you') {
    const after = Math.abs(offsetMinutes);
    return after === 0 ? 'When the event ends' : `${amountWords(after)} after the end`;
  }
  if (offsetMinutes === 0) return 'At the start';
  return offsetMinutes < 0 ? `${amountWords(-offsetMinutes)} before` : `${amountWords(offsetMinutes)} after the start`;
}

/** -1440 -> 24 hours, -4320 -> 3 days. */
export function splitOffset(offsetMinutes: number): {amount: number; unit: OffsetUnit} {
  const abs = Math.abs(offsetMinutes);
  const unit = unitFor(abs);
  return {amount: abs / UNIT_MINUTES[unit], unit};
}

/** The editor's amount back to stored minutes: reminders before the start, thank-yous after the end. */
export function joinOffset(kind: ReminderKind, amount: number, unit: OffsetUnit, after = false): number {
  const minutes = Math.round(Math.max(0, amount) * UNIT_MINUTES[unit]);
  if (kind === 'reminder') return -minutes;
  if (kind === 'live_now') return after ? minutes : -minutes;
  if (kind === 'thank_you') return minutes;
  return 0;
}

/** Insert `token` over the selection; returns the new value and where the caret goes. */
export function insertAtCursor(value: string, token: string, start: number | null, end: number | null) {
  const from = start ?? value.length;
  const to = end ?? from;
  return {value: value.slice(0, from) + token + value.slice(to), caret: from + token.length};
}

const REASONS: Record<string, string> = {
  not_found: 'no longer on the list',
  not_pending: 'not pending',
  not_waitlisted: 'not on the waitlist',
  event_full: 'no seats left',
  event_cancelled: 'event cancelled',
  has_order: 'has a payment (erase instead)',
  checkout_in_progress: 'checkout in progress',
  claim_pending: 'claim offer already out',
};
const reasonLabel = (reason: string) => REASONS[reason] ?? REASONS[reason.split(':')[0]!.trim()] ?? reason;
const DONE: Record<BulkAction, string> = {approve: 'approved', decline: 'declined', promote: 'promoted', remove: 'removed', erase: 'erased'};
export const guestCount = (n: number) => `${n} ${n === 1 ? 'guest' : 'guests'}`;

/** One toast line for a partial-success report: "2 promoted. 3 skipped: no seats left (3)." */
export function summarizeBulk(result: BulkResult): {ok: boolean; message: string} {
  const done = `${guestCount(result.succeeded.length)} ${DONE[result.action]}.`;
  if (!result.failed.length) return {ok: true, message: done};
  const byReason = new Map<string, number>();
  for (const f of result.failed) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
  const why = [...byReason].map(([reason, n]) => `${reasonLabel(reason)} (${n})`).join(', ');
  return {ok: result.succeeded.length > 0, message: `${done} ${result.failed.length} skipped: ${why}.`};
}

/** One guest's full data (the guest's own export document), an organiser download. */
export const guestDataUrl = (eventId: string, rsvpId: string) => `${ADMIN}/events/${eventId}/guests/${rsvpId}/data`;

export const answerText = (value: AnswerValue | undefined): string =>
  value === undefined ? '' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : Array.isArray(value) ? value.join(', ') : value;

/** Share kit: plain share URLs, no SDKs or tracking scripts. */
export type SharePlatform = 'x' | 'linkedin' | 'whatsapp' | 'facebook';
export const SHARE_LABELS: Record<SharePlatform, string> = {x: 'X', linkedin: 'LinkedIn', whatsapp: 'WhatsApp', facebook: 'Facebook'};

export const shareText = (title: string) => `Join me at ${title.trim()}. RSVP here:`;

export function shareUrl(platform: SharePlatform, eventUrl: string, title: string): string {
  const params = (p: Record<string, string>) => new URLSearchParams(p).toString();
  const text = shareText(title);
  switch (platform) {
    case 'x':
      return `https://twitter.com/intent/tweet?${params({text, url: eventUrl})}`;
    case 'linkedin':
      return `https://www.linkedin.com/sharing/share-offsite/?${params({url: eventUrl})}`;
    case 'whatsapp':
      return `https://wa.me/?${params({text: `${text} ${eventUrl}`})}`;
    case 'facebook':
      return `https://www.facebook.com/sharer/sharer.php?${params({u: eventUrl})}`;
  }
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An iframe for the event page without its header (`?embed=1`). */
export function embedCode(base: string, slug: string, title: string): string {
  const src = `${base.replace(/\/+$/, '')}/e/${encodeURIComponent(slug)}?embed=1`;
  return (
    `<iframe src="${escapeAttr(src)}" title="${escapeAttr(`RSVP: ${title}`)}" ` +
    `width="100%" height="720" style="border:0;max-width:640px" loading="lazy"></iframe>`
  );
}

/**
 * Saves a CSV export. Goes through `siteFetch` (not a plain link) so the session
 * travels in the editor Preview too. Returns whether the export was cut at its row cap.
 */
export async function downloadExport(url: string, fallbackName: string): Promise<{truncated: boolean}> {
  const res = await siteFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {message?: string} | null;
    throw new Error(body?.message ?? `Export failed (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const blobUrl = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
  return {truncated: res.headers.get('x-export-truncated') === '1'};
}
