import { describe, expect, it } from 'vitest';
import { shouldCommitClick } from './InteractionRuntime';

describe('interaction click release', () => {
  it('commits only when pointer release is over the originally pressed control', () => {
    expect(shouldCommitClick('power', 'power')).toBe(true);
    expect(shouldCommitClick('power', 'volume-up')).toBe(false);
    expect(shouldCommitClick('power', null)).toBe(false);
  });
});
