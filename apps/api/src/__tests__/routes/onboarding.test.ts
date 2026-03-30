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

// Helper to make mockDb.insert().values().returning() resolve with given docs
function mockDbInsertReturning(doc: { id: string; title: string; path: string }) {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve([{ ...doc, content: '', teamId: 'team-1', createdById: 'user-1' }]));
  chain.then = (resolve: (v: unknown) => void) =>
    Promise.resolve([{ ...doc, content: '', teamId: 'team-1', createdById: 'user-1' }]).then(resolve);
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
});
