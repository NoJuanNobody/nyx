import type { FastifyPluginAsync } from 'fastify';
import { aiService } from '../services/ai.service.js';

export const aiRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/ai/analyze — analyze spec quality (stage-aware)
  app.post('/analyze', async (request, reply) => {
    const { content, stage } = request.body as { content: string; stage?: string };

    if (!content) {
      reply.code(400);
      return { error: 'content is required' };
    }

    const result = await aiService.analyzeSpecQuality(content, stage);
    return result;
  });

  // POST /api/ai/detect-drift — detect spec-code drift
  app.post('/detect-drift', async (request, reply) => {
    const { specContent, codeContent } = request.body as {
      specContent: string;
      codeContent: string;
    };

    if (!specContent || !codeContent) {
      reply.code(400);
      return { error: 'specContent and codeContent are required' };
    }

    const result = await aiService.detectDrift(specContent, codeContent);
    return result;
  });

  // POST /api/ai/generate-document — generate a document from a prompt
  app.post('/generate-document', async (request, reply) => {
    const { prompt } = request.body as { prompt: string };

    if (!prompt) {
      reply.code(400);
      return { error: 'prompt is required' };
    }

    const result = await aiService.generateDocument(prompt);
    return result;
  });

  // POST /api/ai/edit-document — edit a document with AI
  app.post('/edit-document', async (request, reply) => {
    const { content, instruction, history } = request.body as {
      content: string;
      instruction: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    if (!content || !instruction) {
      reply.code(400);
      return { error: 'content and instruction are required' };
    }

    const result = await aiService.editDocument(content, instruction, history);
    return { content: result };
  });

  // POST /api/ai/generate-ticket — generate a ticket from a spec diff
  app.post('/generate-ticket', async (request, reply) => {
    const { diff, context } = request.body as {
      diff: string;
      context?: string;
    };

    if (!diff) {
      reply.code(400);
      return { error: 'diff is required' };
    }

    const result = await aiService.generateTicketFromDiff(diff, context);
    return result;
  });

  // POST /api/ai/jsx-preview — generate a self-contained JSX component from a prompt
  app.post('/jsx-preview', async (request, reply) => {
    const { prompt, context, allStates } = request.body as { prompt: string; context?: string; allStates?: boolean };

    if (!prompt) {
      reply.code(400);
      return { error: 'prompt is required' };
    }

    const jsx = await aiService.generateJSXPreview(prompt, context, allStates);
    return { jsx };
  });

  // POST /api/ai/jsx-preview/refine — refine an existing JSX component
  app.post('/jsx-preview/refine', async (request, reply) => {
    const { currentJSX, prompt } = request.body as { currentJSX: string; prompt: string };

    if (!currentJSX || !prompt) {
      reply.code(400);
      return { error: 'currentJSX and prompt are required' };
    }

    const jsx = await aiService.refineJSXPreview(currentJSX, prompt);
    return { jsx };
  });

  // POST /api/ai/seed-from-stage — generate pre-filled content for the next lifecycle stage (document-based)
  app.post('/seed-from-stage', async (request, reply) => {
    const { documentId, fromStage, toStage } = request.body as {
      documentId: string;
      fromStage: string;
      toStage: string;
    };

    if (!documentId || !fromStage || !toStage) {
      reply.code(400);
      return { error: 'documentId, fromStage, and toStage are required' };
    }

    // Fetch the document content via the existing seed-next-stage logic
    // The caller passes documentId; we delegate content resolution to the frontend
    // and accept content directly as an alternative
    const content = (request.body as { content?: string }).content;
    if (!content) {
      reply.code(400);
      return { error: 'content is required (document content for the current stage)' };
    }

    const result = await aiService.seedNextStage(content, fromStage, toStage);
    return result;
  });

  // POST /api/ai/missing-sections — analyze content for missing sections
  app.post('/missing-sections', async (request, reply) => {
    const { content, stage } = request.body as { content: string; stage?: string };

    if (!content) {
      reply.code(400);
      return { error: 'content is required' };
    }

    const result = await aiService.analyzeMissingSections(content, stage);
    return result;
  });

  // POST /api/ai/notification-reply — process user reply to a notification
  app.post('/notification-reply', async (request, reply) => {
    const { notificationId, message, documentId, content } = request.body as {
      notificationId: string;
      message: string;
      documentId: string;
      content?: string;
    };

    if (!notificationId || !message || !documentId) {
      reply.code(400);
      return { error: 'notificationId, message, and documentId are required' };
    }

    const result = await aiService.notificationReply(
      notificationId,
      message,
      content || '',
    );
    return result;
  });

  // POST /api/ai/decision-weight — estimate the human judgment cost of a spec
  app.post('/decision-weight', async (request, reply) => {
    const { content, stage } = request.body as { content: string; stage?: string };

    if (!content) {
      reply.code(400);
      return { error: 'content is required' };
    }

    const result = await aiService.estimateDecisionWeight(content, stage);
    return result;
  });

  // POST /api/ai/seed-next-stage — generate content for the next lifecycle stage
  app.post('/seed-next-stage', async (request, reply) => {
    const { content, fromStage, toStage } = request.body as {
      content: string;
      fromStage: string;
      toStage: string;
    };

    if (!content || !fromStage || !toStage) {
      reply.code(400);
      return { error: 'content, fromStage, and toStage are required' };
    }

    const result = await aiService.seedNextStage(content, fromStage, toStage);
    return result;
  });
};
