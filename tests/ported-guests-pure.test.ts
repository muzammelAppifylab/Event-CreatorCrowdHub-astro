import {describe, expect, it} from 'vitest';

import {
  describeOffset,
  embedCode,
  insertAtCursor,
  joinOffset,
  shareText,
  shareUrl,
  splitOffset,
  summarizeBulk,
} from '../src/portal/guests-queries';
import {attachmentHeader, csvCell, parseCsv, toCsv, UTF8_BOM} from '../src/server/csv';

describe('ported csv writer', () => {
  it('quotes commas, quotes and newlines per RFC 4180', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(true)).toBe('true');
  });
  it('starts with BOM and uses CRLF', () => {
    expect(toCsv([['Name', 'City'], ['Zoë', 'Kraków']])).toBe(`${UTF8_BOM}Name,City\r\nZoë,Kraków\r\n`);
    expect(toCsv([['a']], {bom: false})).toBe('a\r\n');
  });
  it('guards formula cells', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(-2)).toBe('-2');
    expect(csvCell('a=b')).toBe('a=b');
  });
  it('safe attachment header', () => {
    expect(attachmentHeader('guests-launch night.csv')).toBe('attachment; filename="guests-launch-night.csv"');
  });
});

describe('ported csv parser', () => {
  it('round-trips writer output', () => {
    const rows = [['Name', 'Note'], ['Ada', 'said "hi", then\nleft'], ['Zoë', '']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it('accepts LF, no trailing newline and blank lines', () => {
    expect(parseCsv('a,b\n\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('ported share kit', () => {
  const url = 'https://events.example.com/e/pricing-workshop?utm_source=share&x=1';
  const title = 'Pricing & Packaging #2';
  it('encodes URL and text for every platform', () => {
    const x = new URL(shareUrl('x', url, title));
    expect(x.origin + x.pathname).toBe('https://twitter.com/intent/tweet');
    expect(x.searchParams.get('url')).toBe(url);
    expect(x.searchParams.get('text')).toBe(shareText(title));
    expect(shareUrl('x', url, title)).not.toMatch(/Packaging #2|&x=1/);
    expect(new URL(shareUrl('linkedin', url, title)).searchParams.get('url')).toBe(url);
    const wa = new URL(shareUrl('whatsapp', url, title));
    expect(wa.origin).toBe('https://wa.me');
    expect(wa.searchParams.get('text')).toBe(`Join me at ${title}. RSVP here: ${url}`);
    const fb = new URL(shareUrl('facebook', url, title));
    expect(fb.pathname).toBe('/sharer/sharer.php');
    expect(fb.searchParams.get('u')).toBe(url);
  });
  it('embed code escapes attributes', () => {
    const code = embedCode('https://events.example.com/', 'pricing-workshop', 'The "Big" <Show>');
    expect(code).toContain('src="https://events.example.com/e/pricing-workshop?embed=1"');
    expect(code).toContain('title="RSVP: The &quot;Big&quot; &lt;Show&gt;"');
    expect(code.startsWith('<iframe ')).toBe(true);
    expect(code.endsWith('></iframe>')).toBe(true);
  });
});

describe('ported messages lib', () => {
  it('describeOffset in plain words', () => {
    expect(describeOffset('reminder', -1440)).toBe('24 hours before');
    expect(describeOffset('reminder', -2880)).toBe('2 days before');
    expect(describeOffset('reminder', -60)).toBe('1 hour before');
    expect(describeOffset('reminder', -90)).toBe('90 minutes before');
    expect(describeOffset('live_now', 0)).toBe('At the start');
    expect(describeOffset('live_now', 10)).toBe('10 minutes after the start');
    expect(describeOffset('thank_you', 120)).toBe('2 hours after the end');
    expect(describeOffset('thank_you', 0)).toBe('When the event ends');
    expect(describeOffset('confirmation', 0)).toBe('Straight after the RSVP');
  });
  it('offset editor round-trips', () => {
    expect(splitOffset(-1440)).toEqual({amount: 24, unit: 'hours'});
    expect(splitOffset(-4320)).toEqual({amount: 3, unit: 'days'});
    expect(splitOffset(-120)).toEqual({amount: 2, unit: 'hours'});
    expect(splitOffset(-45)).toEqual({amount: 45, unit: 'minutes'});
    expect(joinOffset('reminder', 1, 'days')).toBe(-1440);
    expect(joinOffset('thank_you', 2, 'hours')).toBe(120);
    expect(joinOffset('live_now', 5, 'minutes', true)).toBe(5);
    expect(joinOffset('live_now', 5, 'minutes')).toBe(-5);
  });
  it('insertAtCursor', () => {
    expect(insertAtCursor('Hi !', '{{guest.first_name}}', 3, 3)).toEqual({value: 'Hi {{guest.first_name}}!', caret: 23});
    expect(insertAtCursor('Hi NAME', '{{guest.name}}', 3, 7).value).toBe('Hi {{guest.name}}');
    expect(insertAtCursor('Hi', 'X', null, null)).toEqual({value: 'HiX', caret: 3});
  });
  it('summarizeBulk reports partial success', () => {
    expect(summarizeBulk({action: 'promote', succeeded: ['a', 'b'], failed: []})).toEqual({ok: true, message: '2 guests promoted.'});
    const r = summarizeBulk({action: 'promote', succeeded: ['a'], failed: [{rsvpId: 'x', reason: 'event_full'}, {rsvpId: 'y', reason: 'event_full'}]});
    expect(r.ok).toBe(true);
    expect(r.message).toBe('1 guest promoted. 2 skipped: no seats left (2).');
  });
});
