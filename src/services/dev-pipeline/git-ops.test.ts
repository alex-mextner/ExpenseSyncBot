import { test, expect, describe } from 'bun:test';
import { generateBranchName } from './git-ops';

describe('generateBranchName', () => {
  test('normal title produces dev/<slug>-<id>', () => {
    const result = generateBranchName(42, 'Add weekly summary');
    expect(result).toBe('dev/add-weekly-summary-42');
  });

  test('special characters are stripped or replaced with hyphens', () => {
    const result = generateBranchName(7, 'Fix bug: crash on $pecial chars!');
    // Only a-z, 0-9, spaces, and hyphens survive the regex
    // Spaces become hyphens, specials vanish
    expect(result).toBe('dev/fix-bug-crash-on-pecial-chars-7');
  });

  test('long title is truncated to 40 chars (slug portion)', () => {
    const longTitle = 'Implement the very long feature that nobody asked for but we build it anyway';
    const result = generateBranchName(99, longTitle);

    // The slug part (before -99) should be at most 40 chars,
    // and trailing hyphens should be removed
    const slug = result.replace('dev/', '').replace(/-99$/, '');
    expect(slug.length).toBeLessThanOrEqual(40);

    // Full branch starts with dev/ and ends with -<id>
    expect(result.startsWith('dev/')).toBe(true);
    expect(result.endsWith('-99')).toBe(true);
  });

  test('trailing hyphens on slug are removed before appending id', () => {
    // "hello world---" → after regex: "hello-world---" → slice might leave trailing hyphens
    const result = generateBranchName(1, 'hello world   ');
    expect(result).toBe('dev/hello-world-1');
    // No double hyphens between slug and id
    expect(result).not.toMatch(/--/);
  });
});
