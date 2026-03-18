import type { FastifyPluginAsync } from 'fastify';
import { socialPublishService, type SocialPlatform } from '../services/social-publish.service.js';

const VALID_PLATFORMS: SocialPlatform[] = ['twitter', 'linkedin'];

export const socialRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/documents/:id/publish — publish content to a social platform
  app.post('/:id/publish', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const { id: documentId } = request.params as { id: string };
    const { platform, content } = request.body as { platform: string; content: string };

    if (!platform || !content) {
      reply.code(400);
      return { error: 'platform and content are required' };
    }

    if (!VALID_PLATFORMS.includes(platform as SocialPlatform)) {
      reply.code(400);
      return { error: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(', ')}` };
    }

    try {
      const result = await socialPublishService.publish(
        platform as SocialPlatform,
        content,
        'stub-access-token',
      );

      const record = await socialPublishService.savePost(
        documentId,
        platform as SocialPlatform,
        content,
        result.status,
        result.postUrl,
      );

      return {
        id: record.id,
        postUrl: result.postUrl,
        platform: result.platform,
        status: result.status,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Publishing failed';

      // Save the failed attempt
      try {
        await socialPublishService.savePost(
          documentId,
          platform as SocialPlatform,
          content,
          'failed',
        );
      } catch {
        // Swallow save error — the primary error is more important
      }

      reply.code(422);
      return { error: message };
    }
  });

  // GET /api/documents/:id/social-posts — list publish history for a document
  app.get('/:id/social-posts', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const { id: documentId } = request.params as { id: string };
    const posts = await socialPublishService.getPublishHistory(documentId);
    return { posts };
  });
};
