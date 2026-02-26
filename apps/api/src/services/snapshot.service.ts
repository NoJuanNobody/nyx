import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { snapshots, documents } from '../db/schema.js';

export const snapshotService = {
  async list(teamId?: string) {
    if (teamId) {
      // Get document IDs belonging to this team, then filter snapshots
      const teamDocs = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.teamId, teamId));

      const docIds = teamDocs.map((d) => d.id);
      if (docIds.length === 0) return [];

      return db
        .select()
        .from(snapshots)
        .where(inArray(snapshots.documentId, docIds));
    }

    return db.select().from(snapshots);
  },

  async create(data: { name: string; documentIds: string[] }) {
    // Fetch current content for each document
    const docs = await db
      .select()
      .from(documents)
      .where(inArray(documents.id, data.documentIds));

    if (docs.length === 0) return [];

    const values = docs.map((doc) => ({
      documentId: doc.id,
      integrationId: null,
      externalRef: data.name,
      content: doc.content,
    }));

    return db.insert(snapshots).values(values).returning();
  },

  async getById(id: string) {
    const [snapshot] = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.id, id))
      .limit(1);

    return snapshot ?? null;
  },

  async restore(snapshotId: string, userId: string) {
    const snapshot = await this.getById(snapshotId);
    if (!snapshot) throw new Error('Snapshot not found');

    // Restore the document content from the snapshot
    await db
      .update(documents)
      .set({ content: snapshot.content, updatedAt: new Date() })
      .where(eq(documents.id, snapshot.documentId));

    return { documentId: snapshot.documentId, restoredFrom: snapshotId };
  },
};
