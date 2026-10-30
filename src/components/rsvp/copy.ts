import type {GIconName} from '../../lib/guest-format';
import type {RsvpResponse, RsvpStatus} from '../../lib/rsvp-types';

export interface StatusCopy {
  title: string;
  body: string;
  /** The quiet banner's icon (the "You're in" band has none). */
  icon: GIconName;
  /** The soft status pill: its word always carries the meaning. */
  badge: {label: string; tone: 'going-soft' | 'maybe-soft' | 'no-soft' | 'waitlist-soft' | 'outline'};
  /** `true` for a confirmed Going guest: the one mint "You're in" moment. */
  youreIn: boolean;
}

export interface StatusContext {
  /** The host's name ("Thanks for letting them know"). */
  host: string;
  email: string;
  waitlistPosition: number | null;
  /** The event sells paid tickets (changes the waitlist sentence). */
  paid: boolean;
}

/**
 * The guest-facing headline for an RSVP (confirmation + manage page): the copy of the original app's
 * `guestCopy.confirmation` and `StatusBanner`. A confirmed RSVP that is not Going is a reply, not a seat.
 */
export function statusCopy(status: RsvpStatus, response: RsvpResponse, ctx: StatusContext): StatusCopy {
  if (status === 'confirmed' && response === 'going') {
    return {title: 'You’re in', body: '', icon: 'check', badge: {label: 'Confirmed', tone: 'going-soft'}, youreIn: true};
  }
  if (status === 'confirmed' && response === 'maybe') {
    return {
      title: 'Marked as maybe',
      body: 'The host knows you might come. Change it to Going any time from your manage link.',
      icon: 'minus',
      badge: {label: 'Maybe', tone: 'maybe-soft'},
      youreIn: false,
    };
  }
  if (status === 'confirmed' && response === 'not_going') {
    return {
      title: 'Thanks for letting them know',
      body: `${ctx.host} knows you can't make it. Changed your mind? Update your RSVP below.`,
      icon: 'hand',
      badge: {label: 'Can’t go', tone: 'no-soft'},
      youreIn: false,
    };
  }
  switch (status) {
    case 'pending':
      return {
        title: 'Request received',
        body: `The host reviews every request. We'll email ${ctx.email} as soon as they decide.`,
        icon: 'clock',
        badge: {label: 'Pending', tone: 'maybe-soft'},
        youreIn: false,
      };
    case 'waitlisted':
      return {
        title: ctx.waitlistPosition ? `You're #${ctx.waitlistPosition} on the waitlist` : "You're on the waitlist",
        body: ctx.paid
          ? "If a seat opens up, we'll email you a link to claim it. You'll have 24 hours to pay."
          : "If a seat opens up, you'll get it automatically and we'll email you.",
        icon: 'list-ordered',
        badge: {label: 'Waitlisted', tone: 'waitlist-soft'},
        youreIn: false,
      };
    case 'awaiting_payment':
      return {
        title: 'Finish paying to hold your seat',
        body: 'Your seat is held for a short while. Complete checkout to confirm it.',
        icon: 'credit-card',
        badge: {label: 'Awaiting payment', tone: 'maybe-soft'},
        youreIn: false,
      };
    case 'declined':
      return {
        title: "The host couldn't fit you in",
        body: "Your request wasn't approved this time. The host may run this event again.",
        icon: 'x',
        badge: {label: 'Declined', tone: 'no-soft'},
        youreIn: false,
      };
    case 'cancelled':
    default:
      return {
        title: 'Your RSVP is cancelled',
        body: 'Your seat has been released. You can RSVP again while spaces remain.',
        icon: 'circle-slash',
        badge: {label: 'Cancelled', tone: 'outline'},
        youreIn: false,
      };
  }
}

/** Status words for the manage summary (StatusBadge). */
export const statusBadge: Record<RsvpStatus, {label: string; tone: StatusCopy['badge']['tone']}> = {
  confirmed: {label: 'Confirmed', tone: 'going-soft'},
  pending: {label: 'Pending', tone: 'maybe-soft'},
  awaiting_payment: {label: 'Awaiting payment', tone: 'maybe-soft'},
  waitlisted: {label: 'Waitlisted', tone: 'waitlist-soft'},
  declined: {label: 'Declined', tone: 'no-soft'},
  cancelled: {label: 'Cancelled', tone: 'outline'},
};

export const responseLabel: Record<RsvpResponse, string> = {going: 'Going', maybe: 'Maybe', not_going: 'Can’t go'};
