import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { deliverables, documents } from '../db/schema.js';
import { exportService } from './export.service.js';
import { exportJupyterService } from './export-jupyter.service.js';

export type DeliverableType = 'pdf' | 'markdown' | 'report' | 'jupyter';

export interface GenerateDeliverableInput {
  documentId: string;
  stage: string;
  type: DeliverableType;
}

export const deliverableService = {
  async generateDeliverable(input: GenerateDeliverableInput) {
    const { documentId, stage, type } = input;

    // Verify document exists
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    if (!doc) {
      return null;
    }

    let fileName: string;
    let fileUrl: string;
    const safeTitle = doc.title.replace(/[^a-zA-Z0-9-_]/g, '_');

    switch (type) {
      case 'pdf': {
        const result = await exportService.toPdf(documentId);
        if (!result) return null;
        fileName = `${safeTitle}_${stage}.pdf`;
        // In production this would upload to object storage; for now store a reference path
        fileUrl = `/deliverables/${documentId}/${fileName}`;
        break;
      }
      case 'markdown': {
        const result = await exportService.toMarkdown(documentId);
        if (!result) return null;
        fileName = `${safeTitle}_${stage}.md`;
        fileUrl = `/deliverables/${documentId}/${fileName}`;
        break;
      }
      case 'report': {
        fileName = `${safeTitle}_${stage}_report.md`;
        fileUrl = `/deliverables/${documentId}/${fileName}`;
        break;
      }
      case 'jupyter': {
        const result = await exportJupyterService.toJupyterNotebook(documentId);
        if (!result) return null;
        fileName = `${safeTitle}_${stage}.ipynb`;
        fileUrl = `/deliverables/${documentId}/${fileName}`;
        break;
      }
      default:
        throw new Error(`Unsupported deliverable type: ${type}`);
    }

    const [deliverable] = await db
      .insert(deliverables)
      .values({
        documentId,
        stage,
        type,
        fileName,
        fileUrl,
        metadata: { title: doc.title },
      })
      .returning();

    return deliverable;
  },

  async listDeliverables(documentId: string) {
    const rows = await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.documentId, documentId));
    return rows;
  },

  async getDeliverable(id: string) {
    const [deliverable] = await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.id, id));
    return deliverable ?? null;
  },
};
