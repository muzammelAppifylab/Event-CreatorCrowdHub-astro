# Guests port: test findings

Tests: tests/ported-guests-routes.test.ts, tests/integration/ported-guests-routes.test.ts (real Postgres).

## 1. Guest search treats `%` and `_` as wildcards
- src/server/routes/admin-guests.ts:93-112 (`guestWhere`, Prisma `contains` with `mode: 'insensitive'`).
- Expected: `q=%` matches only guests whose name/email contains a literal percent sign (the contacts search escapes via `likePattern`).
- Actual: `q=%` returns every guest of the event. Harmless data-wise (same event, same admin), but inconsistent with contacts search. Test is `it.skip` in the integration file.

## 2. Local dev edit breaks the integration sign-in harness
- src/server/auth-settings.ts:16-17 sets `requireEmailVerification: false` ("LOCAL DEV ONLY").
- Expected: register answers 202 and the harness's `signedIn` verifies by email. Actual: 201, so every integration test using `signedIn`/`userWith` (events-admin, auth, ...) fails. My test app overrides the setting to true.
- Also, prisma/migrations/20261031090000_sort_order (uncommitted) was not applied to the shared ccd_test DB, so event creation 500s there. I used a private DB `ccd_guests` (copy of ccd_test plus the two pending migrations).
