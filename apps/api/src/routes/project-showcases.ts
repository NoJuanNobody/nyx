import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projectShowcases } from '../db/schema.js';

export const projectShowcaseRoutes: FastifyPluginAsync = async (app) => {
  // GET / — list published showcases
  app.get('/', async () => {
    return db.select().from(projectShowcases).where(eq(projectShowcases.published, true)).orderBy(desc(projectShowcases.createdAt));
  });

  // GET /:id
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [project] = await db.select().from(projectShowcases).where(eq(projectShowcases.id, id));
    if (!project) { reply.code(404); return { error: 'Project not found' }; }
    return project;
  });

  // POST / — create showcase
  app.post('/', async (request) => {
    const userId = request.user.id;
    const body = request.body as { title: string; description: string; techStack?: string[]; teamSize?: number; nuxFeatures?: string[]; url?: string; imageUrl?: string };
    const [project] = await db.insert(projectShowcases).values({
      title: body.title, description: body.description, techStack: body.techStack || [],
      teamSize: body.teamSize, nuxFeatures: body.nuxFeatures || [], url: body.url, imageUrl: body.imageUrl,
      authorId: userId, published: true,
    }).returning();
    return project;
  });

  // DELETE /:id
  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user.id;
    const [project] = await db.select().from(projectShowcases).where(and(eq(projectShowcases.id, id), eq(projectShowcases.authorId, userId)));
    if (!project) { reply.code(404); return { error: 'Project not found or unauthorized' }; }
    await db.delete(projectShowcases).where(eq(projectShowcases.id, id));
    return { deleted: true };
  });
};
