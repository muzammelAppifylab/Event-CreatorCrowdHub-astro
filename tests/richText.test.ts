import {describe, expect, it} from 'vitest';

import {descriptionExcerpt, renderDescription} from '../src/domain/richText';

describe('renderDescription (the only path event descriptions take into set:html)', () => {
  it('escapes markup before adding its own tags', () => {
    const html = renderDescription('<script>alert(1)</script> **bold** <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('drops javascript: links and keeps https ones safe', () => {
    expect(renderDescription('[x](javascript:alert(1))')).not.toContain('<a');
    const ok = renderDescription('[site](https://example.com/a?b=1&c=2)');
    expect(ok).toContain('rel="noopener noreferrer nofollow"');
    expect(ok).toContain('&amp;c=2');
  });

  it('renders lists and paragraphs; excerpt has no markup', () => {
    expect(renderDescription('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(descriptionExcerpt('**Hi** [there](https://x.co)')).toBe('Hi there');
  });
});
