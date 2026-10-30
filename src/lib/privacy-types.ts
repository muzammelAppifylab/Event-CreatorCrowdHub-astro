/** Shapes of the `/site-api/privacy/*` answers, shared by the routes and the `/privacy/*` pages. */

export interface PrivacyEventBrief {
  title: string;
  slug: string;
  startAt: string;
  endAt: string;
  timezone: string;
}

/** `GET /privacy/consent/:token` and `GET /privacy/unsubscribe/:token`. */
export interface ConsentState {
  /** `pending`: waiting for the click. `confirmed`: marketing emails are on. `off`: they are not (never asked, or withdrawn). */
  state: 'pending' | 'confirmed' | 'off';
  event: PrivacyEventBrief;
}

/** `GET /privacy/guest/:token`. */
export interface GuestPrivacySummary {
  name: string;
  email: string;
  status: string;
  marketingConsent: boolean;
  consentConfirmed: boolean;
  event: PrivacyEventBrief;
  /** The export is available until this moment (ISO). */
  exportUntil: string;
  /** False while the RSVP is in a paid checkout: erasing is refused until it ends. */
  canErase: boolean;
}

export type GuestExportFormat = 'creator-crowd-hub.guest-export.v1';
