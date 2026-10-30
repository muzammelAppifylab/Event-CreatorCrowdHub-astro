/**
 * Guest-page presentation helpers (ports of CreatorCrowdHub `features/event-page/availability.ts`
 * and `copy.ts`). Pure and browser-safe: the event page renders them on the server and its script
 * re-uses `countdownParts` to tick.
 */
import type {RsvpTicketType} from './rsvp-types';

/** The guest-page strings of the original app (`guestCopy`), only those the Astro pages use. */
export const guestCopy = {
  format: {online: 'Online', in_person: 'In person', hybrid: 'In person + online'} as Record<string, string>,
  visibility: {public: 'Public', unlisted: 'Link only', private: 'Invite only'} as Record<string, string>,
  price: {free: 'Free', from: (amount: string) => `From ${amount}`},
  sections: {when: 'Date and time', countdown: 'Countdown', about: 'About this event', where: 'Location', host: 'Your host'},
  hero: {hostedBy: 'Hosted by'},
  countdown: {
    startsIn: 'Starts in',
    startsAt: (when: string) => `Starts ${when}`,
    live: 'Happening now',
    liveUntil: (time: string) => `Until ${time}`,
    ended: 'Ended',
    endedOn: (when: string) => `This event ended ${when}.`,
    units: {d: ['day', 'days'], h: ['hr', 'hrs'], m: ['min', 'mins'], s: ['sec', 'secs']} as Record<Unit, [string, string]>,
  },
  location: {onlineTitle: 'Online', onlineNote: 'Link sent after you RSVP', openMap: 'Open in maps', opensNewTab: '(opens in a new tab)'},
  host: {moreEvents: (name: string) => `More events by ${name}`},
  cta: {
    rsvp: 'Save my seat',
    rsvpFree: 'RSVP',
    request: 'Request to join',
    waitlist: 'Join waitlist',
    full: 'Full',
    closed: 'RSVPs closed',
    ended: 'Event ended',
    cancelled: 'Cancelled',
    seatsLeft: (n: number) => `${n} ${n === 1 ? 'seat' : 'seats'} left`,
    waitlistNote: "Every seat is taken. We'll email you if one opens up.",
    noWaitlistNote: "Every seat is taken and there's no waitlist.",
    closedNote: 'The RSVP deadline has passed.',
    endedNote: 'This event has finished.',
    approvalNote: 'The host approves each guest.',
  },
  cancelledBanner: {
    title: 'This event is cancelled',
    body: "The host cancelled it. Everyone who RSVP'd has been emailed, and paid tickets are being refunded.",
  },
  form: {
    title: (eventTitle: string) => `RSVP to ${eventTitle}`,
    description: "No account needed. We'll email your confirmation.",
  },
  confirmation: {
    youreIn: ['You’re', 'in'] as const,
    seats: (n: number) => (n === 1 ? '1 seat' : `${n} seats`),
    seatsFor: (name: string, plusOnes: number) => (plusOnes > 0 ? `${name} + ${plusOnes}` : name),
  },
  hostPage: {
    title: (name: string) => `Events by ${name}`,
    upcoming: 'Upcoming',
    past: 'Past events',
    emptyTitle: 'No events right now',
    emptyBody: 'Nothing is scheduled yet. Check back soon.',
    noUpcoming: 'Nothing coming up right now.',
  },
} as const;

export type Unit = 'd' | 'h' | 'm' | 's';

/** US-3: what the RSVP button may do right now. Order matters: cancelled beats everything. */
export type Availability =
  | {kind: 'open'; remaining: number | null}
  | {kind: 'waitlist'}
  | {kind: 'full'}
  | {kind: 'closed'}
  | {kind: 'ended'}
  | {kind: 'cancelled'};

export function availabilityOf(
  rsvp: {status: 'published' | 'cancelled'; closed: boolean; seatsLeft: number | null; waitlistEnabled: boolean},
  endAt: string,
  now = new Date()
): Availability {
  if (rsvp.status === 'cancelled') return {kind: 'cancelled'};
  if (now >= new Date(endAt)) return {kind: 'ended'};
  if (rsvp.closed) return {kind: 'closed'};
  if (rsvp.seatsLeft !== null && rsvp.seatsLeft <= 0) return rsvp.waitlistEnabled ? {kind: 'waitlist'} : {kind: 'full'};
  return {kind: 'open', remaining: rsvp.seatsLeft};
}

export const canRsvp = (a: Availability) => a.kind === 'open' || a.kind === 'waitlist';

