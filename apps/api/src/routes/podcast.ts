import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { inArray } from 'drizzle-orm';
import { aiService } from '../services/ai.service.js';
import { ttsService } from '../services/tts.service.js';

export interface PodcastScript {
  id: string;
  teamId: string;
  title: string;
  documentIds: string[];
  script: Array<{ speaker: 'Host A' | 'Host B'; text: string }>;
  qualityScore: number;
  suggestions: string[];
  createdAt: string;
}

// In-memory store for MVP (same pattern as sprint service)
const podcastScripts: PodcastScript[] = [];
let nextId = 1;

export const podcastRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/podcast/generate — generate a podcast script from documents
  app.post('/podcast/generate', async (request, reply) => {
    const { documentIds, teamId, title } = request.body as {
      documentIds?: string[];
      teamId?: string;
      title?: string;
    };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
      reply.code(400);
      return { error: 'documentIds must be a non-empty array' };
    }

    const docs = await db
      .select({ id: documents.id, title: documents.title, content: documents.content })
      .from(documents)
      .where(inArray(documents.id, documentIds));

    if (docs.length === 0) {
      reply.code(404);
      return { error: 'No documents found for the given IDs' };
    }

    const concatenatedContent = docs
      .map((d) => `# ${d.title}\n\n${d.content}`)
      .join('\n\n---\n\n');

    const result = await aiService.generatePodcastScript(concatenatedContent, title);

    const script: PodcastScript = {
      id: `podcast-${nextId++}`,
      teamId,
      title: result.title,
      documentIds,
      script: result.script,
      qualityScore: result.qualityScore,
      suggestions: result.suggestions,
      createdAt: new Date().toISOString(),
    };

    podcastScripts.push(script);
    return script;
  });

  // POST /api/podcast/:id/audio — generate audio for a podcast script
  app.post('/podcast/:id/audio', async (request, reply) => {
    const { id } = request.params as { id: string };

    const script = podcastScripts.find((s) => s.id === id);
    if (!script) {
      reply.code(404);
      return { error: 'Podcast script not found' };
    }

    if (!script.script || script.script.length === 0) {
      reply.code(400);
      return { error: 'Podcast script has no segments' };
    }

    const audioBuffer = await ttsService.generatePodcastAudio(script.script);

    reply
      .header('Content-Type', 'audio/mpeg')
      .header('Content-Disposition', `attachment; filename="${script.id}.mp3"`)
      .header('Content-Length', audioBuffer.length);

    return reply.send(audioBuffer);
  });

  // POST /api/podcast/radio-show — generate a radio show from multiple documents
  app.post('/podcast/radio-show', async (request, reply) => {
    const { documentIds, teamId, showName } = request.body as {
      documentIds?: string[];
      teamId?: string;
      showName?: string;
    };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    if (!documentIds || !Array.isArray(documentIds) || documentIds.length < 2) {
      reply.code(400);
      return { error: 'documentIds must be an array with at least 2 documents' };
    }

    const docs = await db
      .select({ id: documents.id, title: documents.title, content: documents.content })
      .from(documents)
      .where(inArray(documents.id, documentIds));

    if (docs.length === 0) {
      reply.code(404);
      return { error: 'No documents found for the given IDs' };
    }

    const segments = docs.map((d) => ({
      title: d.title ?? 'Untitled',
      content: d.content ?? '',
    }));

    const result = await aiService.generateRadioShowScript(segments, showName);

    const script: PodcastScript = {
      id: `podcast-${nextId++}`,
      teamId,
      title: result.title,
      documentIds,
      script: result.script,
      qualityScore: result.qualityScore,
      suggestions: result.suggestions,
      createdAt: new Date().toISOString(),
    };

    podcastScripts.push(script);
    return script;
  });
  // GET /api/podcast/scripts?teamId=X — list generated podcast scripts
  app.get('/podcast/scripts', async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    const scripts = podcastScripts.filter((s) => s.teamId === teamId);
    return { scripts };
  });
};

// Exported for testing
export function _resetPodcastScripts(): void {
  podcastScripts.length = 0;
  nextId = 1;
}
