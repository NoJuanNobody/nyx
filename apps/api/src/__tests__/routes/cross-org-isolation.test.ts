/**
 * Cross-org isolation tests (#465)
 *
 * Proves that a user belonging to Team A cannot access Team B's resources.
 *
 * Strategy:
 * - Build per-route Fastify apps WITHOUT mocking requireRole so the real
 *   middleware runs.
 * - Configure mockDb so the membership lookup for Team A's user against
 *   Team B returns an empty array (user is not a member).
 * - Routes guarded by requireRole → 403 "not a member".
 * - The ticket list route has no requireRole guard; its current behaviour
 *   (200 with data) is documented in the test as a known gap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import {
  makeUser,
  makeTeam,
  makeDocument,
  makeIntegration,
  makeTicket,
} from '../helpers/factories.js';
import Fastify from 'fastify';

// ── Hoist service mocks (must precede route imports) ─────────────────

const { mockTicketService } = vi.hoisted(() => ({
  mockTicketService: {
    listByTeam: vi.fn(),
    listByDocument: vi.fn(),
    createFromDocument: vi.fn(),
    syncStatus: vi.fn(),
    updateStatus: vi.fn(),
    syncAllForTeam: vi.fn(),
  },
}));

vi.mock('../../services/ticket.service.js', () => ({
  ticketService: mockTicketService,
}));

vi.mock('../../services/timeline.service.js', () => ({
  timelineService: { create: vi.fn() },
}));

vi.mock('../../services/audit.service.js', () => ({
  auditService: { recordEvent: vi.fn() },
}));

vi.mock('../../services/embedding-pipeline.service.js', () => ({
  embeddingPipelineService: {
    indexDocument: vi.fn(),
    removeDocumentChunks: vi.fn(),
  },
}));

vi.mock('../../services/context-matching.service.js', () => ({
  contextMatchingService: { findRelatedSpecs: vi.fn() },
}));

vi.mock('../../services/github.service.js', () => ({
  GitHubTokenExpiredError: class GitHubTokenExpiredError extends Error {},
  githubService: {
    listRepos: vi.fn(),
    exchangeCodeForToken: vi.fn(),
    getAuthenticatedUser: vi.fn(),
    createWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
  },
}));

vi.mock('../../services/gitlab.service.js', () => ({
  GitLabTokenExpiredError: class GitLabTokenExpiredError extends Error {},
  gitlabService: {
    listRepos: vi.fn(),
    exchangeCodeForToken: vi.fn(),
    getAuthenticatedUser: vi.fn(),
  },
}));

vi.mock('../../services/bitbucket.service.js', () => ({
  BitbucketTokenExpiredError: class BitbucketTokenExpiredError extends Error {},
  bitbucketService: {
    listRepos: vi.fn(),
    exchangeCodeForToken: vi.fn(),
    getAuthenticatedUser: vi.fn(),
  },
}));

vi.mock('../../services/jira.service.js', () => ({
  jiraService: { listProjects: vi.fn() },
}));

vi.mock('../../services/integrations/otter.service.js', () => ({
  otterService: {
    importTranscript: vi.fn(),
    listTranscripts: vi.fn(),
    getTranscript: vi.fn(),
  },
}));

vi.mock('../../services/claude-insights.service.js', () => ({
  claudeInsightsService: {
    getForTicket: vi.fn(),
    refreshForTicket: vi.fn(),
  },
}));

vi.mock('../../services/notification.service.js', () => ({
  notificationService: { create: vi.fn() },
}));

vi.mock('../../services/notification-events.js', () => ({
  NotificationEvents: { TICKET_CREATED: 'ticket_created' },
}));

// ── Route imports (after all vi.mock calls) ───────────────────────────

import { documentRoutes } from '../../routes/documents.js';
import { ticketRoutes } from '../../routes/tickets.js';
import { integrationRoutes } from '../../routes/integrations.js';

// ── Shared fixtures ───────────────────────────────────────────────────

const userA = makeUser({ id: 'user-a-1', email: 'user-a@team-a.com', name: 'User A' });
const teamB = makeTeam({ id: 'team-b-1', name: 'Team B', slug: 'team-b' });
const docB = makeDocument({ id: 'doc-b-1', teamId: teamB.id });
const integrationB = makeIntegration({ id: 'int-b-1', teamId: teamB.id });
const ticketB = makeTicket({ id: 'ticket-b-1' });

// ── App builders ──────────────────────────────────────────────────────

/**
 * Injects userA as the authenticated user; does NOT mock requireRole.
 * requireRole will call mockDb to verify membership, which tests control.
 */
async function buildDocumentApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: userA.id,
      clerkId: userA.clerkId,
      email: userA.email,
      name: userA.name,
      avatarUrl: null,
      role: 'viewer',
    } as any;
  });
  app.register(documentRoutes, { prefix: '/api/documents' });
  await app.ready();
  return app;
}

