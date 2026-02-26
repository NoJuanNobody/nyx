import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documentVersions, documents } from '../db/schema.js';

export const versionService = {
  async listByDocument(documentId: string) {
    return db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.version));
  },

  async create(data: {
    documentId: string;
    content: string;
    message?: string;
    createdById: string;
  }) {
    // Get the latest version number for this document
    const latest = await db
      .select({ version: documentVersions.version })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, data.documentId))
      .orderBy(desc(documentVersions.version))
      .limit(1);

    const nextVersion = latest.length > 0 ? latest[0].version + 1 : 1;

    const [version] = await db
      .insert(documentVersions)
      .values({
        documentId: data.documentId,
        content: data.content,
        message: data.message ?? null,
        createdById: data.createdById,
        version: nextVersion,
      })
      .returning();

    return version;
  },

  async getById(versionId: string) {
    const [version] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1);

    return version ?? null;
  },

  async diff(versionIdA: string, versionIdB: string) {
    const [a, b] = await Promise.all([
      db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.id, versionIdA))
        .limit(1),
      db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.id, versionIdB))
        .limit(1),
    ]);

    if (!a[0] || !b[0]) return null;

    return { a: a[0], b: b[0] };
  },

  async restoreToVersion(documentId: string, versionId: string, userId: string) {
    const version = await this.getById(versionId);
    if (!version) throw new Error('Version not found');
    if (version.documentId !== documentId) throw new Error('Version does not belong to this document');

    // Update the document content to the version's content
    await db
      .update(documents)
      .set({ content: version.content, updatedAt: new Date() })
      .where(eq(documents.id, documentId));

    // Create a new version recording the restore
    const restored = await this.create({
      documentId,
      content: version.content,
      message: `Restored to v${version.version}`,
      createdById: userId,
    });

    return restored;
  },
};
