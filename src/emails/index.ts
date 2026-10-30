/**
 * Transactional email templates (PRD §13: templates live in /src/emails).
 * Each returns { subject, html, text, attachments? }. To change copy, edit the
 * template; to change the look, edit layout.ts.
 */
export type { CreatorCopy, EmailAttachment, EmailBrand, EmailContent, EmailData, EmailEventInfo, EmailGuestInfo } from "./types"
export {
  approvalPendingEmail,
  confirmationEmail,
  consentEmail,
  declinedEmail,
  eventCancelledEmail,
  holdExpiredEmail,
  icsAttachment,
  manageLinkEmail,
  waitlistOfferEmail,
} from "./transactional"
export { broadcastEmail, creatorEmail, liveNowEmail, reminderEmail, thankYouEmail, type CreatorEmailKind } from "./scheduled"
export { buttonColors, renderCreatorCopy } from "./layout"
export { mergeContextFor } from "./context"
