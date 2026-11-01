import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('../src/platform/config', () => ({
  config: {ownerSecret: () => null, production: false},
}));

import {config} from '../src/platform/config';
import {devEmailLinks, sendEventEmail} from '../src/server/mailer';

const email = {
  to: 'dev@example.test',
  content: {subject: 'Confirmed', html: '<p>x</p>', text: 'Manage: https://x.test/r/tok123\nClaim https://x.test/c/abc.'},
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  (config as {production: boolean}).production = false;
});

describe('dev email links', () => {
  it('extracts unique links', () => {
    expect(devEmailLinks('a https://x.test/r/1 b https://x.test/r/1 (https://y.test/i/2)')).toEqual(['https://x.test/r/1', 'https://y.test/i/2']);
  });

  it('prints links with [dev email] in local development', async () => {
    vi.stubEnv('DEV', true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await sendEventEmail(email)).toBe(false);
    const out = info.mock.calls.map(c => String(c[0]));
    expect(out).toContain('[dev email] https://x.test/r/tok123');
  });

  it('logs only subject and recipient domain outside development', async () => {
    vi.stubEnv('DEV', false);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await sendEventEmail(email);
    const out = info.mock.calls.map(c => String(c[0])).join('\n');
    expect(out).not.toContain('tok123');
    expect(out).not.toContain('[dev email]');
    expect(out).toContain('*@example.test');
  });

  it('never prints links in production even if DEV were set', async () => {
    vi.stubEnv('DEV', true);
    (config as {production: boolean}).production = true;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await sendEventEmail(email);
    expect(info.mock.calls.map(c => String(c[0])).join('\n')).not.toContain('tok123');
  });
});
