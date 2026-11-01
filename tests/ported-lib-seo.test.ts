import {describe, expect, it} from 'vitest';

import {absoluteUrl, eventJsonLd, jsonLdText, xmlEscape} from '../src/lib/seo';

const event = {slug: 'my-event', title: 'Launch', description: 'Desc', startAt: '2026-11-01T18:00:00Z', endAt: '2026-11-01T20:00:00Z', format: 'in_person', venueName: 'The Loft', venueAddress: '1 Main St'};

describe('jsonLdText', () => {
  it('cannot close the script tag or open a comment', () => {
    const t = jsonLdText({a: '</script><script>alert(1)</script><!-- & '});
    expect(t).not.toContain('<');
    expect(t).not.toContain('>');
    expect(t).not.toContain('&');
    expect(JSON.parse(t).a).toBe('</script><script>alert(1)</script><!-- & ');
  });
});

describe('xmlEscape / absoluteUrl', () => {
  it('escapes', () => expect(xmlEscape(`<a href="x">&`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;'));
  it('keeps https urls as they are', () => expect(absoluteUrl('https://cdn.example/x.png')).toBe('https://cdn.example/x.png'));
});

describe('eventJsonLd', () => {
  it('in person: Place, offline mode', () => {
    const ld = eventJsonLd(event) as any;
    expect(ld['@type']).toBe('Event');
    expect(ld.eventAttendanceMode).toBe('https://schema.org/OfflineEventAttendanceMode');
    expect(ld.location).toEqual({'@type': 'Place', name: 'The Loft', address: '1 Main St'});
    expect(ld.name).toBe('Launch');
  });
  it('online: no venue, online mode', () => {
    const ld = eventJsonLd({...event, format: 'online'}) as any;
    expect(ld.eventAttendanceMode).toBe('https://schema.org/OnlineEventAttendanceMode');
    expect(JSON.stringify(ld)).not.toContain('The Loft');
  });
  it('hybrid has both locations', () => {
    const ld = eventJsonLd({...event, format: 'hybrid'}) as any;
    expect(ld.eventAttendanceMode).toBe('https://schema.org/MixedEventAttendanceMode');
    expect(ld.location).toHaveLength(2);
  });
  it('never leaks the private join url when the origin is unknown', () => {
    const ld = eventJsonLd({...event, format: 'online', joinUrl: 'https://zoom.example/secret'});
    expect(JSON.stringify(ld)).not.toContain('zoom.example/secret');
  });
  it('adds organizer only with a site', () => {
    expect((eventJsonLd(event) as any).organizer).toBeUndefined();
    expect((eventJsonLd(event, {name: 'Clara'}) as any).organizer.name).toBe('Clara');
  });
});
