import type { FastifyPluginAsync } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, integrations } from '../db/schema.js';
import { config } from '../lib/config.js';
import { aiService } from '../services/ai.service.js';
import { githubService } from '../services/github.service.js';
import { ticketService } from '../services/ticket.service.js';
import { timelineService } from '../services/timeline.service.js';
import { auditService } from '../services/audit.service.js';
import { claudeInsightsService } from '../services/claude-insights.service.js';
import { githubPushPayload, githubIssuesPayload, githubIssueCommentPayload } from '@nyx/shared';

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
    const rawBody = JSON.stringify(request.body);

    // Parse repo full_name from payload for per-integration secret lookup
    const payload = request.body as { repository?: { full_name?: string } };
    const repoFullName = payload.repository?.full_name;

    // Per-integration signature verification
    let verified = false;
    let matchedIntegration: { teamId: string; config: Record<string, unknown> } | null = null;

    if (repoFullName && signature) {
      // Look up integration whose selectedRepos contains this repo
      const allIntegrations = await db.select().from(integrations).where(eq(integrations.type, 'github'));
      for (const integration of allIntegrations) {
        const cfg = integration.config as { selectedRepos?: Array<{ fullName: string }>; webhookSecret?: string };
        const hasRepo = cfg.selectedRepos?.some((r) => r.fullName === repoFullName);
        if (hasRepo && cfg.webhookSecret) {
          if (verifyGitHubSignature(rawBody, signature, cfg.webhookSecret)) {
            verified = true;
            matchedIntegration = { teamId: integration.teamId, config: integration.config as Record<string, unknown> };
            break;
          }
        }
      }
    }

    // Fall back to global GITHUB_WEBHOOK_SECRET for backward compat
    if (!verified && config.GITHUB_WEBHOOK_SECRET) {
      if (!signature) {
        reply.code(401);
        return { error: 'Missing webhook signature' };
      }
      if (!verifyGitHubSignature(rawBody, signature, config.GITHUB_WEBHOOK_SECRET)) {
        reply.code(401);
        return { error: 'Invalid webhook signature' };
      }
      verified = true;
    } else if (!verified) {
      reply.code(401);
      return { error: 'Webhook secret not configured. Set GITHUB_WEBHOOK_SECRET or configure per-integration webhook secrets.' };
    }

    if (event === 'push') {
      githubPushPayload.parse(request.body);
      const result = githubService.handlePushWebhook(request.body);
      request.log.info(
        { ref: result.ref, changedFiles: result.changedFiles, commitCount: result.commits.length },
        'Received push webhook',
      );

      // Fire-and-forget: drift detection
      if (repoFullName) {
        setImmediate(async () => {
          try {
            // Find integrations linked to this repo via selectedRepos
            const allIntegrations = await db.select().from(integrations).where(eq(integrations.type, 'github'));
            for (const integration of allIntegrations) {
              const cfg = integration.config as { selectedRepos?: Array<{ fullName: string }>; accessToken?: string };
              const hasRepo = cfg.selectedRepos?.some((r) => r.fullName === repoFullName);
              if (!hasRepo) continue;

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

    if (event === 'issues') {
      const body = githubIssuesPayload.parse(request.body);

      if (body.issue) {
        const externalId = String(body.issue.number);
        let newStatus: 'open' | 'in_progress' | 'closed';

        if (body.action === 'closed') {
          newStatus = 'closed';
        } else if (body.action === 'reopened' || body.action === 'opened') {
          newStatus = 'open';
        } else {
          // For other actions (labeled, assigned, etc.), derive from state
          newStatus = body.issue.state === 'closed' ? 'closed' : 'open';
        }

        // Fire-and-forget: update matching ticket
        setImmediate(async () => {
          try {
            await ticketService.updateStatusByExternalId(externalId, 'github', newStatus);
          } catch {
            // Best-effort
          }
        });
      }

      return { ok: true, event };
    }

    if (event === 'issue_comment') {
      const body = githubIssueCommentPayload.parse(request.body);

      // Only process newly created comments
      if (body.action === 'created' && body.comment && body.issue && body.repository) {
        const owner = body.repository.owner?.login ?? '';
        const repo = body.repository.name ?? '';
        const issueNumber = body.issue.number;

        // Fire-and-forget: update Claude insight for matching tickets
        setImmediate(async () => {
          try {
            await claudeInsightsService.handleIssueCommentWebhook(
              owner,
              repo,
              issueNumber,
              body.comment!,
            );
          } catch {
            // Best-effort
          }
        });
      }

      return { ok: true, event };
    }

    // For non-push events, acknowledge but take no action
    request.log.info({ event }, 'Received non-push webhook event');
    return { ok: true, event, message: 'Event received but not processed' };
  });
};