export function formatPrice(priceCents: number, currency: string): string {
  if (priceCents === 0) return guestCopy.price.free;
  const amount = priceCents / 100;
  try {
    return new Intl.NumberFormat('en-US', {style: 'currency', currency, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2}).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** "Free", "$49" or "From $25" across all ticket types. */
export function priceSummary(tickets: Pick<RsvpTicketType, 'priceCents' | 'currency'>[]): string {
  const paid = tickets.filter(t => t.priceCents > 0);
  if (paid.length === 0) return guestCopy.price.free;
  const cheapest = tickets.reduce((a, b) => (b.priceCents < a.priceCents ? b : a));
  const label = formatPrice(cheapest.priceCents, cheapest.currency);
  return tickets.length > 1 ? guestCopy.price.from(label) : label;
}

/** The CTA button label for each state (US-3). */
export function ctaLabel(
  a: Availability,
  o: {approvalRequired: boolean; hasTickets: boolean; capacityLimited: boolean}
): string {
  switch (a.kind) {
    case 'open':
      if (o.approvalRequired) return guestCopy.cta.request;
      return !o.hasTickets && !o.capacityLimited ? guestCopy.cta.rsvpFree : guestCopy.cta.rsvp;
    case 'waitlist':
      return guestCopy.cta.waitlist;
    case 'full':
      return guestCopy.cta.full;
    case 'closed':
      return guestCopy.cta.closed;
    case 'ended':
      return guestCopy.cta.ended;
    case 'cancelled':
      return guestCopy.cta.cancelled;
  }
}

export function ctaNote(a: Availability, approvalRequired: boolean): string {
  switch (a.kind) {
    case 'open': {
      const bits: string[] = [];
      if (a.remaining !== null) bits.push(guestCopy.cta.seatsLeft(a.remaining));
      if (approvalRequired) bits.push(guestCopy.cta.approvalNote);
      return bits.join(' · ');
    }
    case 'waitlist':
      return guestCopy.cta.waitlistNote;
    case 'full':
      return guestCopy.cta.noWaitlistNote;
    case 'closed':
      return guestCopy.cta.closedNote;
    case 'ended':
      return guestCopy.cta.endedNote;
    case 'cancelled':
      return guestCopy.cancelledBanner.title;
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Days, hours, minutes (and seconds in the final hour) of a countdown. */
export function countdownParts(ms: number, withSeconds: boolean): Array<[number, Unit]> {
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  const s = Math.floor((ms % MINUTE) / SECOND);
  const out: Array<[number, Unit]> = [];
  if (d > 0) out.push([d, 'd']);
  if (d > 0 || h > 0) out.push([h, 'h']);
  out.push([m, 'm']);
  if (withSeconds && d === 0 && h === 0) out.push([s, 's']);
  return out;
}

/** "Tue 27 Oct, 18:30" in `timeZone`. */
export function formatShortWhen(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone}).format(new Date(iso));
  } catch {
    return '';
  }
}

export function formatClock(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit', timeZone}).format(new Date(iso));
  } catch {
    return '';
  }
}

/** "Tue 27 Oct 2026" in `timeZone`. */
export function formatDay(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone}).format(new Date(iso));
  } catch {
    return '';
  }
}

/** "18:30–20:00 GMT+1" in `timeZone`. */
export function formatRange(startIso: string, endIso: string | undefined, timeZone?: string): string {
  try {
    const zone = new Intl.DateTimeFormat('en-GB', {timeZoneName: 'short', timeZone}).formatToParts(new Date(startIso)).find(p => p.type === 'timeZoneName')?.value ?? '';
    return `${formatClock(startIso, timeZone)}${endIso ? `–${formatClock(endIso, timeZone)}` : ''} ${zone}`.trim();
  } catch {
    return '';
  }
}

/** Paragraphs of a plain-text description. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);
}

/** Strings only the route containers need (port of `features/guest-routes/copy.ts`). */
export const routeCopy = {
  inviteIncomplete: {
    poster: ['Invite', 'incomplete'],
    body: "This invite link doesn't open an event any more. Open it again from the invite email, or ask the host to resend it.",
    action: 'Go to the start',
  },
  rsvpNotFound: {
    poster: ['Link', 'not found'],
    body: "This RSVP link doesn't work any more. It may be mistyped, or the RSVP was removed. Check your latest confirmation email.",
    action: 'Go to the start',
  },
  loadFailed: {
    poster: ['Not', 'loading'],
    body: "We couldn't load this page. Check your connection and try again.",
    action: 'Try again',
  },
  hostNotFound: {
    poster: ['Host', 'not found'],
    body: "This link doesn't match a host. It may be mistyped or out of date.",
    action: 'Go to the start',
  },
  checkEmail: {title: 'Check your email', body: 'Check your email for a link to change your RSVP.'},
} as const;

/** The icons `src/components/GIcon.astro` can draw. */
export type GIconName =
  | 'monitor-play'
  | 'map-pin'
  | 'lock'
  | 'link'
  | 'ticket'
  | 'calendar-days'
  | 'calendar-plus'
  | 'calendar-x'
  | 'timer'
  | 'arrow-up-right'
  | 'arrow-right'
  | 'circle-slash'
  | 'check'
  | 'minus'
  | 'x'
  | 'external-link'
  | 'download'
  | 'chart'
  | 'clock'
  | 'credit-card'
  | 'hand'
  | 'list-ordered'
  | 'chevron-down'
  | 'copy';
