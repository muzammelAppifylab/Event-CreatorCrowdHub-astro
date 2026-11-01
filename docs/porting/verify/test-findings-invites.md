# Test findings: invites and messages routes

Tests: `tests/integration/ported-invites-routes.test.ts` (15) and `tests/integration/ported-messages-routes.test.ts` (25). All pass against real Postgres. No bugs found in `admin-invites.ts` or `admin-messages.ts`, so no `it.todo` or skips.

## Environment findings (not route bugs)

1. `src/server/auth-settings.ts:16` sets `requireEmailVerification: false`. `tests/integration/support/harness.ts:240` (`signedIn`) expects register to answer 202, but with this setting it answers 201. Every existing integration suite that signs in (for example `tests/integration/events-admin.test.ts`) fails in `beforeEach`. Expected: the fixtures and settings agree. Actual: 7 of 7 failures there. My tests work around it by mounting `authRoutes({...authSettings, requireEmailVerification: true})` on their own local app.
2. `prisma/schema.prisma` (uncommitted change) added `rsvp_questions.sort_order`, but the test database has no such column. `GET`/`POST /admin-events` then returns 500 (`admin-events.ts:301`, `db.rsvpQuestion.findMany`). My tests insert events directly with `db.event.create` instead of using the admin-events API.
3. The shared `ccd_test` database is reset by every integration file, so concurrent runs by several agents collide with random 500s and 409s. I ran these files against their own copy: `postgres://test:test@localhost:5441/ccd_test_invites` (created with `CREATE DATABASE ccd_test_invites TEMPLATE ccd_test`).

## Behaviour notes (as designed, covered by tests)

- Errors from `problem()` carry the code in `error`, and the text in `message`. The 409 count-mismatch text is in `json.message`.
- `POST /invites` accepts exactly 200 addresses and answers 422 for 201.
- A broadcast to exactly 500 guests succeeds and one to 501 gets 422, so the 500 cap is inclusive.
