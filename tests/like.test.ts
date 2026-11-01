import {describe, expect, it} from 'vitest';

import {escapeLike} from '../src/server/like';

describe('escapeLike', () => {
  it('escapes %, _ and backslash', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
  it('neutralises a bare wildcard search', () => {
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('_')).toBe('\\_');
  });
  it('leaves plain text alone', () => {
    expect(escapeLike('Ann Lee')).toBe('Ann Lee');
  });
});
