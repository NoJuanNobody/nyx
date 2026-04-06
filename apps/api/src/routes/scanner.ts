import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { codebaseScannerService } from '../services/codebase-scanner.service.js';
import { codeEmbeddingService } from '../services/code-embedding.service.js';

const scanBody = z.object({
  teamId: z.string().uuid(),
});

const scanDocumentBody = z.object({
  documentId: z.string().uuid(),
  teamId: z.string().uuid(),
});

const resultsQuery = z.object({
  teamId: z.string().uuid(),
});

export const scannerRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/scanner/scan — trigger a full team scan
  app.post('/scan', async (request, reply) => {
    const { teamId } = scanBody.parse(request.body);

    try {
      const result = await codebaseScannerService.scanAndFillSpecs(teamId);
      return result;
    } catch (err) {
      reply.code(500);
      return {
        error: 'Scan failed',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // POST /api/scanner/scan-document — scan a single document
  app.post('/scan-document', async (request, reply) => {
    const { documentId, teamId } = scanDocumentBody.parse(request.body);

    try {
      const result = await codebaseScannerService.scanDocument(documentId, teamId);
      return result;
    } catch (err) {
      reply.code(500);
      return {
        error: 'Document scan failed',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // POST /api/scanner/index — index codebase for RAG search
  app.post('/index', async (request, reply) => {
    const { teamId } = scanBody.parse(request.body);

    try {
      const result = await codeEmbeddingService.indexRepo(teamId);
      return result;
    } catch (err) {
      reply.code(500);
      return {
        error: 'Code indexing failed',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // GET /api/scanner/results?teamId=... — get recent scan results
  // Since we create change proposals, we return those as scan results
  app.get('/results', async (request, reply) => {
    const { teamId } = resultsQuery.parse(request.query);

    try {
      const { eq, desc, and, like } = await import('drizzle-orm');
      const { db } = await import('../db/index.js');
      const { changeProposals } = await import('../db/schema.js');

      const proposals = await db
        .select()
        .from(changeProposals)
        .where(
          and(
            eq(changeProposals.teamId, teamId),
            like(changeProposals.title, '[Auto-scan]%'),
          ),
        )
        .orderBy(desc(changeProposals.createdAt))
        .limit(20);

      return { teamId, results: proposals };
    } catch (err) {
      reply.code(500);
      return {
        error: 'Failed to fetch scan results',
        details: err instanceof Error ? err.message : String(err),
      };
    }
  });
};
