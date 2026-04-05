import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

const { mockAiService, mockDb } = vi.hoisted(() => ({
  mockAiService: {
    generatePodcastScript: vi.fn(),
  },
  mockDb: {
    select: vi.fn(),
  },
const { mockAiService } = vi.hoisted(() => ({
  mockAiService: {
    generatePodcastScript: vi.fn(),
  },
}));

vi.mock('../../services/ai.service.js', () => ({
  aiService: mockAiService,
}));

vi.mock('../../db/index.js', () => ({
  db: mockDb,
}));

>>>>>>> feat/issue-141-multi-agent-orchestration
import { podcastRoutes, _resetPodcastScripts } from '../../routes/podcast.js';

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
  app.register(podcastRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

const mockScriptResult = {
  title: 'Test Podcast Episode',
  script: [
    { speaker: 'Host A' as const, text: 'Welcome to the show!' },
    { speaker: 'Host B' as const, text: 'Great to be here.' },
    { speaker: 'Host A' as const, text: 'Today we discuss testing.' },
  ],
  qualityScore: 8,
  suggestions: ['Add more examples', 'Include diagrams'],
};

describe('Podcast Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPodcastScripts();
<<<<<<< HEAD

    // Default: db.select().from().where() returns matching docs
    const mockWhere = vi.fn().mockResolvedValue([
      { id: 'doc-1', title: 'Doc One', content: 'Content one' },
      { id: 'doc-2', title: 'Doc Two', content: 'Content two' },
    ]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.select.mockReturnValue({ from: mockFrom });
=======
  });

  describe('POST /api/podcast/generate', () => {
    it('generates a podcast script from document IDs', async () => {
      mockAiService.generatePodcastScript.mockResolvedValue(mockScriptResult);

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/podcast/generate',
        payload: {
          documentIds: ['doc-1', 'doc-2'],
          teamId: 'team-1',
          title: 'My Podcast',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBeDefined();
      expect(body.title).toBe('Test Podcast Episode');
      expect(body.script).toHaveLength(3);
      expect(body.qualityScore).toBe(8);
      expect(body.suggestions).toHaveLength(2);
      expect(body.teamId).toBe('team-1');
      expect(body.documentIds).toEqual(['doc-1', 'doc-2']);
      expect(mockAiService.generatePodcastScript).toHaveBeenCalledWith(
        '# Doc One\n\nContent one\n\n---\n\n# Doc Two\n\nContent two',
        'Documents: doc-1, doc-2',
        'My Podcast',
      );
    });

    it('works without optional title', async () => {
      mockAiService.generatePodcastScript.mockResolvedValue(mockScriptResult);

      const mockWhere = vi.fn().mockResolvedValue([
        { id: 'doc-1', title: 'Doc One', content: 'Content one' },
      ]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      mockDb.select.mockReturnValue({ from: mockFrom });

>>>>>>> feat/issue-141-multi-agent-orchestration
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/podcast/generate',
        payload: {
          documentIds: ['doc-1'],
          teamId: 'team-1',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockAiService.generatePodcastScript).toHaveBeenCalledWith(
<<<<<<< HEAD
        '# Doc One\n\nContent one',
=======
        'Documents: doc-1',
        undefined,
      );
    });

    it('returns 400 when teamId is missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/podcast/generate',
        payload: { documentIds: ['doc-1'] },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });

    it('returns 400 when documentIds is missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/podcast/generate',
        payload: { teamId: 'team-1' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });

    it('returns 400 when documentIds is empty', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/podcast/generate',
        payload: { teamId: 'team-1', documentIds: [] },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });
  });

  describe('GET /api/podcast/scripts', () => {
    it('returns scripts filtered by teamId', async () => {
      mockAiService.generatePodcastScript.mockResolvedValue(mockScriptResult);

<<<<<<< HEAD
      const mockWhere = vi.fn().mockResolvedValue([
        { id: 'doc-1', title: 'Doc One', content: 'Content one' },
      ]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      mockDb.select.mockReturnValue({ from: mockFrom });

=======
>>>>>>> feat/issue-141-multi-agent-orchestration
      const app = await buildApp();

      // Generate a script first
      await app.inject({
        method: 'POST',
        url: '/api/podcast/generate',
        payload: { documentIds: ['doc-1'], teamId: 'team-1' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/podcast/scripts?teamId=team-1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.scripts).toHaveLength(1);
      expect(body.scripts[0].teamId).toBe('team-1');
    });

    it('returns empty array for team with no scripts', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/podcast/scripts?teamId=team-99',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.scripts).toHaveLength(0);
    });

    it('returns 400 when teamId is missing', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/podcast/scripts',
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });
  });
});
