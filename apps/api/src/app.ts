import * as Sentry from '@sentry/node';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import rawBody from 'fastify-raw-body';
import { ZodError } from 'zod';
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
import { traceRoutes } from './routes/trace.js';
import { agentRoutes } from './routes/agent.js';
import { agentRegistryRoutes } from './routes/agent-registry.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { userRoutes } from './routes/users.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { templateRoutes } from './routes/templates.js';
import { lifecycleRoutes } from './routes/lifecycles.js';
import { feedbackRoutes } from './routes/feedback.js';
import { intakeRoutes } from './routes/intake.js';
import { sprintRoutes } from './routes/sprint.js';
import { podcastRoutes } from './routes/podcast.js';
import { contextRoutes } from './routes/context.js';
import { audioRoutes } from './routes/audio.js';
import { slackRoutes } from './routes/slack.js';
import { impactGraphRoutes } from './routes/impact-graph.js';
import { invitationRoutes } from './routes/invitations.js';
import { notificationRoutes } from './routes/notifications.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { featureRequestRoutes } from './routes/feature-requests.js';
import { projectShowcaseRoutes } from './routes/project-showcases.js';
import { governanceRoutes } from './routes/governance.js';
import { permissionRoutes } from './routes/permissions.js';
import { docChangesRoutes } from './routes/doc-changes.js';
import { orchestrationRoutes } from './routes/orchestration.js';
import { observabilityRoutes } from './routes/observability.js';
import { deliverableRoutes, deliverableSingleRoutes } from './routes/deliverables.js';
import { searchRoutes } from './routes/search.js';
import { voiceRoutes } from './routes/voice.js';
import { voiceTranscriptionRoutes } from './routes/voice-transcription.js';
import { voiceDocumentRoutes } from './routes/voice-documents.js';
import { voiceWebhookRoutes } from './routes/voice-webhooks.js';
import { uploadRoutes } from './routes/upload.js';
import { pcbRoutes } from './routes/pcb.js';
import { socialRoutes } from './routes/social.js';
import { billingRoutes } from './routes/billing.js';
import { planRoutes } from './routes/plan.js';
import { creditRoutes } from './routes/credits.js';
import { pipelineRoutes } from './routes/pipelines.js';
import { videoGenerationRoutes } from './routes/video-generation.js';
import { adminRoutes } from './routes/admin.js';
import { aiKeyRoutes } from './routes/ai-keys.js';
import { atlassianRoutes } from './routes/integrations/atlassian.js';
import { jobRoutes } from './routes/jobs.js';
import { wsRoutes } from './routes/ws.js';
import { approvalRoutes } from './routes/approvals.js';
import { queryRoutes } from './routes/query.js';
import { retrievalRoutes } from './routes/retrieval.js';
import { complianceRoutes } from './routes/compliance.js';
import { scannerRoutes } from './routes/scanner.js';
import { authMiddleware } from './middleware/auth.js';
import { config } from './lib/config.js';
import { isOriginAllowed } from './lib/cors.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  // Surface degraded modes early so operators don't have to read source code
  // to understand why every synced repo shows as "Disconnected".
  if (!config.WEBHOOK_BASE_URL) {
    app.log.warn(
      'WEBHOOK_BASE_URL not configured — GitHub webhook registration is disabled; all synced repos will appear Disconnected',
    );
  }

  app.register(cors, {
    // The allowlist (incl. regex entries for Vercel preview URLs) lives in
    // lib/cors.ts so SSE routes that write raw responses can share it.
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS: origin not allowed'), false);
      }
    },
    // @fastify/cors v11 defaults `methods` to 'GET,HEAD,POST', which silently
    // blocks PUT/PATCH/DELETE preflight requests. This went unnoticed while the
    // web app called the API through a same-origin Vercel proxy rewrite; after
    // switching to direct cross-origin calls (VITE_API_URL) the preflight is
    // enforced, so the full method set must be declared explicitly.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://clerk.nyx-creative.com", "https://accounts.nyx-creative.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'", "https://api.anthropic.com", "https://fonts.googleapis.com", "https://clerk.nyx-creative.com", "https://accounts.nyx-creative.com"],
        imgSrc: ["'self'", "data:", "https:"],
        frameSrc: ["'self'", "blob:", "https://accounts.nyx-creative.com"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  });
  app.register(cookie);
  app.register(websocket);

  // Raw body support — required for Stripe webhook signature verification
  app.register(rawBody, {
    field: 'rawBody',
    global: false,
    runFirst: true,
    encoding: 'utf8',
  });

  // Global rate limiting — 200 requests per minute per user (or IP for unauthenticated)
  app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      return (request as any).user?.id ?? request.ip;
    },
    allowList: (request) => {
      const url = request.url;
      return url.startsWith('/health') || url.startsWith('/api/webhooks/');
    },
  });

  // Global error handler — Zod validation errors → 400
  app.setErrorHandler((error: Error & { validation?: unknown }, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: 'Validation failed',
        details: error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      });
      return;
    }
    if (error.validation) {
      reply.code(400).send({ error: error.message });
      return;
    }
    Sentry.captureException(error);
    request.log.error({ err: error, stack: error.stack }, 'Unhandled error');
    reply.code(500).send({ error: 'Internal server error' });
  });

  // Auth middleware — decorates request.user on every request
  app.register(authMiddleware);

  // ── Global auth enforcement ────────────────────────────
  // Safety-net hook: after the auth middleware has had a chance to populate
  // request.user, reject any non-public route that still has no user.
  const PUBLIC_PREFIXES = [
    '/health',
    '/api/webhooks/',
    '/api/waitlist',
    '/api/slack/callback',
    '/api/slack/command',
    '/api/slack/events',
    '/api/integrations/github/callback',
    '/api/integrations/gitlab/callback',
    '/api/integrations/bitbucket/callback',
    '/api/integrations/atlassian/callback',
    '/api/ws',
  ];

  app.addHook('preHandler', async (request, reply) => {
    const url = request.routeOptions?.url ?? request.url;

    if (PUBLIC_PREFIXES.some(prefix => url.startsWith(prefix))) {
      return;
    }

    // If no user after auth middleware ran, reject
    if (!request.user) {
      reply.code(401).send({ error: 'Authentication required' });
    }
  });

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
  app.register(traceRoutes, { prefix: '/api' });
  app.register(agentRoutes, { prefix: '/api/agent' });
  app.register(agentRegistryRoutes, { prefix: '/api/agent/registry' });
  app.register(apiKeyRoutes, { prefix: '/api/api-keys' });
  app.register(userRoutes, { prefix: '/api/users' });
  app.register(waitlistRoutes, { prefix: '/api/waitlist' });
  app.register(templateRoutes, { prefix: '/api/templates' });
  app.register(lifecycleRoutes, { prefix: '/api/lifecycles' });
  app.register(feedbackRoutes, { prefix: '/api/feedback' });
  app.register(intakeRoutes, { prefix: '/api/intake' });
  app.register(sprintRoutes, { prefix: '/api' });
  app.register(podcastRoutes, { prefix: '/api' });
  app.register(contextRoutes, { prefix: '/api/intake' });
  app.register(audioRoutes, { prefix: '/api/intake' });
  app.register(slackRoutes, { prefix: '/api/slack' });
  app.register(impactGraphRoutes, { prefix: '/api' });
  app.register(invitationRoutes, { prefix: '/api/invitations' });
  app.register(notificationRoutes, { prefix: '/api/notifications' });
  app.register(subscriptionRoutes, { prefix: '/api/subscriptions' });
  app.register(featureRequestRoutes, { prefix: '/api/feature-requests' });
  app.register(projectShowcaseRoutes, { prefix: '/api/project-showcases' });
  app.register(governanceRoutes, { prefix: '/api/governance' });
  app.register(permissionRoutes, { prefix: '/api/permissions' });
  app.register(docChangesRoutes, { prefix: '/api/documents' });
  app.register(orchestrationRoutes, { prefix: '/api/orchestration' });
  app.register(observabilityRoutes, { prefix: '/api/observability' });
  app.register(deliverableRoutes, { prefix: '/api/documents' });
  app.register(deliverableSingleRoutes, { prefix: '/api/deliverables' });
  app.register(searchRoutes, { prefix: '/api/search' });
  app.register(voiceRoutes, { prefix: '/api/voice' });
  app.register(voiceTranscriptionRoutes, { prefix: '/api/voice' });
  app.register(voiceDocumentRoutes, { prefix: '/api/voice' });
  app.register(voiceWebhookRoutes, { prefix: '/api/voice' });
  app.register(uploadRoutes, { prefix: '/api/documents' });
  app.register(pcbRoutes, { prefix: '/api/documents' });
  app.register(socialRoutes, { prefix: '/api/documents' });
  app.register(billingRoutes, { prefix: '/api/billing' });
  app.register(planRoutes, { prefix: '/api/plan' });
  app.register(creditRoutes, { prefix: '/api/credits' });
  app.register(pipelineRoutes, { prefix: '/api/pipelines' });
  app.register(videoGenerationRoutes, { prefix: '/api/video' });
  app.register(adminRoutes, { prefix: '/api/admin' });
  app.register(aiKeyRoutes, { prefix: '/api/teams' });
  app.register(atlassianRoutes, { prefix: '/api/integrations' });
  app.register(jobRoutes, { prefix: '/api' });
  app.register(wsRoutes, { prefix: '/api/ws' });
  app.register(approvalRoutes, { prefix: '/api' });
  app.register(queryRoutes, { prefix: '/api/query' });
  app.register(retrievalRoutes, { prefix: '/api/retrieve' });
  app.register(complianceRoutes, { prefix: '/api/compliance' });
  app.register(scannerRoutes, { prefix: '/api/scanner' });

  return app;
}
