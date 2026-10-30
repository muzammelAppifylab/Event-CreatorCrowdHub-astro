/**
 * Single source for product defaults (PRD §15). Change a number here, not in
 * a component.
 */
export const appConfig = {
  /** Default reminder offsets in minutes before start (24h, 1h). */
  defaultReminderOffsets: [-1440, -60],
  /** Max custom RSVP questions per event. */
  maxRsvpQuestions: 10,
  /** Max plus-ones a creator can allow per RSVP. */
  maxPlusOnes: 5,
  /** Live poll short-polling intervals (ms). */
  pollVoteIntervalMs: 3000,
  pollPresenterIntervalMs: 2000,
  pollIdleBackoffMs: 10000,
  pollIdleAfterMs: 5 * 60 * 1000,
  /** Paid checkout seat hold and waitlist claim windows (minutes). */
  checkoutHoldMinutes: 30,
  waitlistClaimMinutes: 24 * 60,
  /** Short text poll answers. */
  pollTextMaxLength: 140,
  pollTextAnswersShown: 20,
  pollRatingMin: 1,
  pollRatingMax: 5,
  /** Scheduler: a rule is due from this many minutes before its send time (cron runs every 5). */
  reminderWindowMinutes: 5,
  /** Drop a thank-you email that is later than this (minutes) after a missed run. */
  thankYouMaxLateMinutes: 2880,
} as const
