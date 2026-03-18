import { describe, it, expect } from 'vitest';
import { fileParserService } from '../../services/file-parser.service.js';

describe('FileParserService', () => {
  describe('plain text files', () => {
    it('parses text/plain as direct text import', () => {
      const buffer = Buffer.from('Hello, world!');
      const result = fileParserService.parseFile(buffer, 'text/plain');

      expect(result.content).toBe('Hello, world!');
      expect(result.note).toBeUndefined();
    });

    it('parses text/markdown as direct text import', () => {
      const md = '# Heading\n\nParagraph content.';
      const buffer = Buffer.from(md);
      const result = fileParserService.parseFile(buffer, 'text/markdown');

      expect(result.content).toBe(md);
      expect(result.note).toBeUndefined();
    });

    it('parses text/x-markdown as direct text import', () => {
      const buffer = Buffer.from('## Sub heading');
      const result = fileParserService.parseFile(buffer, 'text/x-markdown');

      expect(result.content).toBe('## Sub heading');
      expect(result.note).toBeUndefined();
    });
  });

  describe('CSV files', () => {
    it('converts simple CSV to a markdown table', () => {
      const csv = 'Name,Age,City\nAlice,30,NYC\nBob,25,LA';
      const buffer = Buffer.from(csv);
      const result = fileParserService.parseFile(buffer, 'text/csv');

      expect(result.content).toContain('| Name | Age | City |');
      expect(result.content).toContain('| --- | --- | --- |');
      expect(result.content).toContain('| Alice | 30 | NYC |');
      expect(result.content).toContain('| Bob | 25 | LA |');
      expect(result.note).toBeUndefined();
    });

    it('handles CSV with quoted fields containing commas', () => {
      const csv = 'Name,Description\nAlice,"Has a cat, dog"\nBob,"Simple"';
      const buffer = Buffer.from(csv);
      const result = fileParserService.parseFile(buffer, 'text/csv');

      expect(result.content).toContain('| Has a cat, dog |');
    });

    it('handles CSV with escaped quotes', () => {
      const csv = 'Name,Quote\nAlice,"She said ""hello"""';
      const buffer = Buffer.from(csv);
      const result = fileParserService.parseFile(buffer, 'text/csv');

      expect(result.content).toContain('She said "hello"');
    });

    it('handles empty CSV gracefully', () => {
      const buffer = Buffer.from('');
      const result = fileParserService.parseFile(buffer, 'text/csv');

      expect(result.content).toBe('');
    });

    it('handles CSV with header only', () => {
      const csv = 'Name,Age';
      const buffer = Buffer.from(csv);
      const result = fileParserService.parseFile(buffer, 'text/csv');

      expect(result.content).toContain('| Name | Age |');
      expect(result.content).toContain('| --- | --- |');
    });

    it('accepts application/csv mime type', () => {
      const csv = 'A,B\n1,2';
      const buffer = Buffer.from(csv);
      const result = fileParserService.parseFile(buffer, 'application/csv');

      expect(result.content).toContain('| A | B |');
    });
  });

  describe('MIME type refinement from filename', () => {
    it('infers text/plain from .txt extension when MIME is octet-stream', () => {
      const buffer = Buffer.from('some text');
      const result = fileParserService.parseFile(buffer, 'application/octet-stream', 'notes.txt');

      expect(result.content).toBe('some text');
      expect(result.note).toBeUndefined();
    });

    it('infers text/markdown from .md extension when MIME is octet-stream', () => {
      const buffer = Buffer.from('# Title');
      const result = fileParserService.parseFile(buffer, 'application/octet-stream', 'readme.md');

      expect(result.content).toBe('# Title');
      expect(result.note).toBeUndefined();
    });

    it('infers text/csv from .csv extension when MIME is octet-stream', () => {
      const csv = 'A,B\n1,2';
      const buffer = Buffer.from(csv);
      const result = fileParserService.parseFile(buffer, 'application/octet-stream', 'data.csv');

      expect(result.content).toContain('| A | B |');
    });

    it('does not override explicit MIME type', () => {
      const buffer = Buffer.from('not csv');
      const result = fileParserService.parseFile(buffer, 'text/plain', 'data.csv');

      // text/plain should win over .csv extension
      expect(result.content).toBe('not csv');
      expect(result.note).toBeUndefined();
    });
  });

  describe('unsupported formats', () => {
    it('returns raw text with a note for application/pdf', () => {
      const buffer = Buffer.from('raw pdf bytes');
      const result = fileParserService.parseFile(buffer, 'application/pdf');

      expect(result.content).toBe('raw pdf bytes');
      expect(result.note).toContain('not fully supported');
      expect(result.note).toContain('application/pdf');
    });

    it('returns raw text with a note for application/json', () => {
      const json = '{"key": "value"}';
      const buffer = Buffer.from(json);
      const result = fileParserService.parseFile(buffer, 'application/json');

      expect(result.content).toBe(json);
      expect(result.note).toContain('not fully supported');
    });

    it('returns raw text with a note for unknown MIME and no filename', () => {
      const buffer = Buffer.from('mystery content');
      const result = fileParserService.parseFile(buffer, 'application/octet-stream');

      expect(result.content).toBe('mystery content');
      expect(result.note).toContain('not fully supported');
    });
  });
});
