import {appConfig} from '../../config/app.config';
import {deliveryKey, dueReminders, type ReminderRule} from '../../domain/reminders';
import {addMinutes} from '../../domain/time';
import {creatorEmail} from '../../emails';
import {claimDelivery, sendClaimed, type SendFn} from './deliveries';
import {type Db, loadGuestMail, PERMANENT_ERROR_PREFIX, STALE_CLAIM_MINUTES} from './shared';

/** Reminders go at most 14 days before the start, thank-yous at most 7 days after the end (+ late allowance). */
const LEAD_MINUTES = 14 * 24 * 60 + appConfig.reminderWindowMinutes;
const TAIL_MINUTES = 7 * 24 * 60 + appConfig.thankYouMaxLateMinutes;
const EVENT_LIMIT = 100;
const GUEST_PAGE = 500;

export interface ReminderRun {
  due: number;
  sent: number;
  failed: number;
  skipped: number;
  errors: string[];
}

/**
 * Reminders, "we're live" and thank-yous. `dueReminders` (pure) decides what is due; for each
 * (rsvp, rule) pair we CLAIM a message_deliveries row first (unique rsvp+rule: only one run
 * wins), then send, then mark it sent or failed. Running twice sends once; a failed send is
 * due again next run while the domain still says it is due; a crash between claim and send is
 * re-claimed after STALE_CLAIM_MINUTES. `budget` bounds the sends per run; the rest is due again.
 */
export async function runReminders(
  db: Db,
  now: Date,
  options: {send: SendFn; budget?: number; deadline?: number},
): Promise<ReminderRun> {
  const run: ReminderRun = {due: 0, sent: 0, failed: 0, skipped: 0, errors: []};
  let budget = options.budget ?? 500;
  const events = await db.event.findMany({
    where: {
      status: 'published',
      deletedAt: null,
      startAt: {lte: addMinutes(now, LEAD_MINUTES)},
      endAt: {gte: addMinutes(now, -TAIL_MINUTES)},
    },
    select: {id: true, startAt: true, endAt: true, format: true, status: true},
    orderBy: [{startAt: 'asc'}, {id: 'asc'}],
    take: EVENT_LIMIT,
  });
  const staleBefore = addMinutes(now, -STALE_CLAIM_MINUTES);

  for (const event of events) {
    const rules = await db.reminderRule.findMany({
      where: {eventId: event.id, enabled: true, kind: {not: 'confirmation'}},
      select: {id: true, kind: true, offsetMinutes: true, enabled: true, subject: true, body: true},
    });
    if (rules.length === 0) continue;
    const domainRules: ReminderRule[] = rules;
    const ruleById = new Map(rules.map(r => [r.id, r]));

    let after: string | undefined;
    for (;;) {
      if (budget <= 0 || (options.deadline !== undefined && Date.now() >= options.deadline)) return run;
      const guests = await db.rsvp.findMany({
        where: {eventId: event.id, status: 'confirmed', ...(after ? {id: {gt: after}} : {})},
        select: {id: true, status: true, createdAt: true, confirmedAt: true},
        orderBy: {id: 'asc'},
        take: GUEST_PAGE,
      });
      if (guests.length === 0) break;
      after = guests[guests.length - 1]!.id;

      // What this page of guests already has: sent, fresh claims, permanent failures.
      const known = await db.messageDelivery.findMany({
        where: {rsvpId: {in: guests.map(g => g.id)}, reminderRuleId: {in: rules.map(r => r.id)}},
        select: {rsvpId: true, reminderRuleId: true, status: true, error: true, sentAt: true},
      });
      const delivered = new Set<string>();
      for (const d of known) {
        if (!d.rsvpId || !d.reminderRuleId) continue;
        const final = d.status === 'sent' || (d.status === 'failed' && (d.error ?? '').startsWith(PERMANENT_ERROR_PREFIX));
        const freshClaim = d.status === 'queued' && d.sentAt !== null && d.sentAt > staleBefore;
        if (final || freshClaim) delivered.add(deliveryKey(d.rsvpId, d.reminderRuleId));
      }

      const due = dueReminders({
        rules: domainRules,
        event: {startAt: event.startAt, endAt: event.endAt, format: event.format, status: event.status},
        rsvps: guests,
        delivered,
        now,
        windowMinutes: appConfig.reminderWindowMinutes,
        thankYouMaxLateMinutes: appConfig.thankYouMaxLateMinutes,
      });
      run.due += due.length;

      for (const item of due) {
        if (budget <= 0) return run;
        budget -= 1;
        let deliveryId: string | null = null;
        // One guest's failure never stops the batch; its error lands on its own row.
        try {
          deliveryId = await claimDelivery(db, item.rsvpId, item.ruleId, now);
          if (!deliveryId) {
            run.skipped += 1;
            continue;
          }
          const mail = await loadGuestMail(db, item.rsvpId, now);
          const rule = ruleById.get(item.ruleId)!;
          if (!mail || rule.kind === 'confirmation') {
            // The guest or event vanished between the read and now: nothing to send, never retried.
            await db.messageDelivery.update({
              where: {id: deliveryId},
              data: {status: 'failed', error: `${PERMANENT_ERROR_PREFIX}guest or event is gone`},
            });
            run.skipped += 1;
            continue;
          }
          const content = creatorEmail(rule.kind, mail.data, {subject: rule.subject, body: rule.body});
          const result = await sendClaimed(
            db,
            deliveryId,
            options.send,
            {to: mail.to, content, fromName: mail.data.brand.senderName, replyTo: mail.replyTo},
            now,
          );
          if (result.status === 'sent') run.sent += 1;
          else {
            run.failed += 1;
            run.errors.push(`reminder ${item.ruleId}: ${result.error ?? 'failed'}`);
          }
        } catch (err) {
          run.failed += 1;
          run.errors.push(`reminder ${item.ruleId}: ${err instanceof Error ? err.message.slice(0, 200) : 'failed'}`);
          if (deliveryId) {
            await db.messageDelivery
              .update({where: {id: deliveryId}, data: {status: 'failed', error: 'The reminder could not be prepared.'}})
              .catch(() => undefined);
          }
        }
      }
      if (guests.length < GUEST_PAGE) break;
    }
  }
  return run;
}
