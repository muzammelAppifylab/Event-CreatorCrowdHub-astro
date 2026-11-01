/**
 * Automatic email schedule (PRD US-20, §13 `runDueJobs()`). Pure: the
 * scheduler loads rules, the event, its RSVPs and existing deliveries, asks
 * which (rsvp, rule) pairs are due, then inserts MessageDelivery rows. The
 * unique (rsvpId, reminderRuleId) index makes a retried run safe; skipping
 * known deliveries here just avoids the wasted work.
 *
 * Send times are absolute: "24h before" means 1440 real minutes before the
 * start instant, so the DST change never shifts a reminder by an hour.
 *
 * The cron runs every 5 minutes, so a rule counts as due up to `windowMinutes`
 * before its send time; otherwise a "1h before" email could go out at 55m.
 * A missed run is caught up later, but never past the point where the email
 * stops making sense (a pre-start reminder after the event started or once a
 * later reminder is due, "we're live" after it ended, a thank-you days later).
 * So after an outage a guest gets the "1h" email, not "24h" and "1h" together.
 */
import { addMinutes } from "./time"

export type ReminderKind = "confirmation" | "reminder" | "live_now" | "thank_you"
export type EventFormat = "in_person" | "online" | "hybrid"
export type EventStatus = "draft" | "published" | "cancelled"
export type RsvpStatus = "pending" | "confirmed" | "waitlisted" | "declined" | "cancelled" | "awaiting_payment"

export interface ReminderRule {
  id: string
  kind: ReminderKind
  /** Negative = before start. For thank_you, minutes after the end. */
  offsetMinutes: number
  enabled: boolean
}

export interface ReminderEvent {
  startAt: Date
  endAt: Date
  format: EventFormat
  status: EventStatus
}

export interface ReminderRsvp {
  id: string
  status: RsvpStatus
  createdAt: Date
  /**
   * When the guest became confirmed (promotion, approval, payment). Falls
   * back to createdAt. Without it, a guest promoted from the waitlist 2h
   * before the start would still get the "24h before" email.
   */
  confirmedAt?: Date | null
}

export interface DueReminder {
  rsvpId: string
  ruleId: string
  sendAt: Date
}

export interface DueRemindersInput {
  rules: ReminderRule[]
  event: ReminderEvent
  rsvps: ReminderRsvp[]
  /** Keys from `deliveryKey(rsvpId, ruleId)` already in message_deliveries. */
  delivered: ReadonlySet<string>
  now: Date
  /** Scheduler interval: rules due within this many minutes are sent now. */
  windowMinutes?: number
  /** How long after the send time a thank-you may still go out. */
  thankYouMaxLateMinutes?: number
}

export const DEFAULT_REMINDER_WINDOW_MINUTES = 5
export const DEFAULT_THANK_YOU_MAX_LATE_MINUTES = 48 * 60

export function deliveryKey(rsvpId: string, ruleId: string): string {
  return `${rsvpId}:${ruleId}`
}

/**
 * When a rule fires for this event. Null for confirmation (sent by the RSVP
 * handler, not the scheduler) and for "we're live" at in-person events.
 */
export function sendTimeFor(rule: ReminderRule, event: ReminderEvent): Date | null {
  switch (rule.kind) {
    case "confirmation":
      return null
    case "reminder":
      return addMinutes(event.startAt, rule.offsetMinutes)
    case "live_now":
      return event.format === "in_person" ? null : addMinutes(event.startAt, rule.offsetMinutes)
    case "thank_you":
      // Always after the end, whatever sign the creator typed.
      return addMinutes(event.endAt, Math.abs(rule.offsetMinutes))
  }
}

/** Latest moment the email is still worth sending. */
function deadlineFor(rule: ReminderRule, event: ReminderEvent, sendAt: Date, thankYouMaxLate: number): Date {
  if (rule.kind === "reminder") return event.startAt
  if (rule.kind === "live_now") return event.endAt
  return addMinutes(sendAt, thankYouMaxLate)
}

