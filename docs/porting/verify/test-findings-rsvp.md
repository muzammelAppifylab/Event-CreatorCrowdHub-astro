# RSVP ported tests: findings

Files: tests/ported-rsvp-pure.test.ts (28), tests/integration/ported-rsvp-routes.test.ts (47, run against private DB ccd_rsvp). All pass; no confirmed bugs.

Behaviours worth knowing (not bugs, tests pin them):
- src/server/routes/rsvp.ts `mailManageLink` (~L755): with no mail provider the manage token is NOT rotated, so manage-link rotation and the 3/hour cap cannot be tested in integration; only the "keep working link" path is covered.
- PATCH on an event that has ended but is inside the 90-day write window answers 409 rsvps_closed (place() refuses), while GET/.ics still work; `canEdit` is true in that window although the edit is refused (src/server/routes/rsvp.ts, GET /manage canEdit vs place). Minor UX mismatch.
- tests/integration/support/events-fixtures.ts `userWith` -> harness `signedIn` expects register 202; when auth settings do not require email verification register answers 201 and every fixture-based test fails (e.g. tests/integration/events-guest.test.ts). My file uses a local sign-in helper tolerant of both.
