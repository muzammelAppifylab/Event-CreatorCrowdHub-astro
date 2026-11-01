/**
 * Public "Who's going" shaping (pure). Port of CreatorCrowdHub `server/rsvp/public-event.ts`:
 * FIRST NAME + initials only, bounded, never an email. The host's "Show guest list" switch is the
 * consent (the original has no per-guest flag); the caller only asks for names when it is on.
 */
export const MAX_PUBLIC_ATTENDEES = 12;

export interface PublicAttendee {
  name: string;
  initials: string;
}

export function attendeeFrom(fullName: string): PublicAttendee | null {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first || first.includes('@')) return null;
  const initials = parts
    .slice(0, 2)
    .map(p => Array.from(p)[0]!.toUpperCase())
    .join('');
  return {name: first, initials};
}

export function shapeAttendees(names: readonly string[], limit = MAX_PUBLIC_ATTENDEES): PublicAttendee[] {
  const out: PublicAttendee[] = [];
  for (const n of names) {
    if (out.length >= limit) break;
    const a = attendeeFrom(n);
    if (a) out.push(a);
  }
  return out;
}
