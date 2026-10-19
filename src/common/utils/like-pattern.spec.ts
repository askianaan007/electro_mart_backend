import { likeContains } from './like-pattern';

describe('likeContains', () => {
  it('escapes LIKE metacharacters', () => {
    expect(likeContains('10%')).toBe('%10\\%%');
    expect(likeContains('a_b')).toBe('%a\\_b%');
    expect(likeContains('c:\\x')).toBe('%c:\\\\x%');
    expect(likeContains('plain')).toBe('%plain%');
  });
});