/** A later enabled reminder is already due, so this earlier one is stale. */
function isSuperseded(rule: ReminderRule, sendAt: Date, rules: ReminderRule[], event: ReminderEvent, horizon: Date): boolean {
  return rules.some((other) => {
    if (other.id === rule.id || !other.enabled || other.kind !== "reminder") return false
    const otherAt = sendTimeFor(other, event)
    return otherAt !== null && otherAt > sendAt && otherAt <= horizon
  })
}

export function dueReminders(input: DueRemindersInput): DueReminder[] {
  const { event, now, delivered } = input
  if (event.status !== "published") return []

  const window = input.windowMinutes ?? DEFAULT_REMINDER_WINDOW_MINUTES
  const thankYouMaxLate = input.thankYouMaxLateMinutes ?? DEFAULT_THANK_YOU_MAX_LATE_MINUTES
  const horizon = addMinutes(now, window)
  const due: DueReminder[] = []

  for (const rule of input.rules) {
    if (!rule.enabled) continue
    const sendAt = sendTimeFor(rule, event)
    if (!sendAt || sendAt > horizon) continue
    // Pre-start reminders must also precede the start, even with a positive offset.
    if (now >= deadlineFor(rule, event, sendAt, thankYouMaxLate)) continue
    if (rule.kind === "reminder" && isSuperseded(rule, sendAt, input.rules, event, horizon)) continue

    for (const rsvp of input.rsvps) {
      if (rsvp.status !== "confirmed") continue
      // US-20: a rule whose time had already passed when the guest joined is skipped.
      if (sendAt <= (rsvp.confirmedAt ?? rsvp.createdAt)) continue
      if (delivered.has(deliveryKey(rsvp.id, rule.id))) continue
      due.push({ rsvpId: rsvp.id, ruleId: rule.id, sendAt })
    }
  }
  return due
}

/**
 * Rules a new event starts with when the host has not saved any defaults (PRD US-20): a
 * confirmation, reminders 24h and 1h before, "we're live" and a thank-you. The reminders mention
 * the live poll link ({{poll.join_url}}, which carries the poll code).
 */
export const STARTER_REMINDER_RULES: ReadonlyArray<{
  kind: ReminderKind
  offsetMinutes: number
  enabled: boolean
  subject: string
  body: string
}> = [
  {
    kind: "confirmation",
    offsetMinutes: 0,
    enabled: true,
    subject: "You're in: {{event.title}}",
    body: "Hi {{guest.first_name}},\n\nThanks for your RSVP. We've saved your place for {{event.start_local}}.",
  },
  {
    kind: "reminder",
    offsetMinutes: -24 * 60,
    enabled: true,
    subject: "Tomorrow: {{event.title}}",
    body: "Hi {{guest.first_name}},\n\nA quick reminder that {{event.title}} starts {{event.start_local}}.\n\nTaking part in the live poll? Join with this link when we start: {{poll.join_url}}\n\nCan't make it any more? Update your RSVP: {{rsvp.manage_url}}",
  },
  {
    kind: "reminder",
    offsetMinutes: -60,
    enabled: true,
    subject: "Starting in 1 hour: {{event.title}}",
    body: "Hi {{guest.first_name}},\n\n{{event.title}} starts at {{event.start_local}}. Join here: {{event.join_url}}\n\nLive poll link: {{poll.join_url}}",
  },
  {
    kind: "live_now",
    offsetMinutes: 0,
    enabled: true,
    subject: "We're live: {{event.title}}",
    body: "Hi {{guest.first_name}},\n\nWe're starting now. Join here: {{event.join_url}}\n\nLive poll: {{poll.join_url}}",
  },
  {
    kind: "thank_you",
    offsetMinutes: 120,
    enabled: true,
    subject: "Thanks for coming to {{event.title}}",
    body: "Hi {{guest.first_name}},\n\nThank you for joining us. We'd love your feedback.",
  },
]
