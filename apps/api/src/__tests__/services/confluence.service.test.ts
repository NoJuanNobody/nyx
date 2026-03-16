import { describe, it, expect } from 'vitest';
import {
  confluenceService,
  htmlToMarkdown,
} from '../../services/confluence.service.js';

describe('confluenceService', () => {
  describe('htmlToMarkdown', () => {
    it('converts headings', () => {
      expect(htmlToMarkdown('<h1>Title</h1>')).toBe('# Title');
      expect(htmlToMarkdown('<h2>Subtitle</h2>')).toBe('## Subtitle');
      expect(htmlToMarkdown('<h3>Section</h3>')).toBe('### Section');
    });

    it('converts paragraphs', () => {
      const result = htmlToMarkdown('<p>Hello world</p>');
      expect(result).toContain('Hello world');
    });

    it('converts bold and italic', () => {
      expect(htmlToMarkdown('<strong>bold</strong>')).toBe('**bold**');
      expect(htmlToMarkdown('<em>italic</em>')).toBe('*italic*');
    });

    it('converts links', () => {
      const result = htmlToMarkdown('<a href="https://example.com">link</a>');
      expect(result).toBe('[link](https://example.com)');
    });

    it('converts inline code', () => {
      expect(htmlToMarkdown('<code>const x = 1</code>')).toBe('`const x = 1`');
    });

    it('converts unordered lists', () => {
      const html = '<ul><li>item 1</li><li>item 2</li></ul>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('- item 1');
      expect(result).toContain('- item 2');
    });

    it('converts ordered lists', () => {
      const html = '<ol><li>first</li><li>second</li></ol>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('1. first');
      expect(result).toContain('2. second');
    });

    it('strips unknown HTML tags', () => {
      const result = htmlToMarkdown('<div><span>text</span></div>');
      expect(result).toBe('text');
      expect(result).not.toContain('<');
    });

    it('decodes HTML entities', () => {
      const result = htmlToMarkdown('&amp; &lt; &gt; &quot; &#39;');
      expect(result).toBe('& < > " \'');
    });
  });

  describe('listSpaces', () => {
    it('returns mock spaces when unconfigured', async () => {
      const spaces = await confluenceService.listSpaces();
      expect(spaces).toBeInstanceOf(Array);
      expect(spaces.length).toBeGreaterThan(0);
      for (const space of spaces) {
        expect(space).toHaveProperty('key');
        expect(space).toHaveProperty('name');
      }
    });

    it('includes ENG and PROD spaces', async () => {
      const spaces = await confluenceService.listSpaces();
      const keys = spaces.map((s) => s.key);
      expect(keys).toContain('ENG');
      expect(keys).toContain('PROD');
    });
  });

  describe('listPages', () => {
    it('returns pages filtered by space key', async () => {
      const engPages = await confluenceService.listPages('ENG');
      expect(engPages.length).toBeGreaterThan(0);
      for (const page of engPages) {
        expect(page.spaceKey).toBe('ENG');
      }
    });

    it('returns empty array for unknown space', async () => {
      const pages = await confluenceService.listPages('UNKNOWN');
      expect(pages).toEqual([]);
    });
  });

  describe('getPage', () => {
    it('returns a page by ID', async () => {
      const page = await confluenceService.getPage('cf-1');
      expect(page).not.toBeNull();
      expect(page!.id).toBe('cf-1');
      expect(page!.title).toBe('API Authentication Guide');
    });

    it('returns null for unknown page ID', async () => {
      const page = await confluenceService.getPage('nonexistent');
      expect(page).toBeNull();
    });
  });

  describe('importPage', () => {
    it('imports a page and returns quality result', async () => {
      const result = await confluenceService.importPage({
        pageId: 'cf-1',
        teamId: 'team-1',
      });

      expect(result.page.id).toBe('cf-1');
      expect(result.documentId).toBeTruthy();
      expect(typeof result.qualityScore).toBe('number');
      expect(result.qualitySuggestions).toBeInstanceOf(Array);
      expect(['active', 'needs_review']).toContain(result.status);
    });

    it('sets status to active when quality score >= 7', async () => {
      // With mock AI fallback, score defaults to 7
      const result = await confluenceService.importPage({
        pageId: 'cf-1',
        teamId: 'team-1',
      });

      expect(result.qualityScore).toBeGreaterThanOrEqual(7);
      expect(result.status).toBe('active');
    });

    it('throws for unknown page ID', async () => {
      await expect(
        confluenceService.importPage({
          pageId: 'nonexistent',
          teamId: 'team-1',
        }),
      ).rejects.toThrow('Confluence page not found');
    });
  });

  describe('importSpace', () => {
    it('imports all pages in a space', async () => {
      const results = await confluenceService.importSpace({
        spaceKey: 'ENG',
        teamId: 'team-1',
      });

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.page.spaceKey).toBe('ENG');
        expect(result.documentId).toBeTruthy();
        expect(typeof result.qualityScore).toBe('number');
      }
    });

    it('returns empty array for unknown space', async () => {
      const results = await confluenceService.importSpace({
        spaceKey: 'UNKNOWN',
        teamId: 'team-1',
      });
      expect(results).toEqual([]);
    });
  });
});
