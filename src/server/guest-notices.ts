import type {GuestNotice, MailEvent} from './guest-mail';
import {enqueueGuestNotices, kickGuestEmails, noticeKey, type NoticeRow} from './jobs/outbox';
import type {Db} from './jobs/shared';

/**
 * Host notices (a guest approved, declined or promoted from the dashboard) go through the guest
 * email outbox like every other guest email (audit M-21): the route only queues them. The content is
 * `noticeContent` in ./guest-mail, rendered by the drain (`sendNoticeRows` in ./jobs/outbox-drain).
 */

/**
 * The outbox rows for a host action's notices (pure). Approvals and promotions that seated a guest
 * are `notice_confirmation`, declines `notice_declined` (keyed per guest and status reached); a paid
 * waitlist offer is the outbox's own `waitlist_offer`, keyed like the scheduler's (`waitlist_offer-<rsvp>-<expiry ms>`),
 * so the guest gets one claim link however the seat was freed.
 */
export function noticeRows(notices: GuestNotice[]): NoticeRow[] {
  return notices.map((notice): NoticeRow => {
    const rsvpId = notice.guest.id;
    if (notice.kind === 'waitlist_offer') return {kind: 'waitlist_offer', rsvpId, key: `waitlist_offer-${rsvpId}-${notice.claimExpiresAt.getTime()}`};
    const kind = notice.kind === 'declined' ? ('notice_declined' as const) : ('notice_confirmation' as const);
    return {kind, rsvpId, key: noticeKey(kind, rsvpId, notice.guest.status)};
  });
}

/**
 * Queues the notices in the guest email outbox (ONE insert), then asks for a drain: the request
 * never sends mail itself (audit M-21). Call it after the action's transaction committed. Returns
 * how many emails were queued (a notice whose key is already queued is not counted). Unsubscribed
 * guests still get notices: they are about their own RSVP, and unsubscribe covers broadcasts only
 * (`enqueueGuestNotices`). Never throws: the host's action
 * already happened, a lost notice is only logged (ids never, counts only).
 */
export async function notifyGuests(db: Db, event: Pick<MailEvent, 'status'>, notices: GuestNotice[]): Promise<number> {
  if (!notices.length || event.status === 'cancelled') return 0;
  let queued = 0;
  try {
    queued = await enqueueGuestNotices(db, noticeRows(notices));
  } catch (error) {
    console.error(`[guests] ${notices.length} notice email(s) not queued: ${error instanceof Error ? error.message.slice(0, 160) : 'failed'}`);
    return 0;
  }
  if (queued > 0) await kickGuestEmails();
  return queued;
}
