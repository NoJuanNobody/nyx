import type { FastifyPluginAsync } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, integrations } from '../db/schema.js';
import { aiService } from '../services/ai.service.js';
import { checkLimit } from '../services/plan-limits.service.js';
import { deductCredits, CREDIT_COSTS } from '../services/credits.service.js';
import { codeEmbeddingService } from '../services/code-embedding.service.js';
import {
  analyzeSpecBody,
  detectDriftBody,
  generateDocumentBody,
  editDocumentBody,
  generateTicketBody,
  meetingQualityBody,
  meetingApplySuggestionsBody,
  generateNewsArticleBody,
  seedFromStageBody,
  missingSectionsBody,
  notificationReplyBody,
  decisionWeightBody,
  seedNextStageBody,
  generateAllBody,
  suggestionsBody,
} from '@nyx/shared';

export const aiRoutes: FastifyPluginAsync = async (app) => {
  // Gate every /api/ai/* endpoint: verify the user's plan allows AI features.
  app.addHook('preHandler', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) return; // global auth hook already handles unauthenticated
    const check = await checkLimit(userId, 'use_ai');
    if (!check.allowed) {
      return reply.code(403).send({
        error: 'AI features are not available on your current plan.',
        upgradeRequired: true,
        plan: check.plan,
      });
    }
  });

  // Deduct credits after each successful AI response (2xx status).
  // Route URL suffix maps to a task type in CREDIT_COSTS (e.g. /detect-drift → drift_detection).
  const ROUTE_TO_TASK: Record<string, string> = {
    '/analyze': 'spec_analysis',
    '/detect-drift': 'drift_detection',
    '/generate-document': 'document_generation',
    '/edit-document': 'document_generation',
    '/generate-ticket': 'ticket_generation',
    '/meeting-quality': 'agent_meeting_review',
    '/meeting-apply-suggestions': 'agent_meeting_review',
    '/generate-news-article': 'document_generation',
    '/seed-from-stage': 'document_generation',
    '/missing-sections': 'spec_analysis',
    '/notification-reply': 'agent_custom',
    '/decision-weight': 'spec_analysis',
    '/seed-next-stage': 'document_generation',
    '/suggestions': 'spec_analysis',
    '/generate-all': 'document_generation',
  };
  app.addHook('onSend', async (request, reply) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    const userId = request.user?.id;
    if (!userId) return;
    const routeSuffix = request.url.replace(/\?.*$/, '').replace(/^\/api\/ai/, '');
    const taskType = ROUTE_TO_TASK[routeSuffix];
    if (!taskType) return;
    const cost = CREDIT_COSTS[taskType] ?? 1;
    try {
      await deductCredits(userId, cost, taskType, `AI: ${routeSuffix.replace('/', '')}`);
    } catch {
      // Insufficient credits: log but don't fail the already-sent response
      request.log.warn({ userId, taskType, cost }, 'AI credit deduction failed — insufficient balance');
    }
  });

  // POST /api/ai/analyze — analyze spec quality (stage-aware)
  app.post('/analyze', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { content, stage } = analyzeSpecBody.parse(request.body);
    const result = await aiService.analyzeSpecQuality(content, stage);
    return result;
  });

  // POST /api/ai/detect-drift — detect spec-code drift
  app.post('/detect-drift', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { specContent, codeContent } = detectDriftBody.parse(request.body);
    const result = await aiService.detectDrift(specContent, codeContent);
    return result;
  });

  // POST /api/ai/generate-document — generate a document from a prompt
  app.post('/generate-document', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { prompt } = generateDocumentBody.parse(request.body);
    const result = await aiService.generateDocument(prompt);
    return result;
  });

  // POST /api/ai/edit-document — edit a document with AI
  app.post('/edit-document', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { content, instruction, history, documentId, teamId } =
      editDocumentBody.parse(request.body);

    // If caller asked for grounded mode, retrieve relevant code from the
    // team's indexed codebase. All failure modes are non-fatal — a failure
    // simply means we fall back to the ungrounded-but-conservative prompt.
    let codeContents: Array<{ path: string; content: string }> = [];
    let groundingSources: string[] = [];
    if (documentId && teamId) {
      try {
        const retrieved = await codeEmbeddingService.fetchRelevantCodeForDocument(
          documentId,
          teamId,
        );
        codeContents = retrieved.chunks;
        groundingSources = retrieved.sources;
      } catch (err) {
        request.log.warn(
          { err },
          '[ai/edit-document] grounded retrieval failed — falling back to ungrounded',
        );
      }
    }

    const result = await aiService.editDocument(
      content,
      instruction,
      history,
      codeContents,
    );

    const grounded = codeContents.length > 0;
    return {
      content: result,
      grounded,
      ...(grounded ? { groundingSources } : {}),
    };
  });

  // POST /api/ai/generate-ticket — generate a ticket from a spec diff
  app.post('/generate-ticket', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { diff, context } = generateTicketBody.parse(request.body);
    const result = await aiService.generateTicketFromDiff(diff, context);
    return result;
  });

  // POST /api/ai/meeting-quality — analyze meeting note quality
  app.post('/meeting-quality', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { content } = meetingQualityBody.parse(request.body);
    const result = await aiService.analyzeMeetingNoteQuality(content);
    return result;
  });

  // POST /api/ai/meeting-apply-suggestions — apply improvement suggestions to meeting notes
  app.post('/meeting-apply-suggestions', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { content, suggestions } = meetingApplySuggestionsBody.parse(request.body);
    const result = await aiService.applyMeetingSuggestions(content, suggestions);
    return { content: result };
  });

  // POST /api/ai/generate-news-article — generate a New York Post style news article
  app.post('/generate-news-article', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { topic, context } = generateNewsArticleBody.parse(request.body);
    const result = await aiService.generateNewsArticle(topic, context);
    return result;
  });

  // POST /api/ai/seed-from-stage — generate pre-filled content for the next lifecycle stage (document-based)
  app.post('/seed-from-stage', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { content, fromStage, toStage } = seedFromStageBody.parse(request.body);
    const result = await aiService.seedNextStage(content, fromStage, toStage);
    return result;
  });

  // POST /api/ai/missing-sections — analyze content for missing sections
  app.post('/missing-sections', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { content, stage } = missingSectionsBody.parse(request.body);
    const result = await aiService.analyzeMissingSections(content, stage);
    return result;
  });

  // POST /api/ai/notification-reply — process user reply to a notification
  app.post('/notification-reply', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { notificationId, message, documentId, content } = notificationReplyBody.parse(request.body);
    const result = await aiService.notificationReply(
      notificationId,
      message,
      content || '',
    );
    return result;
  });

  // POST /api/ai/decision-weight — estimate the human judgment cost of a spec
  app.post('/decision-weight', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { content, stage } = decisionWeightBody.parse(request.body);
    const result = await aiService.estimateDecisionWeight(content, stage);
    return result;
  });

  // POST /api/ai/seed-next-stage — generate content for the next lifecycle stage
  app.post('/seed-next-stage', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { content, fromStage, toStage } = seedNextStageBody.parse(request.body);
    const result = await aiService.seedNextStage(content, fromStage, toStage);
    return result;
  });

  // POST /api/ai/suggestions — context-aware prompt chips for the AI panel
  app.post(
    '/suggestions',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, _reply) => {
      const input = suggestionsBody.parse(request.body);

      try {
        // Load the document (title + content + stage) scoped to the team.
        const [doc] = await db
          .select({
            id: documents.id,
            title: documents.title,
            content: documents.content,
            stage: documents.stage,
            teamId: documents.teamId,
          })
          .from(documents)
          .where(and(eq(documents.id, input.documentId), eq(documents.teamId, input.teamId)))
          .limit(1);

        if (!doc) {
          // Don't leak existence — just fall back to empty suggestions.
          return { suggestions: [] };
        }

        if (input.kind === 'pre-session') {
          // Optional: fetch relevant code chunks + the connected repo name so
          // the model can reference the codebase when suggesting prompts. All
          // failure modes are non-fatal.
          let codebaseHint: { repoFullName?: string; chunks?: Array<{ path: string; content: string }> } | undefined;
          try {
            const [integration] = await db
              .select({ type: integrations.type, config: integrations.config })
              .from(integrations)
              .where(and(eq(integrations.teamId, input.teamId), eq(integrations.type, 'github')))
              .limit(1);

            if (integration) {
              const ghConfig = integration.config as {
                selectedRepos?: Array<{ owner: string; name: string; fullName: string }>;
                owner?: string;
                repo?: string;
              };
              const repoFullName =
                ghConfig.selectedRepos?.[0]?.fullName ??
                (ghConfig.owner && ghConfig.repo ? `${ghConfig.owner}/${ghConfig.repo}` : undefined);

              // Retrieval is best-effort. If it fails, we still send the
              // repo name alone as a hint.
              let chunks: Array<{ path: string; content: string }> = [];
              try {
                const retrieved = await codeEmbeddingService.fetchRelevantCodeForDocument(
                  input.documentId,
                  input.teamId,
                );
                chunks = retrieved.chunks;
              } catch (err) {
                request.log.warn({ err }, '[ai/suggestions] code retrieval failed — continuing without chunks');
              }

              codebaseHint = { repoFullName, chunks };
            }
          } catch (err) {
            request.log.warn({ err }, '[ai/suggestions] integration lookup failed — continuing without codebase hint');
          }

          const suggestions = await aiService.generateSuggestions({
            kind: 'pre-session',
            documentTitle: doc.title,
            stage: input.stage ?? doc.stage ?? null,
            contentPreview: (input.content ?? doc.content ?? '').slice(0, 500),
            codebaseHint,
          });
          return { suggestions: suggestions.length === 3 ? suggestions : [] };
        }

        // post-session
        const suggestions = await aiService.generateSuggestions({
          kind: 'post-session',
          documentTitle: doc.title,
          stage: input.stage ?? doc.stage ?? null,
          history: input.history,
          toolCallSummary: input.toolCallSummary,
          finalResult: input.finalResult,
          incomplete: input.incomplete ?? false,
        });
        return { suggestions: suggestions.length === 3 ? suggestions : [] };
      } catch (err) {
        request.log.warn({ err }, '[ai/suggestions] generation failed — returning empty');
        return { suggestions: [] };
      }
    },
  );

  // POST /api/ai/generate-all — batch-generate AI content for all documents in a team
  app.post('/generate-all', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { teamId } = generateAllBody.parse(request.body);

    // Fetch all non-archived documents for the team
    const activeDocs = await db
      .select()
      .from(documents)
      .where(and(eq(documents.teamId, teamId), isNull(documents.deletedAt)));

    if (activeDocs.length === 0) {
      return { results: [], total: 0, succeeded: 0, failed: 0 };
    }

    const results: Array<{
      documentId: string;
      title: string;
      status: 'success' | 'error';
      error?: string;
    }> = [];

    // Process documents sequentially to avoid overwhelming the AI provider
    for (const doc of activeDocs) {
      try {
        const prompt = `Generate comprehensive documentation for: ${doc.title || 'Untitled Document'}`;
        const generated = await aiService.generateDocument(prompt);

        await db
          .update(documents)
          .set({
            content: generated.content,
            title: generated.title || doc.title,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, doc.id));

        results.push({
          documentId: doc.id,
          title: generated.title || doc.title || 'Untitled',
          status: 'success',
        });
      } catch (err) {
        results.push({
          documentId: doc.id,
          title: doc.title || 'Untitled',
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const succeeded = results.filter((r) => r.status === 'success').length;
    const failed = results.filter((r) => r.status === 'error').length;

    return { results, total: activeDocs.length, succeeded, failed };
  });
};
