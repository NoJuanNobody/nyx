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

// Helper to make mockDb.insert().values().returning() resolve with given docs.
// Captures the values passed to `.values(...)` so tests can assert on them.
function mockDbInsertReturning(
  doc: { id: string; title: string; path: string },
  capturedValues?: Array<Record<string, unknown>>,
) {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn((vals: Record<string, unknown>) => {
    capturedValues?.push(vals);
    return chain;
  });
  const resolved = [
    {
      ...doc,
      content: '',
      teamId: 'team-1',
      createdById: 'user-1',
      stage: 'implementation',
    },
  ];
  chain.returning = vi.fn(() => Promise.resolve(resolved));
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(resolved).then(resolve);
  return chain;
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

    // Mock db.insert for the overview doc
    let insertCallCount = 0;
    mockDb.insert.mockImplementation(() => {
      insertCallCount++;
      return mockDbInsertReturning({
        id: `doc-${insertCallCount}`,
        title: 'test/repo Overview',
        path: '/repos/test/repo',
      });
    });

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

    let insertCallCount = 0;
    mockDb.insert.mockImplementation(() => {
      insertCallCount++;
      const titles = ['Services', 'Components', 'myorg/myrepo Overview'];
      return mockDbInsertReturning({
        id: `doc-${insertCallCount}`,
        title: titles[insertCallCount - 1] ?? `Doc ${insertCallCount}`,
        path: '/repos/myorg/myrepo',
      });
    });

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

    // Capture every `.values(...)` payload across all insert calls so we can
    // assert on stage for each row written to the documents table.
    const capturedValues: Array<Record<string, unknown>> = [];
    let insertCallCount = 0;
    mockDb.insert.mockImplementation(() => {
      insertCallCount++;
      const titles = ['Auth', 'API', 'Web', 'acme/widgets Overview'];
      return mockDbInsertReturning(
        {
          id: `doc-${insertCallCount}`,
          title: titles[insertCallCount - 1] ?? `Doc ${insertCallCount}`,
          path: '/repos/acme/widgets',
        },
        capturedValues,
      );
    });

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

    // Every captured insert payload must have stage === 'implementation'.
    expect(capturedValues).toHaveLength(4);
    for (const vals of capturedValues) {
      expect(vals.stage).toBe('implementation');
    }

    // Sanity check the per-module insert and the overview insert each
    // received the expected stage.
    const moduleInserts = capturedValues.filter((v) =>
      ['Auth', 'API', 'Web'].includes(v.title as string),
    );
    expect(moduleInserts).toHaveLength(3);
    moduleInserts.forEach((v) => expect(v.stage).toBe('implementation'));

    const overviewInsert = capturedValues.find(
      (v) => v.title === 'acme/widgets Overview',
    );
    expect(overviewInsert).toBeDefined();
    expect(overviewInsert?.stage).toBe('implementation');

    await app.close();
  });
});
