import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module before importing the route
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();

vi.mock('../../db/index.js', () => ({
  db: {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return { from: mockFrom };
    },
  },
}));

mockFrom.mockReturnValue({ where: mockWhere });
mockWhere.mockReturnValue({ orderBy: mockOrderBy });
mockOrderBy.mockReturnValue({ limit: mockLimit });

// Mock the permissions middleware to pass through
vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async (_req: unknown, _reply: unknown) => {},
}));

import Fastify from 'fastify';
import { docChangesRoutes } from '../../routes/doc-changes.js';

describe('GET /changes', () => {
  const app = Fastify();

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
  });

  // Register once — Fastify caches route registrations
  app.register(docChangesRoutes);

  it('returns 400 when teamId is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/changes?since=2026-01-01T00:00:00Z',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/teamId/);
  });

  it('returns 400 when since is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/changes?teamId=abc',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/since/);
  });

  it('returns 400 for invalid since timestamp', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/changes?teamId=abc&since=not-a-date',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/valid ISO-8601/);
  });

  it('returns changes when documents exist', async () => {
    const now = new Date('2026-03-15T10:00:00Z');
    const mockRows = [
      {
        id: 'doc-1',
        title: 'API Auth Guide',
        updatedAt: now,
        stage: 'implementation',
      },
      {
        id: 'doc-2',
        title: 'Getting Started',
        updatedAt: new Date('2026-03-15T09:00:00Z'),
        stage: 'definition',
      },
    ];

    mockLimit.mockResolvedValueOnce(mockRows);

    const res = await app.inject({
      method: 'GET',
      url: '/changes?teamId=team-1&since=2026-03-14T00:00:00Z',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.changes).toHaveLength(2);
    expect(body.changes[0].id).toBe('doc-1');
    expect(body.changes[0].title).toBe('API Auth Guide');
    expect(body.since).toBe('2026-03-14T00:00:00.000Z');
    expect(body.until).toBe('2026-03-15T10:00:00.000Z');
  });

  it('returns empty changes with since echoed as until when no docs match', async () => {
    mockLimit.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/changes?teamId=team-1&since=2026-03-14T00:00:00Z',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.changes).toHaveLength(0);
    expect(body.until).toBe('2026-03-14T00:00:00.000Z');
  });

  it('respects the limit parameter', async () => {
    mockLimit.mockResolvedValueOnce([]);

    await app.inject({
      method: 'GET',
      url: '/changes?teamId=team-1&since=2026-03-14T00:00:00Z&limit=10',
    });

    expect(mockLimit).toHaveBeenCalledWith(10);
  });

  it('caps limit at 200', async () => {
    mockLimit.mockResolvedValueOnce([]);

    await app.inject({
      method: 'GET',
      url: '/changes?teamId=team-1&since=2026-03-14T00:00:00Z&limit=999',
    });

    expect(mockLimit).toHaveBeenCalledWith(200);
  });
});
