# Test findings: events admin, tickets, settings

Tests: `tests/ported-events-schemas.test.ts` (pure), `tests/integration/ported-events-routes.test.ts` (real Postgres; needs `requireEmailVerification: true`, which the test app forces because `src/server/auth-settings.ts` currently sets it false for local dev).

## Bugs (both FIXED; tests un-skipped)

Fixed: `parseReminderRules` no longer keeps out-of-limit rules (write still 422s, reads drop them); `parseEventFields(raw, false)` allows an omitted `timezone` (blank/null/invalid still 422) and `POST /admin-events` falls back to `EventSettings.defaultTimezone`, else `UTC`. The portal editor already prefills from `/event-settings`.

1. `src/server/routes/event-settings.ts` `toDto` (and `settingsFor` in `src/server/routes/admin-events.ts`): the comment says rules failing today's checks are left out, but `parseReminderRules` (`src/lib/event-schemas.ts:494`) still pushes a rule whose offset is outside the per-kind limits (it only calls `c.fail`). Expected: `defaultReminderRules: []` for a hand-edited row with `{kind:'reminder', offsetMinutes: 99999}`. Actual: the rule is returned (and copied into new events).
2. `src/lib/event-schemas.ts:~362` `parseEventFields(raw, false)` makes `timezone` mandatory, so `POST /admin-events` without `timezone` answers 422 "Choose a timezone." and the route's `settings.defaultTimezone` inheritance (`admin-events.ts` POST) is unreachable. Source: new events inherit the workspace timezone.

## Behaviour differences (asserted as the new behaviour)

- URL fields accept `https:` only (source also allowed `http:`).
- Validation is staged: field errors first, cross-field (end after start, venue, join URL) only once all fields parse; source returned both at once.
- Admin event DTO counts are `{confirmed, waitlisted, pending}` (source: going, maybe, waitlisted, pending, seatsTaken); question DTO has no `sortOrder`.
- Duplicate with an invalid body answers 422 before the 404 for an unknown id.
- No workspace tenancy, so the cross-workspace 404 / slug-sharing cases became role cases (403 staff, 401 anonymous).

## Not ported in the new code (`it.todo`)

- `parseMajorToCents`, `centsToInput`, `currencySymbol` (source `tickets/money.ts`); `setReminderOffsets`, `setKindEnabled`, `offsetLabel` (source `DefaultRemindersEditor`); frontend `splitFieldErrors`, `dateKeyToDate`.
- Ticket routes: `POST /ticket-types/currency` (bulk currency change, lock once orders exist), `stripe_not_connected` gate, delete blocked by orders (new blocks on any RSVP using the type), Stripe integration settings.
