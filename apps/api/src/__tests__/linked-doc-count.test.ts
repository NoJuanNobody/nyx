import { describe, it, expect } from 'vitest';

// Copy of the helper to test in isolation
function countLinkedDocs(teamDocs: { content: string }[], fullName: string): number {
  const lower = fullName.toLowerCase();
  return teamDocs.filter(d => d.content.toLowerCase().includes(lower)).length;
}

describe('countLinkedDocs', () => {
  it('counts docs that mention the fullName', () => {
    const docs = [
      { content: 'This doc covers acme/api integration.' },
      { content: 'Unrelated content about APIs.' },
      { content: 'See acme/api for details.' },
    ];
    expect(countLinkedDocs(docs, 'acme/api')).toBe(2);
  });

  it('is case-insensitive', () => {
    const docs = [{ content: 'See ACME/API for details.' }];
    expect(countLinkedDocs(docs, 'acme/api')).toBe(1);
  });

  it('does NOT count docs that only mention the short name', () => {
    const docs = [
      { content: 'The api module is important.' },
      { content: 'Call the API endpoint.' },
      { content: 'This mentions acme/api explicitly.' },
    ];
    // Only the third doc has the fullName
    expect(countLinkedDocs(docs, 'acme/api')).toBe(1);
  });

  it('returns 0 when no docs match', () => {
    const docs = [{ content: 'Nothing relevant here.' }];
    expect(countLinkedDocs(docs, 'acme/api')).toBe(0);
  });
});
