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
 *                                     In local development ONLY (`import.meta.env.DEV`), the links in the text
 *                                     body are also logged, prefixed `[dev email]`.
 *
 * Never throws and never blocks the caller's answer: call it from `background(c, …)`.
 * Returns whether the mail was handed to a provider.
 */
export interface EventEmail {
  to: string;
  content: EmailContent;
  /** Display name of the sender (the creator's brand); the address stays the site's. */
  fromName?: string | null;
  replyTo?: string | null;
}

/** A provider is configured: only then is it safe to rotate a guest's manage link (the new one must reach them). */
export const canSendEventEmail = () => Boolean(config.ownerSecret('RESEND_API_KEY') && config.ownerSecret('EVENT_EMAIL_FROM'));

/** Local development only (Vite dev server, never a build, never the live site). */
const isLocalDev = () => import.meta.env.DEV === true && !config.production;

/** Dev-only: the links found in an email's text (manage/invite/consent/claim), so a developer can open them. */
export function devEmailLinks(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s<>"')]+/g) ?? [])];
}

const RESEND_ORIGIN = 'https://api.resend.com/emails';

export async function sendEventEmail(email: EventEmail): Promise<boolean> {
  const key = config.ownerSecret('RESEND_API_KEY');
  const from = config.ownerSecret('EVENT_EMAIL_FROM');
  if (!key || !from) {
    console.info(`[event email] no mail provider configured, not sent: "${email.content.subject}" to *@${email.to.split('@')[1] ?? '?'}`);
    if (isLocalDev()) for (const link of devEmailLinks(email.content.text ?? '')) console.info(`[dev email] ${link}`);
    return false;
  }
  try {
    const address = from.includes('<') ? (from.match(/<([^>]+)>/)?.[1] ?? from) : from;
    const display = (email.fromName ?? '').replace(/[<>"\r\n]/g, '').trim();
    const res = await fetch(RESEND_ORIGIN, {
      method: 'POST',
      headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'},
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: display ? `${display} <${address}>` : from,
        to: [email.to],
        subject: email.content.subject,
        html: email.content.html,
        text: email.content.text,
        ...(email.replyTo ? {reply_to: email.replyTo} : {}),
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
    if (!res.ok) console.warn(`[event email] provider answered ${res.status}`);
    return res.ok;
  } catch (err) {
    console.warn(`[event email] send failed: ${(err as Error).name}`);
    return false;
  }
}
