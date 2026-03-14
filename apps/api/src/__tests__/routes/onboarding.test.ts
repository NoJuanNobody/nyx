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

  it('POST /api/onboarding/scan with x-github-token scans repo', async () => {
    mockOnboardingService.scanRepository.mockResolvedValueOnce({
      files: [],
      suggestedDocs: '',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/scan',
      payload: { owner: 'test', repo: 'repo' },
      headers: { 'x-github-token': 'ghp_test' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockOnboardingService.scanRepository).toHaveBeenCalledWith(
      'ghp_test',
      'test',
      'repo',
    );
    await app.close();
  });

  it('POST /api/onboarding/scan returns scanned result', async () => {
    const scanResult = {
      files: [{ path: 'README.md', content: '# Hello' }],
      suggestedDocs: 'Some AI-generated docs',
    };
    mockOnboardingService.scanRepository.mockResolvedValueOnce(scanResult);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/scan',
      payload: { owner: 'myorg', repo: 'myrepo' },
      headers: { 'x-github-token': 'ghp_abc123' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.files).toHaveLength(1);
    expect(body.suggestedDocs).toBe('Some AI-generated docs');
    await app.close();
  });
});
