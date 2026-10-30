/**
 * Small time helpers shared by the reminder, waitlist and calendar rules.
 * Everything is stored and compared as absolute instants (UTC `Date`s); the
 * event timezone is only used to turn a creator's wall-clock input into an
 * instant and to format an instant for humans. Keeping that boundary here
 * means DST quirks live in one place instead of in every rule.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz"

const MS_PER_MINUTE = 60_000

/** Absolute offset: DST never changes how long "60 minutes" is. */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MS_PER_MINUTE)
}

export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_MINUTE
}

/**
 * Creator wall-clock input ("2026-10-25T01:30") in an IANA zone → instant.
 * On the autumn clock-change day the time exists twice; date-fns-tz resolves
 * it to the later occurrence (01:30 GMT = 01:30Z for Europe/London). On the
 * spring day a missing time (01:30 Europe/London) resolves using the pre-gap
 * offset (00:30Z). The editor should warn on both, but the rules here never
 * fail on them: everything downstream works on the resulting instant.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  return fromZonedTime(local, timeZone)
}

/** "Sun 25 Oct 2026, 01:30 GMT" style label for emails ({{event.start_local}}). */
export function formatInZone(date: Date, timeZone: string, pattern = "EEE d MMM yyyy, HH:mm zzz"): string {
  return formatInTimeZone(date, timeZone, pattern)
}

/** RFC 5545 / Google Calendar UTC form: 20261025T013000Z. */
export function toUtcBasic(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}
