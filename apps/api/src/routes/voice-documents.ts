import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, meetingDocuments } from '../db/schema.js';
import { meetingIntelligenceService } from '../services/voice/meeting-intelligence.service.js';
import { createMeetingDocument } from '../services/voice/doc-transformer.service.js';

export const voiceDocumentRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/voice/documents/from-meeting — create a document from a meeting session
  app.post('/documents/from-meeting', async (request, reply) => {
    const { sessionId, teamId, platform } = request.body as {
      sessionId: string;
      teamId: string;
      platform?: string;
    };

    if (!sessionId || !teamId) {
      reply.code(400);
      return { error: 'sessionId and teamId are required' };
    }

    const intelligence = meetingIntelligenceService.getIntelligence(sessionId);
    if (!intelligence) {
      reply.code(404);
      return { error: `No meeting intelligence found for session: ${sessionId}` };
    }

    const userId = request.user.id;

    try {
      const documentId = await createMeetingDocument(
        intelligence,
        teamId,
        userId,
        platform ?? 'unknown',
      );

      reply.code(201);
      return { documentId };
    } catch (err) {
      request.log.error({ err, sessionId, teamId }, 'Failed to create meeting document');
      reply.code(500);
      return { error: 'Failed to create meeting document' };
    }
  });

  // GET /api/voice/documents/meetings — list all meeting-sourced documents
  app.get('/documents/meetings', async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    const rows = await db
      .select({
        id: meetingDocuments.id,
        documentId: meetingDocuments.documentId,
        meetingSessionId: meetingDocuments.meetingSessionId,
        platform: meetingDocuments.platform,
        duration: meetingDocuments.duration,
        participants: meetingDocuments.participants,
        createdAt: meetingDocuments.createdAt,
        docTitle: documents.title,
        docStatus: documents.status,
        docStage: documents.stage,
      })
      .from(meetingDocuments)
      .innerJoin(documents, eq(meetingDocuments.documentId, documents.id))
      .where(eq(documents.teamId, teamId));

    return rows;
  });

  // GET /api/voice/documents/meetings/:documentId — get meeting document with intelligence data
  app.get('/documents/meetings/:documentId', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };

    const [row] = await db
      .select({
        id: meetingDocuments.id,
        documentId: meetingDocuments.documentId,
        meetingSessionId: meetingDocuments.meetingSessionId,
        platform: meetingDocuments.platform,
        meetingIntelligence: meetingDocuments.meetingIntelligence,
        duration: meetingDocuments.duration,
        participants: meetingDocuments.participants,
        createdAt: meetingDocuments.createdAt,
        docTitle: documents.title,
        docContent: documents.content,
        docStatus: documents.status,
        docStage: documents.stage,
      })
      .from(meetingDocuments)
      .innerJoin(documents, eq(meetingDocuments.documentId, documents.id))
      .where(eq(meetingDocuments.documentId, documentId));

    if (!row) {
      reply.code(404);
      return { error: 'Meeting document not found' };
    }

    return row;
  });
};
