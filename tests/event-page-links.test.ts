import {describe, expect, it} from 'vitest';

import {eventPageLinks} from '../src/server/guest-mail';

describe('eventPageLinks: emails built without the raw manage token', () => {
  it('links a public or unlisted event to its page, without the /e/ redirect', () => {
    for (const visibility of ['public', 'unlisted', undefined] as const) {
      expect(eventPageLinks('https://x.test/', {slug: 'a b', visibility})).toEqual({
        pageUrl: 'https://x.test/events/a%20b/',
        publicPageUrl: 'https://x.test/events/a%20b/',
      });
    }
  });

  it('never links a private event to its page (it answers 404 without an invite)', () => {
    expect(eventPageLinks('https://x.test', {slug: 'secret', visibility: 'private'})).toEqual({
      pageUrl: 'https://x.test/',
      publicPageUrl: null,
    });
  });
});
