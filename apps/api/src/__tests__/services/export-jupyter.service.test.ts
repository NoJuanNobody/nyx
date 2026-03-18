import { describe, it, expect } from 'vitest';
import { markdownToNotebook } from '../../services/export-jupyter.service.js';

describe('markdownToNotebook', () => {
  describe('notebook structure', () => {
    it('returns valid nbformat v4 structure', () => {
      const result = markdownToNotebook('# Hello');
      expect(result.nbformat).toBe(4);
      expect(result.nbformat_minor).toBeGreaterThanOrEqual(0);
      expect(result.metadata).toBeDefined();
      expect(result.metadata.kernelspec).toBeDefined();
      expect(Array.isArray(result.cells)).toBe(true);
    });
  });

  describe('markdown cells', () => {
    it('converts markdown headings to markdown cells', () => {
      const result = markdownToNotebook('# Title\n\nSome text');
      const markdownCells = result.cells.filter(
        (c: { cell_type: string }) => c.cell_type === 'markdown'
      );
      expect(markdownCells.length).toBeGreaterThanOrEqual(1);
    });

    it('handles document with no code blocks', () => {
      const md = '# Heading\n\nParagraph one.\n\n## Subheading\n\nParagraph two.';
      const result = markdownToNotebook(md);
      const allMarkdown = result.cells.every(
        (c: { cell_type: string }) => c.cell_type === 'markdown'
      );
      expect(allMarkdown).toBe(true);
    });
  });

  describe('code cells', () => {
    it('converts fenced code blocks to code cells', () => {
      const md = '```python\nprint("hello")\n```';
      const result = markdownToNotebook(md);
      const codeCells = result.cells.filter(
        (c: { cell_type: string }) => c.cell_type === 'code'
      );
      expect(codeCells.length).toBe(1);
      const source = Array.isArray(codeCells[0].source)
        ? codeCells[0].source.join('')
        : codeCells[0].source;
      expect(source).toContain('print("hello")');
    });

    it('handles document with only code blocks', () => {
      const md = '```python\nx = 1\n```\n\n```python\ny = 2\n```';
      const result = markdownToNotebook(md);
      const allCode = result.cells.every(
        (c: { cell_type: string }) => c.cell_type === 'code'
      );
      expect(allCode).toBe(true);
    });

    it('code cells have outputs and execution_count', () => {
      const md = '```python\nprint("hello")\n```';
      const result = markdownToNotebook(md);
      const codeCells = result.cells.filter(
        (c: { cell_type: string }) => c.cell_type === 'code'
      );
      expect(codeCells.length).toBe(1);
      expect(codeCells[0].outputs).toEqual([]);
      expect(codeCells[0].execution_count).toBeNull();
    });

    it('preserves code language info without fence markers', () => {
      const md = '```python\nimport os\nos.getcwd()\n```';
      const result = markdownToNotebook(md);
      const codeCells = result.cells.filter(
        (c: { cell_type: string }) => c.cell_type === 'code'
      );
      const source = Array.isArray(codeCells[0].source)
        ? codeCells[0].source.join('')
        : codeCells[0].source;
      expect(source).not.toContain('```');
      expect(source).toContain('import os');
    });
  });

  describe('mixed content', () => {
    it('handles mixed markdown and code in correct order', () => {
      const md =
        'Some intro text\n\n```python\nx = 1\n```\n\nMore text after code';
      const result = markdownToNotebook(md);
      expect(result.cells.length).toBe(3);
      expect(result.cells[0].cell_type).toBe('markdown');
      expect(result.cells[1].cell_type).toBe('code');
      expect(result.cells[2].cell_type).toBe('markdown');
    });
  });

  describe('edge cases', () => {
    it('handles empty document', () => {
      const result = markdownToNotebook('');
      expect(result.nbformat).toBe(4);
      expect(Array.isArray(result.cells)).toBe(true);
    });
  });

  describe('metadata', () => {
    it('sets default title in metadata', () => {
      const result = markdownToNotebook('# Hello', 'My Notebook');
      const metadataStr = JSON.stringify(result.metadata);
      const firstCellSource = Array.isArray(result.cells[0]?.source)
        ? result.cells[0].source.join('')
        : result.cells[0]?.source ?? '';
      const hasTitle =
        metadataStr.includes('My Notebook') ||
        firstCellSource.includes('My Notebook');
      expect(hasTitle).toBe(true);
    });
  });
});
