import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';

const { mockOnboardingService } = vi.hoisted(() => ({
  mockOnboardingService: {
    scanRepository: vi.fn(),
  },
}));

vi.mock('../../services/onboarding.service.js', () => ({
  onboardingService: mockOnboardingService,
}));

vi.mock('../../services/github.service.js', () => ({
  githubService: {
    getGitHubTokenForTeam: vi.fn().mockResolvedValue(null),
  },
}));

import { onboardingRoutes } from '../../routes/onboarding.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: 'clerk_1',
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'admin',
    } as any;
  });
  app.register(onboardingRoutes, { prefix: '/api/onboarding' });
  await app.ready();
  return app;
}

/**
 * Helper to mock a single bulk `db.insert(documents).values([...]).returning()`
 * call. Captures the array passed to `.values(...)` for assertions.
 *
 * The returned mock resolves to an array of doc rows derived from the
 * captured `values` so tests can observe order preservation.
 */
function mockBulkInsert(
  capturedRows: Array<Array<Record<string, unknown>>>,
  basePath: string,
) {
  mockDb.insert.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn((vals: unknown) => {
      const asArray = Array.isArray(vals)
        ? (vals as Array<Record<string, unknown>>)
        : [vals as Record<string, unknown>];
      capturedRows.push(asArray);
      const resolved = asArray.map((row, i) => ({
        id: `doc-${capturedRows.length}-${i + 1}`,
        title: row.title,
        path: row.path ?? basePath,
        content: row.content,
        teamId: row.teamId,
        createdById: row.createdById,
        stage: row.stage,
      }));
      chain.returning = vi.fn(() => Promise.resolve(resolved));
      chain.then = (resolve: (v: unknown) => void) =>
        Promise.resolve(resolved).then(resolve);
      return chain;
    });
    return chain;
  });
}

describe('Onboarding Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /api/onboarding/scan returns 400 without owner or repo', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/scan',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /api/onboarding/scan returns 400 when only owner is provided', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/scan',
      payload: { owner: 'test' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /api/onboarding/scan returns 400 without teamId', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/scan',
      payload: { owner: 'test', repo: 'repo' },
      headers: { 'x-github-token': 'ghp_test' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('teamId is required');
    await app.close();
  });

  it('POST /api/onboarding/scan with x-github-token scans repo and saves docs', async () => {
    mockOnboardingService.scanRepository.mockResolvedValueOnce({
      files: [],
      suggestedDocs: '',
      moduleDocs: [],
      moduleCount: 0,
      fileCount: 0,
    });

    const captured: Array<Array<Record<string, unknown>>> = [];
    mockBulkInsert(captured, '/repos/test/repo');

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/scan',
      payload: { owner: 'test', repo: 'repo', teamId: 'team-1' },
      headers: { 'x-github-token': 'ghp_test' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockOnboardingService.scanRepository).toHaveBeenCalledWith(
      'ghp_test',
      'test',
      'repo',
    );
    const body = JSON.parse(res.body);
    expect(body.documents).toBeDefined();
    expect(body.moduleCount).toBe(0);
    expect(body.fileCount).toBe(0);
    // With no module docs there is still one overview row inserted.
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(1);
    expect(captured[0][0].title).toBe('test/repo Overview');
    await app.close();
  });

  it('POST /api/onboarding/scan returns saved documents with module docs', async () => {
    const scanResult = {
      files: [{ path: 'src/index.ts', content: 'export const main = () => {}' }],
      suggestedDocs: 'Merged docs',
      moduleDocs: [
        { module: 'Services', docs: 'Service docs' },
        { module: 'Components', docs: 'Component docs' },
      ],
      moduleCount: 2,
      fileCount: 1,
    };
    mockOnboardingService.scanRepository.mockResolvedValueOnce(scanResult);

    const captured: Array<Array<Record<string, unknown>>> = [];
    mockBulkInsert(captured, '/repos/myorg/myrepo');

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/scan',
      payload: { owner: 'myorg', repo: 'myrepo', teamId: 'team-1' },
      headers: { 'x-github-token': 'ghp_abc123' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // 2 module docs + 1 overview = 3 documents
    expect(body.documents).toHaveLength(3);
    expect(body.moduleCount).toBe(2);
    expect(body.fileCount).toBe(1);

    // Bulk insert, not N+1
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    // Preserve order: module docs first, then overview
    expect(captured[0].map((r) => r.title)).toEqual([
      'Services',
      'Components',
      'myorg/myrepo Overview',
    ]);
    expect(body.documents.map((d: { title: string }) => d.title)).toEqual([
      'Services',
      'Components',
      'myorg/myrepo Overview',
    ]);
    await app.close();
  });

  it("POST /api/onboarding/scan persists every document with stage 'implementation'", async () => {
    const scanResult = {
      files: [
        { path: 'src/auth/index.ts', content: 'export const auth = () => {}' },
        { path: 'src/api/index.ts', content: 'export const api = () => {}' },
      ],
      suggestedDocs: '# Overview\n\nThis is the merged overview.',
      moduleDocs: [
        { module: 'Auth', docs: '# Auth\n\nAuth module docs.' },
        { module: 'API', docs: '# API\n\nAPI module docs.' },
        { module: 'Web', docs: '# Web\n\nWeb module docs.' },
      ],
      moduleCount: 3,
      fileCount: 2,
    };
    mockOnboardingService.scanRepository.mockResolvedValueOnce(scanResult);

    const captured: Array<Array<Record<string, unknown>>> = [];
    mockBulkInsert(captured, '/repos/acme/widgets');

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/scan',
      payload: { owner: 'acme', repo: 'widgets', teamId: 'team-1' },
      headers: { 'x-github-token': 'ghp_stage_test' },
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    // 3 module docs + 1 overview = 4 documents
    expect(body.documents).toHaveLength(4);

    // Single bulk insert of 4 rows, every row stage === 'implementation'
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(4);
    for (const row of captured[0]) {
      expect(row.stage).toBe('implementation');
    }

    const moduleInserts = captured[0].filter((v) =>
      ['Auth', 'API', 'Web'].includes(v.title as string),
    );
    expect(moduleInserts).toHaveLength(3);
    moduleInserts.forEach((v) => expect(v.stage).toBe('implementation'));

    const overviewInsert = captured[0].find(
      (v) => v.title === 'acme/widgets Overview',
    );
    expect(overviewInsert).toBeDefined();
    expect(overviewInsert?.stage).toBe('implementation');

    await app.close();
  });
});
