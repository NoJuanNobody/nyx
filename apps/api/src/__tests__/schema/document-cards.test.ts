import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import {
  documentCategories,
  documentCards,
} from '../../db/schema.js';

describe('documentCategories schema', () => {
  it('exports the table', () => {
    expect(documentCategories).toBeDefined();
  });

  it('has required columns', () => {
    const cols = Object.keys(documentCategories);
    expect(cols).toContain('id');
    expect(cols).toContain('teamId');
    expect(cols).toContain('name');
    expect(cols).toContain('slug');
    expect(cols).toContain('description');
    expect(cols).toContain('color');
    expect(cols).toContain('createdBy');
    expect(cols).toContain('createdAt');
    expect(cols).toContain('updatedAt');
  });

  it('is backed by the document_categories table', () => {
    expect(getTableName(documentCategories)).toBe('document_categories');
  });
});

describe('documentCards schema', () => {
  it('exports the table', () => {
    expect(documentCards).toBeDefined();
  });

  it('has all Card entity fields from the System Architecture Document', () => {
    const cols = Object.keys(documentCards);
    // Core fields from the truncated spec (issue #396):
    // id, title, description, category_id, template_id, artwork_urls[],
    // created_at, updated_at, is_published, metadata, created_by
    expect(cols).toContain('id');
    expect(cols).toContain('title');
    expect(cols).toContain('description');
    expect(cols).toContain('categoryId');
    expect(cols).toContain('templateId');
    expect(cols).toContain('artworkUrls');
    expect(cols).toContain('isPublished');
    expect(cols).toContain('metadata');
    expect(cols).toContain('createdBy');
    expect(cols).toContain('teamId');
    expect(cols).toContain('createdAt');
    expect(cols).toContain('updatedAt');
  });

  it('is backed by the document_cards table', () => {
    expect(getTableName(documentCards)).toBe('document_cards');
  });
});
