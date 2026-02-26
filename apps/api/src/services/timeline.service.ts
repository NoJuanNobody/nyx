import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { timelineEvents } from '../db/schema.js';

export const timelineService = {
  async getByDocument(documentId: string) {
    return db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.documentId, documentId))
      .orderBy(desc(timelineEvents.createdAt));
  },

  async create(data: {
    documentId: string;
    type: string;
    payload?: Record<string, unknown>;
    actorId?: string;
  }) {
    const [event] = await db
      .insert(timelineEvents)
      .values({
        documentId: data.documentId,
        type: data.type,
        payload: data.payload ?? {},
        actorId: data.actorId ?? null,
      })
      .returning();

    return event;
  },
};
