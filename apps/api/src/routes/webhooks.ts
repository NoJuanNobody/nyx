import type { FastifyPluginAsync } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, integrations } from '../db/schema.js';
import { config } from '../lib/config.js';
import { aiService } from '../services/ai.service.js';
import { githubService } from '../services/github.service.js';
import { timelineService } from '../services/timeline.service.js';
import { auditService } from '../services/audit.service.js';

function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // We need the raw body for signature verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // POST /api/webhooks/github — receives GitHub push webhooks
  app.post('/github', async (request, reply) => {
    const event = request.headers['x-github-event'] as string | undefined;
    const signature = request.headers['x-hub-signature-256'] as string | undefined;

    // Signature verification
    if (config.GITHUB_WEBHOOK_SECRET) {
      if (!signature) {
        reply.code(401);
        return { error: 'Missing webhook signature' };
      }

      const rawBody = JSON.stringify(request.body);
      if (!verifyGitHubSignature(rawBody, signature, config.GITHUB_WEBHOOK_SECRET)) {
        reply.code(401);
        return { error: 'Invalid webhook signature' };
      }
    } else if (config.NODE_ENV === 'production') {
      reply.code(401);
      return { error: 'Webhook signature verification is required in production' };
    } else {
      request.log.warn('GITHUB_WEBHOOK_SECRET not configured — skipping signature verification');
    }

    if (event === 'push') {
      const result = githubService.handlePushWebhook(request.body);
      request.log.info(
        { ref: result.ref, changedFiles: result.changedFiles, commitCount: result.commits.length },
        'Received push webhook',
      );

      // Fire-and-forget: drift detection
      const payload = request.body as { repository?: { full_name?: string } };
      const repoFullName = payload.repository?.full_name;
      if (repoFullName) {
        setImmediate(async () => {
          try {
            // Find integrations linked to this repo
            const allIntegrations = await db.select().from(integrations).where(eq(integrations.type, 'github'));
            for (const integration of allIntegrations) {
              const cfg = integration.config as { owner?: string; repo?: string; accessToken?: string };
              if (`${cfg.owner}/${cfg.repo}` !== repoFullName) continue;

              // Get team documents
              const teamDocs = await db.select().from(documents).where(eq(documents.teamId, integration.teamId));
              for (const doc of teamDocs) {
                try {
                  const driftResult = await aiService.detectDrift(doc.content, result.changedFiles.join('\n'));
                  if (driftResult.hasDrift) {
                    await timelineService.create({
                      documentId: doc.id,
                      type: 'drift_detected',
                      payload: {
                        driftScore: driftResult.driftScore,
                        details: driftResult.details,
                        ref: result.ref,
                        commitCount: result.commits.length,
                      },
                    });
                  }
                } catch (err) {
                  // Drift detection is best-effort; log and continue
                }
              }

              // Record code_push event + audit trail for all team docs
              for (const doc of teamDocs) {
                await timelineService.create({
                  documentId: doc.id,
                  type: 'code_push',
                  payload: {
                    ref: result.ref,
                    commits: result.commits.length,
                    changedFiles: result.changedFiles,
                  },
                });

                // Audit trail for each commit
                for (const commit of result.commits) {
                  try {
                    await auditService.recordEvent({
                      teamId: integration.teamId,
                      eventType: 'code_commit',
                      documentId: doc.id,
                      commitSha: commit.id,
                      metadata: { message: commit.message, ref: result.ref, author: commit.author },
                    });
                  } catch {}
                }
              }
            }
          } catch (err) {
            // Best-effort; don't crash on webhook processing errors
          }
        });
      }

      return { ok: true, ...result };
    }

    // For non-push events, acknowledge but take no action
    request.log.info({ event }, 'Received non-push webhook event');
    return { ok: true, event, message: 'Event received but not processed' };
  });
};
