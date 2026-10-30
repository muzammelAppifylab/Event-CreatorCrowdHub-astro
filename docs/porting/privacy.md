# Porting: guest privacy

Ported from CreatorCrowdHub (`server/privacy/*`, `rsvp/manage-token.ts`, `routes/consent.ts`, SECURITY.md M13/M17/M19).

## Mount (src/server/app.ts)

```ts
import {privacyRoutes} from './routes/privacy';
// after `.use(csrf)`, chained with the other routes:
  .route('/privacy', privacyRoutes)
```

The pages call the Site API with `app.request(...)` (no typed client needed). The routes use `withAuthCore` (database + `JWT_SECRET`) and register the `privacy` rate-limit kind themselves.

## Routes (all public, token in the path)

| Route | Does |
| --- | --- |
| `GET/POST /privacy/consent/:token` | double opt-in: GET shows state, POST (the button) confirms. Signed `consent` token, 30 days |
| `GET/POST /privacy/unsubscribe/:token` | withdraw marketing consent; token = RSVP manage token |
| `GET /privacy/guest/:token` | summary of what is held |
| `GET /privacy/guest/:token/export` | JSON download, field by field, 180 days after the event |
| `POST /privacy/guest/:token/erase` | body `{confirm: "erase"}`; anonymises the RSVP |

Manage tokens are stored as sha256 (`hashToken`) and found by hash; a bad, rotated or foreign token is always the same 404. Pages: `/privacy/`, `/privacy/consent/<t>/`, `/privacy/unsubscribe/<t>/`, `/privacy/guest/<t>/` (SSR, noindex, no-store, no-referrer).

## For the other slices

- Confirmation email: `consentUrl(origin, rsvpId, config.jwtSecret)` when `marketingConsent` and not yet confirmed; footer links `unsubscribeUrl(origin, rawManageToken)` and `guestPrivacyUrl(...)` (from `src/server/privacy.ts`). The mailer must send marketing only to `marketingConsent && consentConfirmedAt`.
- Erase sets the RSVP to `cancelled`; promoting the waitlist afterwards is the RSVP flow's job.

## Retention

Export links: 180 days after `endAt`. Unsubscribe and erase: no window. Guest data: anonymise `RETENTION_DAYS` (730) after the event. `expiredGuestIds(db, now)` + `eraseRsvp(db, id)` are ready for a daily background job (`background.json`); not wired here. Backups: restore then re-erase (see the source `docs/PRIVACY.md`).