async function buildTicketApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: userA.id,
      clerkId: userA.clerkId,
      email: userA.email,
      name: userA.name,
      avatarUrl: null,
      role: 'viewer',
    } as any;
  });
  app.register(ticketRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

async function buildIntegrationApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: userA.id,
      clerkId: userA.clerkId,
      email: userA.email,
      name: userA.name,
      avatarUrl: null,
      role: 'viewer',
    } as any;
  });
  app.register(integrationRoutes, { prefix: '/api/integrations' });
  await app.ready();
  return app;
}

// ─────────────────────────────────────────────────────────────────────

describe('Cross-org isolation — Team A cannot access Team B resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Documents ───────────────────────────────────────────────────────

  describe('GET /api/documents?teamId=<teamB>', () => {
    it('returns 403 when the requesting user is not a member of teamB', async () => {
      // requireRole (source: 'request') extracts teamId from query then
      // checks teamMembers. Empty result → user is not a member → 403.
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]), // no membership record found
        }),
      } as any);

      const app = await buildDocumentApp();
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents?teamId=${teamB.id}`,
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/not a member/i);
    });
  });

  describe('GET /api/documents/:id (document owned by teamB)', () => {
    it('returns 403 when the requesting user is not a member of teamB', async () => {
      // requireRole (source: 'document') makes two sequential DB selects:
      //   1. getTeamIdFromDocument → resolve [{ teamId: teamB.id }]
      //   2. getUserTeamRole       → resolve [] (user-a not in team-b)
      let callCount = 0;
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              // document lookup — document exists and belongs to teamB
              return Promise.resolve([{ teamId: teamB.id }]);
            }
            // membership lookup — userA is not a member of teamB
            return Promise.resolve([]);
          }),
        }),
      } as any);

      const app = await buildDocumentApp();
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/${docB.id}`,
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/not a member/i);
    });

    it('returns 404 when the document does not exist (cannot discover teamB membership gap)', async () => {
      // getTeamIdFromDocument returns empty → 404 before any membership check.
      // This also prevents leaking whether a document ID exists in another org.
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const app = await buildDocumentApp();
      const res = await app.inject({
        method: 'GET',
        url: `/api/documents/nonexistent-doc`,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── Tickets ─────────────────────────────────────────────────────────

  describe('GET /api/tickets?teamId=<teamB>', () => {
    it('returns 200 — NOTE: ticket list route has no requireRole guard (known isolation gap)', async () => {
      // The GET /tickets route calls ticketService.listByTeam(teamId) without
      // checking team membership. A cross-org caller who knows teamB's ID can
      // enumerate its tickets. This test documents the current behaviour so
      // that any future fix (adding requireRole) is visible as a change.
      mockTicketService.listByTeam.mockResolvedValue([ticketB]);

      const app = await buildTicketApp();
      const res = await app.inject({
        method: 'GET',
        url: `/api/tickets?teamId=${teamB.id}`,
      });

      // Cross-org request succeeds — data is returned with no membership check.
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(ticketB.id);
      expect(mockTicketService.listByTeam).toHaveBeenCalledWith(
        teamB.id,
        expect.any(Object),
      );
    });
  });

  // ── Integrations ─────────────────────────────────────────────────────

  describe('GET /api/integrations?teamId=<teamB>', () => {
    it('returns 403 when the requesting user is not a member of teamB', async () => {
      // requireRole (source: 'request') checks teamMembers. Empty → 403.
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const app = await buildIntegrationApp();
      const res = await app.inject({
        method: 'GET',
        url: `/api/integrations?teamId=${teamB.id}`,
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/not a member/i);
    });
  });

  describe('GET /api/integrations/:id/github/repos (integration owned by teamB)', () => {
    it('returns 403 when the requesting user is not a member of teamB', async () => {
      // requireRole (source: 'integration') makes two sequential DB selects:
      //   1. getTeamIdFromIntegration → resolve [{ teamId: teamB.id }]
      //   2. getUserTeamRole          → resolve [] (user-a not in team-b)
      let callCount = 0;
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              // integration lookup — belongs to teamB
              return Promise.resolve([{ teamId: teamB.id }]);
            }
            // membership lookup — userA is not a member of teamB
            return Promise.resolve([]);
          }),
        }),
      } as any);

      const app = await buildIntegrationApp();
      const res = await app.inject({
        method: 'GET',
        url: `/api/integrations/${integrationB.id}/github/repos`,
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/not a member/i);
    });

    it('returns 404 when the integration does not exist', async () => {
      // getTeamIdFromIntegration returns empty → 404 before membership check.
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const app = await buildIntegrationApp();
      const res = await app.inject({
        method: 'GET',
        url: `/api/integrations/nonexistent-int/github/repos`,
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
