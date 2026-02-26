import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { ticketSuggestions, documents, documentVersions } from '../db/schema.js';
import { aiService } from './ai.service.js';
import { ticketService } from './ticket.service.js';
import { desc } from 'drizzle-orm';

export const suggestionService = {
  async generateSuggestions(documentId: string) {
    // Get the document
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId));

    if (!doc) throw new Error('Document not found');

    // Get last 2 versions to find recent changes
    const versions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.version))
      .limit(2);

    let diffContext = '';
    if (versions.length >= 2) {
      diffContext = `Previous version:\n${versions[1].content}\n\nCurrent version:\n${versions[0].content}`;
    } else {
      diffContext = `Current content:\n${doc.content}`;
    }

    // Use AI to generate ticket suggestions from recent changes
    const aiResult = await aiService.generateTicketFromDiff(diffContext, 'Generate 2-3 ticket suggestions based on the changes or gaps in this specification. Return a JSON array of objects with title, description, and labels fields.');

    // The AI returns a single ticket; we'll store it as a suggestion
    const [suggestion] = await db
      .insert(ticketSuggestions)
      .values({
        documentId,
        title: aiResult.title,
        description: aiResult.description,
        labels: aiResult.labels,
        status: 'pending',
      })
      .returning();

    return suggestion;
  },

  async listByDocument(documentId: string) {
    return db
      .select()
      .from(ticketSuggestions)
      .where(eq(ticketSuggestions.documentId, documentId))
      .orderBy(desc(ticketSuggestions.createdAt));
  },

  async approve(suggestionId: string, userId: string, provider: 'github' | 'jira') {
    const [suggestion] = await db
      .select()
      .from(ticketSuggestions)
      .where(eq(ticketSuggestions.id, suggestionId));

    if (!suggestion) throw new Error('Suggestion not found');
    if (suggestion.status !== 'pending') throw new Error('Suggestion already reviewed');

    // Create a real ticket via ticketService
    const ticket = await ticketService.createFromDocument(
      suggestion.documentId,
      provider,
      suggestion.title,
      suggestion.description,
      userId,
    );

    // Mark suggestion as approved
    const [updated] = await db
      .update(ticketSuggestions)
      .set({ status: 'approved', reviewedById: userId, updatedAt: new Date() })
      .where(eq(ticketSuggestions.id, suggestionId))
      .returning();

    return { suggestion: updated, ticket };
  },

  async dismiss(suggestionId: string, userId: string) {
    const [suggestion] = await db
      .select()
      .from(ticketSuggestions)
      .where(eq(ticketSuggestions.id, suggestionId));

    if (!suggestion) throw new Error('Suggestion not found');
    if (suggestion.status !== 'pending') throw new Error('Suggestion already reviewed');

    const [updated] = await db
      .update(ticketSuggestions)
      .set({ status: 'dismissed', reviewedById: userId, updatedAt: new Date() })
      .where(eq(ticketSuggestions.id, suggestionId))
      .returning();

    return updated;
  },
};
