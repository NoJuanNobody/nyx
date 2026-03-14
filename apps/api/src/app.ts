import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { documentRoutes } from './routes/documents.js';
import { versionRoutes, documentVersionRoutes } from './routes/versions.js';
import { teamRoutes } from './routes/teams.js';
import { integrationRoutes } from './routes/integrations.js';
import { ticketRoutes } from './routes/tickets.js';
import { webhookRoutes } from './routes/webhooks.js';
import { timelineRoutes } from './routes/timeline.js';
import { snapshotRoutes } from './routes/snapshots.js';
import { aiRoutes } from './routes/ai.js';
import { exportRoutes } from './routes/export.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { branchRoutes } from './routes/branches.js';
import { suggestionRoutes } from './routes/suggestions.js';
import { changeProposalRoutes } from './routes/change-proposals.js';
import { auditRoutes } from './routes/audit.js';
import { agentRoutes } from './routes/agent.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { userRoutes } from './routes/users.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { templateRoutes } from './routes/templates.js';
import { mockupRoutes, setMockupCluster } from './routes/mockups.js';
import { feedbackRoutes } from './routes/feedback.js';
import { authMiddleware } from './middleware/auth.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: true, credentials: true });
  app.register(cookie);

  // Auth middleware — decorates request.user on every request
  app.register(authMiddleware);

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: '/api/auth' });
  app.register(documentRoutes, { prefix: '/api/documents' });
  app.register(documentVersionRoutes, { prefix: '/api/documents' });
  app.register(timelineRoutes, { prefix: '/api/documents' });
  app.register(versionRoutes, { prefix: '/api/versions' });
  app.register(teamRoutes, { prefix: '/api/teams' });
  app.register(integrationRoutes, { prefix: '/api/integrations' });
  app.register(ticketRoutes, { prefix: '/api' });
  app.register(webhookRoutes, { prefix: '/api/webhooks' });
  app.register(snapshotRoutes, { prefix: '/api/snapshots' });
  app.register(aiRoutes, { prefix: '/api/ai' });
  app.register(exportRoutes, { prefix: '/api' });
  app.register(onboardingRoutes, { prefix: '/api/onboarding' });
  app.register(branchRoutes, { prefix: '/api/documents' });
  app.register(suggestionRoutes, { prefix: '/api' });
  app.register(changeProposalRoutes, { prefix: '/api' });
  app.register(auditRoutes, { prefix: '/api' });
  app.register(agentRoutes, { prefix: '/api/agent' });
  app.register(apiKeyRoutes, { prefix: '/api/api-keys' });
  app.register(userRoutes, { prefix: '/api/users' });
  app.register(waitlistRoutes, { prefix: '/api/waitlist' });
  app.register(templateRoutes, { prefix: '/api/templates' });
  app.register(mockupRoutes, { prefix: '/api/mockups' });
  app.register(feedbackRoutes, { prefix: '/api/feedback' });

  return app;
}

export async function initPuppeteerCluster() {
  try {
    const { Cluster } = await import('puppeteer-cluster');
    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_CONTEXT,
      maxConcurrency: 4,
    });
    setMockupCluster(cluster);
    return cluster;
  } catch (err) {
    console.warn('Puppeteer cluster initialization failed:', err);
    return null;
  }
}
