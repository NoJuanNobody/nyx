import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { aiService } from '../services/ai.service.js';
import {
  analyzeSpecBody,
  detectDriftBody,
  generateDocumentBody,
  editDocumentBody,
  generateTicketBody,
  jsxPreviewBody,
  jsxPreviewRefineBody,
  meetingQualityBody,
  meetingApplySuggestionsBody,
  generateNewsArticleBody,
  seedFromStageBody,
  missingSectionsBody,
  notificationReplyBody,
  decisionWeightBody,
  seedNextStageBody,
  generateAllBody,
} from '@nyx/shared';

export const aiRoutes: FastifyPluginAsync = async (app) => {
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
    const { content, instruction, history } = editDocumentBody.parse(request.body);
    const result = await aiService.editDocument(content, instruction, history);
    return { content: result };
  });

  // POST /api/ai/generate-ticket — generate a ticket from a spec diff
  app.post('/generate-ticket', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { diff, context } = generateTicketBody.parse(request.body);
    const result = await aiService.generateTicketFromDiff(diff, context);
    return result;
  });

  // POST /api/ai/jsx-preview — generate a self-contained JSX component from a prompt
  app.post('/jsx-preview', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { prompt, context, allStates } = jsxPreviewBody.parse(request.body);
    const jsx = await aiService.generateJSXPreview(prompt, context, allStates);
    return { jsx };
  });

  // POST /api/ai/jsx-preview/refine — refine an existing JSX component
  app.post('/jsx-preview/refine', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { currentJSX, prompt } = jsxPreviewRefineBody.parse(request.body);
    const jsx = await aiService.refineJSXPreview(currentJSX, prompt);
    return { jsx };
  });

  // POST /api/ai/meeting-quality — analyze meeting note quality
  app.post('/meeting-quality', async (request, _reply) => {
    const { content } = meetingQualityBody.parse(request.body);
    const result = await aiService.analyzeMeetingNoteQuality(content);
    return result;
  });

  // POST /api/ai/meeting-apply-suggestions — apply improvement suggestions to meeting notes
  app.post('/meeting-apply-suggestions', async (request, _reply) => {
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
  app.post('/seed-from-stage', async (request, _reply) => {
    const { content, fromStage, toStage } = seedFromStageBody.parse(request.body);
    const result = await aiService.seedNextStage(content, fromStage, toStage);
    return result;
  });

  // POST /api/ai/missing-sections — analyze content for missing sections
  app.post('/missing-sections', async (request, _reply) => {
    const { content, stage } = missingSectionsBody.parse(request.body);
    const result = await aiService.analyzeMissingSections(content, stage);
    return result;
  });

  // POST /api/ai/notification-reply — process user reply to a notification
  app.post('/notification-reply', async (request, _reply) => {
    const { notificationId, message, documentId, content } = notificationReplyBody.parse(request.body);
    const result = await aiService.notificationReply(
      notificationId,
      message,
      content || '',
    );
    return result;
  });

  // POST /api/ai/decision-weight — estimate the human judgment cost of a spec
  app.post('/decision-weight', async (request, _reply) => {
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

  // POST /api/ai/generate-all — batch-generate AI content for all documents in a team
  app.post('/generate-all', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async (request, _reply) => {
    const { teamId } = generateAllBody.parse(request.body);

    // Fetch all non-archived documents for the team
    const docs = await db
      .select()
      .from(documents)
      .where(eq(documents.teamId, teamId));

    const activeDocs = docs.filter((doc) => doc.status !== 'archived');

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
