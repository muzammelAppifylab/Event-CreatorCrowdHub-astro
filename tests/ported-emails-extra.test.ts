import {describe, expect, it} from 'vitest';

import {
  approvalPendingEmail, broadcastEmail, confirmationEmail, consentEmail, eventCancelledEmail, liveNowEmail, reminderEmail,
  thankYouEmail, waitlistOfferEmail, type EmailData,
} from '../src/emails';
import {canSeeJoinLink} from '../src/emails/context';

const NOW = new Date('2026-10-20T12:00:00Z');

function data(o: {event?: Partial<EmailData['event']>; guest?: Partial<EmailData['guest']>; brand?: Partial<EmailData['brand']>} = {}): EmailData {
  return {
    now: NOW,
    brand: {senderName: 'Clara Coaching', replyToEmail: 'hello@clara.example', brandColor: null, ...o.brand},
    event: {
      title: 'Pricing Workshop', startAt: new Date('2026-11-01T18:00:00Z'), endAt: new Date('2026-11-01T20:00:00Z'), timezone: 'Europe/London',
      startLocal: 'Sun 1 Nov 2026, 18:00 GMT', format: 'online', joinUrl: 'https://zoom.example/j/123', pageUrl: 'https://events.example/e/pw',
      pollUrl: 'https://events.example/p/ABC234', ...o.event,
    },
    guest: {rsvpId: '11111111-1111-4111-8111-111111111111', name: 'Sam Rivera', response: 'going', status: 'confirmed', ticketCode: 'ab12cd34', manageUrl: 'https://events.example/r/tok123', ...o.guest},
  };
}

const copy = {subject: 'Hello {{guest.first_name}}', body: 'Join: {{event.join_url}}'};
const JOIN = 'zoom.example/j/123';

describe('join link never reaches a non-confirmed guest, on every template', () => {
  const blocked = [
    {status: 'waitlisted' as const}, {status: 'pending' as const}, {status: 'declined' as const}, {status: 'cancelled' as const},
    {response: 'maybe' as const}, {response: 'not_going' as const},
  ];
  for (const guest of blocked) {
    it(`withholds for ${JSON.stringify(guest)}`, () => {
      const d = data({guest});
      expect(canSeeJoinLink(d.guest)).toBe(false);
      for (const mail of [confirmationEmail(d), reminderEmail(d, copy), liveNowEmail(d, copy), thankYouEmail(d, copy), broadcastEmail(d, copy), approvalPendingEmail(d), waitlistOfferEmail(d, 'soon'), eventCancelledEmail(d, {refund: false})]) {
        expect(mail.html).not.toContain(JOIN);
        expect(mail.text).not.toContain(JOIN);
        for (const a of mail.attachments ?? []) expect(a.content).not.toContain(JOIN);
      }
    });
  }
  it('a confirmed going guest does get it', () => {
    expect(canSeeJoinLink(data().guest)).toBe(true);
    expect(reminderEmail(data(), copy).text).toContain(JOIN);
  });
});

describe('escaping and injection', () => {
  const evil = '<script>alert(1)</script>"><img src=x onerror=1>';
  it('escapes guest, event, brand and venue values in html', () => {
    const d = data({guest: {name: evil}, event: {title: evil, format: 'in_person', venueName: evil}, brand: {senderName: evil}});
    for (const mail of [confirmationEmail(d), approvalPendingEmail(d), eventCancelledEmail(d, {refund: true}), consentEmail({...d, guest: {...d.guest, consentUrl: 'https://x.example/c'}})]) {
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).not.toContain('<img src=x');
    }
  });
  it('creator copy cannot inject markup, and merged values are escaped too', () => {
    const mail = broadcastEmail(data({guest: {name: evil}}), {subject: 'S', body: '<b onclick=1>hi</b> {{guest.name}}'});
    expect(mail.html).not.toContain('<b onclick');
    expect(mail.html).not.toContain('<script>');
  });
  it('subject has no newlines (header injection)', () => {
    const mail = broadcastEmail(data({guest: {name: 'A\r\nBcc: evil@x.example'}}), {subject: 'Hi {{guest.name}}', body: 'x'});
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
  it('javascript: urls in creator copy are not turned into links', () => {
    const mail = broadcastEmail(data(), {subject: 'S', body: 'click javascript:alert(1) now'});
    expect(mail.html).not.toMatch(/href="javascript:/i);
  });
});

describe('calendar attachments', () => {
  it('confirmation .ics is stable per rsvp and the cancel carries a later sequence', () => {
    const d = data();
    const first = confirmationEmail(d).attachments![0]!;
    const later = eventCancelledEmail({...d, now: new Date(NOW.getTime() + 3600_000)}, {refund: false}).attachments![0]!;
    const uid = (s: string) => /UID:(.+)/.exec(s)![1]!.trim();
    const seq = (s: string) => Number(/SEQUENCE:(\d+)/.exec(s)![1]);
    expect(uid(first.content)).toBe(uid(later.content));
    expect(seq(later.content)).toBeGreaterThan(seq(first.content));
    expect(first.contentType).toContain('method=PUBLISH');
    expect(later.contentType).toContain('method=CANCEL');
  });
  it('the ics description carries the manage link', () => {
    expect(confirmationEmail(data()).attachments![0]!.content).toContain('tok123');
  });
});

describe('plain text parity', () => {
  it('every template has a non-empty subject and text containing the manage link', () => {
    const d = data();
    for (const mail of [confirmationEmail(d), reminderEmail(d, copy), liveNowEmail(d, copy), thankYouEmail(d, copy), broadcastEmail(d, copy), approvalPendingEmail(d), eventCancelledEmail(d, {refund: false})]) {
      expect(mail.subject.trim()).not.toBe('');
      expect(mail.text.length).toBeGreaterThan(10);
      expect(mail.text).toContain('events.example/r/tok123');
    }
  });
  it('refund wording only when a refund is due', () => {
    expect(eventCancelledEmail(data(), {refund: true}).text).toContain('refunded');
    expect(eventCancelledEmail(data(), {refund: false}).text).not.toContain('refunded');
  });
});
