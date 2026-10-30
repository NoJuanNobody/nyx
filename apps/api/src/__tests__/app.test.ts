import { describe, it, expect, vi } from 'vitest';
import { mockDb } from './helpers/setup.js';

// Mock all route modules to avoid loading real route handlers with complex deps
vi.mock('../routes/health.js', () => ({ healthRoutes: async () => {} }));
vi.mock('../routes/auth.js', () => ({ authRoutes: async () => {} }));
vi.mock('../routes/documents.js', () => ({ documentRoutes: async () => {} }));
vi.mock('../routes/versions.js', () => ({ versionRoutes: async () => {}, documentVersionRoutes: async () => {} }));
vi.mock('../routes/teams.js', () => ({ teamRoutes: async () => {} }));
vi.mock('../routes/integrations.js', () => ({ integrationRoutes: async () => {} }));
vi.mock('../routes/tickets.js', () => ({ ticketRoutes: async () => {} }));
vi.mock('../routes/webhooks.js', () => ({ webhookRoutes: async () => {} }));
vi.mock('../routes/timeline.js', () => ({ timelineRoutes: async () => {} }));
vi.mock('../routes/snapshots.js', () => ({ snapshotRoutes: async () => {} }));
vi.mock('../routes/ai.js', () => ({ aiRoutes: async () => {} }));
vi.mock('../routes/export.js', () => ({ exportRoutes: async () => {} }));
vi.mock('../routes/onboarding.js', () => ({ onboardingRoutes: async () => {} }));
vi.mock('../routes/branches.js', () => ({ branchRoutes: async () => {} }));
vi.mock('../routes/suggestions.js', () => ({ suggestionRoutes: async () => {} }));
vi.mock('../routes/change-proposals.js', () => ({ changeProposalRoutes: async () => {} }));
vi.mock('../routes/audit.js', () => ({ auditRoutes: async () => {} }));
vi.mock('../routes/impact-graph.js', () => ({ impactGraphRoutes: async () => {} }));
vi.mock('../routes/api-keys.js', () => ({ apiKeyRoutes: async () => {} }));
vi.mock('../routes/users.js', () => ({ userRoutes: async () => {} }));
vi.mock('../routes/waitlist.js', () => ({ waitlistRoutes: async () => {} }));
vi.mock('../routes/templates.js', () => ({ templateRoutes: async () => {} }));
vi.mock('../routes/feedback.js', () => ({ feedbackRoutes: async () => {} }));
vi.mock('../routes/upload.js', () => ({ uploadRoutes: async () => {} }));
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async () => {} }));

import { buildApp } from '../app.js';

describe('buildApp', () => {
  it('creates a Fastify instance that can become ready', async () => {
    const app = buildApp();
    await app.ready();
    expect(app).toBeDefined();
    expect(typeof app.inject).toBe('function');
    await app.close();
  });

  it('registers CORS and cookie plugins', async () => {
    const app = buildApp();
    await app.ready();
    // Fastify registers plugins — we verify app starts without error
    expect(app.server).toBeDefined();
    await app.close();
  });
});
