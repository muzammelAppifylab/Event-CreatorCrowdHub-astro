import type {RsvpResponse, RsvpStatus} from '../../lib/rsvp-types';

export interface StatusCopy {
  title: string;
  body: string;
  tone: 'ok' | 'neutral' | 'warn';
}

/** The guest-facing headline for an RSVP (confirmation + manage page). */
export function statusCopy(status: RsvpStatus, response: RsvpResponse, waitlistPosition: number | null): StatusCopy {
  switch (status) {
    case 'confirmed':
      return response === 'maybe'
        ? {title: 'You said maybe', body: 'No seat is held yet. Change your answer to Going when you know.', tone: 'neutral'}
        : {title: 'You’re going', body: 'Your seat is confirmed. We emailed you the details.', tone: 'ok'};
    case 'waitlisted':
      return {
        title: 'You’re on the waitlist',
        body: `${waitlistPosition ? `You’re number ${waitlistPosition} in line. ` : ''}We’ll email you the moment a seat opens up.`,
        tone: 'warn',
      };
    case 'pending':
      return {title: 'Waiting for the host’s approval', body: 'The host reviews each request. We’ll email you their decision.', tone: 'warn'};
    case 'awaiting_payment':
      return {title: 'Payment needed', body: 'Your seat is held while you pay. It is released if the payment does not complete.', tone: 'warn'};
    case 'declined':
      return response === 'not_going'
        ? {title: 'You can’t go', body: 'Thanks for letting the host know. You can change your answer below.', tone: 'neutral'}
        : {title: 'Request declined', body: 'The host could not take your request this time.', tone: 'neutral'};
    case 'cancelled':
      return {title: 'RSVP cancelled', body: 'Your seat has been released.', tone: 'neutral'};
  }
}
