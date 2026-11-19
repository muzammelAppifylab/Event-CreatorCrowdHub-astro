import {config} from '../platform/config';
import type {EmailContent} from '../emails/types';

/**
 * Event emails (confirmations, manage links, waitlist offers, reminders…): the platform's email
 * relay (`sendSiteEmail`) only carries the fixed ACCOUNT kinds with the platform's own template, so
 * it cannot send these. Instead:
 *
 *   - `config.ownerSecret('RESEND_API_KEY')` set  → sent through Resend (https://api.resend.com)
 *     from `config.ownerSecret('EVENT_EMAIL_FROM')` (e.g. `Studio <events@yourdomain.com>`).
 *   - otherwise                                   → NOT sent: the subject and recipient domain are
 *     logged (never the body, which carries manage links) so development still works.
 *                                     In local development ONLY (`import.meta.env.DEV` and `config.localDev`), the links in the text
 *                                     body are also logged, prefixed `[dev email]`.
 *
 * Never throws. Guest emails go through the outbox (src/server/jobs/outbox.ts), never one request per guest.
 * Returns whether the mail was handed to a provider.
 */
export interface EventEmail {
  to: string;
  content: EmailContent;
  /** Display name of the sender (the creator's brand); the address stays the site's. */
  fromName?: string | null;
  replyTo?: string | null;
  /** Sent as the provider's Idempotency-Key: the same key on a retry is sent once. Stable per email (an outbox row, a delivery row). */
  idempotencyKey?: string;
}

/** A provider is configured: only then is it safe to rotate a guest's manage link (the new one must reach them). */
export const canSendEventEmail = () => Boolean(config.ownerSecret('RESEND_API_KEY') && config.ownerSecret('EVENT_EMAIL_FROM'));

/**
 * Local development only (Vite dev server, never a build, never the live site), and only in the
 * platform's local development mode (`config.localDev`: no Site Key, not the Preview).
 */
const isLocalDev = () => import.meta.env.DEV === true && !config.production && config.localDev !== false;

/** Dev-only: the links found in an email's text (manage/invite/consent/claim), so a developer can open them. */
export function devEmailLinks(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s<>"')]+/g) ?? [])];
}

const RESEND_ORIGIN = 'https://api.resend.com/emails';

/**
 * What became of one send:
 *   sent          the provider accepted it (a 409 on a repeated Idempotency-Key means an earlier try was accepted)
 *   no_provider   no provider configured: logged, not sent; trying again cannot help until the owner adds one
 *   rate_limited  the provider said 429: try again later, and stop sending for now
 *   rejected      the provider refused this email (4xx: a bad address, a bad payload); trying again cannot help
 *   failed        a timeout, a network error or a 5xx: try again later
 */
export type SendOutcome = 'sent' | 'no_provider' | 'rate_limited' | 'rejected' | 'failed';

/**
 * The sender's display name as an RFC 5322 quoted-string (audit L-3): a comma, colon or semicolon
 * in a brand name ("Smith, Jones & Co") would otherwise split the From: header. Control characters
 * and angle brackets are dropped; backslashes and double quotes are escaped. Empty when there is no name.
 */
export function senderDisplayName(name: string | null | undefined): string {
  const clean = (name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 100);
  return clean ? `"${clean.replace(/["\\]/g, '\\$&')}"` : '';
}

/** Sends one event email and says what happened. Never throws. */
export async function deliverEventEmail(email: EventEmail): Promise<{outcome: SendOutcome; retryAfterSeconds?: number}> {
  const key = config.ownerSecret('RESEND_API_KEY');
  const from = config.ownerSecret('EVENT_EMAIL_FROM');
  if (!key || !from) {
    // L-13: never the subject (it carries guest names) nor the address.
    console.info('[event email] no mail provider configured, not sent.');
    if (isLocalDev()) for (const link of devEmailLinks(email.content.text ?? '')) console.info(`[dev email] ${link}`);
    return {outcome: 'no_provider'};
  }
  try {
    const address = from.includes('<') ? (from.match(/<([^>]+)>/)?.[1] ?? from) : from;
    const display = senderDisplayName(email.fromName);
    const idempotencyKey = (email.idempotencyKey ?? '').replace(/[^A-Za-z0-9:_.-]/g, '').slice(0, 256);
    const res = await fetch(RESEND_ORIGIN, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        // The same key on a retry makes the provider send once (it keeps keys for 24 hours).
        ...(idempotencyKey ? {'idempotency-key': idempotencyKey} : {}),
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: display ? `${display} <${address}>` : from,
        to: [email.to],
        subject: email.content.subject,
        html: email.content.html,
        text: email.content.text,
        ...(email.replyTo ? {reply_to: email.replyTo} : {}),
        // List-Unsubscribe (and -Post) from the template, when the email carries an unsubscribe link.
        ...(email.content.headers ? {headers: email.content.headers} : {}),
        ...(email.content.attachments?.length
          ? {
              attachments: email.content.attachments.map(a => ({
                filename: a.filename,
                content: btoa(unescape(encodeURIComponent(a.content))),
              })),
            }
          : {}),
      }),
    });
    if (res.ok) return {outcome: 'sent'};
    console.warn(`[event email] provider answered ${res.status}`);
    if (res.status === 409 && idempotencyKey) return {outcome: 'sent'};
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      return {outcome: 'rate_limited', ...(Number.isFinite(after) && after > 0 ? {retryAfterSeconds: Math.min(after, 3600)} : {})};
    }
    // A bad address or payload is this email's own problem; a bad key (401/403) is fixed by the owner, so it is retried.
    if (res.status === 400 || res.status === 422) return {outcome: 'rejected'};
    return {outcome: 'failed'};
  } catch (err) {
    console.warn(`[event email] send failed: ${(err as Error).name}`);
    return {outcome: 'failed'};
  }
}

/** Sends one event email. Returns whether the mail was handed to a provider. Never throws. */
export async function sendEventEmail(email: EventEmail): Promise<boolean> {
  return (await deliverEventEmail(email)).outcome === 'sent';
}
