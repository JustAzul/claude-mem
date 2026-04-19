import { describe, it, expect } from 'bun:test';
import { extractIdentifiers } from '../../../src/services/memory/identifier-extractor.js';

describe('extractIdentifiers', () => {
  it('extracts backtick-quoted strings', () => {
    const ids = extractIdentifiers('use `foo_bar` when needed');
    expect(ids).toContain('foo_bar');
  });

  it('extracts file paths', () => {
    const ids = extractIdentifiers('edit src/foo.ts and lib/bar.tsx');
    expect(ids.some((i) => i.includes('src/foo.ts'))).toBe(true);
    expect(ids.some((i) => i.includes('lib/bar.tsx'))).toBe(true);
  });

  it('extracts CamelCase identifiers (2+ caps, len>=4)', () => {
    const ids = extractIdentifiers('ResponseProcessor calls SessionStore methods');
    expect(ids).toContain('responseprocessor');
    expect(ids).toContain('sessionstore');
  });

  it('extracts snake_case with 2+ underscores', () => {
    const ids = extractIdentifiers('the memory_assist_decisions table stores log_rows_here');
    expect(ids).toContain('memory_assist_decisions');
    expect(ids).toContain('log_rows_here');
  });

  it('filters stopwords', () => {
    const ids = extractIdentifiers('`the` and `this` must be stripped');
    expect(ids).not.toContain('the');
    expect(ids).not.toContain('this');
    expect(ids).not.toContain('and');
  });

  it('filters short tokens (<=3 chars)', () => {
    const ids = extractIdentifiers('`ab` short `abc` tiny `abcd` kept');
    expect(ids).not.toContain('ab');
    expect(ids).not.toContain('abc');
    expect(ids).toContain('abcd');
  });

  it('dedupes case-insensitively', () => {
    const ids = extractIdentifiers('`FooClass` and FooClass again');
    const lowercaseHits = ids.filter((i) => i === 'fooclass');
    expect(lowercaseHits.length).toBe(1);
  });

  it('returns up to 20 candidates, longer first', () => {
    const many = Array.from({ length: 30 }, (_, i) => `\`identifier_${i}_suffix_${i}\``).join(' ');
    const ids = extractIdentifiers(many);
    expect(ids.length).toBeLessThanOrEqual(20);
    // First should be longest available; since ~30 tokens all similar length, check sorted desc
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1].length >= ids[i].length).toBe(true);
    }
  });

  it('returns empty array for empty text', () => {
    expect(extractIdentifiers('')).toEqual([]);
    expect(extractIdentifiers('the and but null')).toEqual([]);
  });
});
