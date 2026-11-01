import {describe, expect, it} from 'vitest';

import {pollVotesCsv} from '../src/server/routes/admin-polls';

const at = new Date('2026-10-30T10:00:00Z');
const vote = {optionIds: [], ratingValue: null, textValue: null, createdAt: at, updatedAt: at};
const labels = new Map([['a', 'Yes'], ['b', 'No, thanks']]);

describe('pollVotesCsv', () => {
  it('writes choice answers by label, joined, with no email column for anonymous polls', () => {
    const csv = pollVotesCsv({question: 'Ready?', type: 'multi_choice', anonymous: true}, labels, [{...vote, optionIds: ['a', 'b']}]);
    expect(csv).toContain('Poll,Answer,Submitted at (UTC)\r\n');
    expect(csv).toContain('Ready?,"Yes; No, thanks",2026-10-30T10:00:00.000Z\r\n');
  });
  it('guards text answers against spreadsheet formulas', () => {
    const csv = pollVotesCsv({question: 'Q', type: 'short_text', anonymous: true}, labels, [{...vote, textValue: '=HYPERLINK("x")'}]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
  it('adds guest email only when the poll is not anonymous; ratings stay numeric', () => {
    const csv = pollVotesCsv({question: 'Q', type: 'rating', anonymous: false}, labels, [{...vote, ratingValue: 4, email: 'a@x.test'}]);
    expect(csv).toContain('Guest email');
    expect(csv).toContain('Q,4,2026-10-30T10:00:00.000Z,a@x.test');
  });
});
