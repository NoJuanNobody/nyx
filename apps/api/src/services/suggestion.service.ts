import { eq, and, desc, inArray, like, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { ticketSuggestions, documents, documentVersions, integrations } from '../db/schema.js';
import { aiService } from './ai.service.js';
import { ticketService } from './ticket.service.js';
import { githubService } from './github.service.js';

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

  async approve(
    suggestionId: string,
    userId: string,
    provider: 'github' | 'jira',
    repo?: { owner: string; name: string },
  ) {
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
      repo,
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

  async expandSuggestion(suggestionId: string) {
    const [suggestion] = await db
      .select()
      .from(ticketSuggestions)
      .where(eq(ticketSuggestions.id, suggestionId));

    if (!suggestion) throw new Error('Suggestion not found');

    // Fetch the parent document for context
    const [doc] = await db
      .select({ title: documents.title, content: documents.content })
      .from(documents)
      .where(eq(documents.id, suggestion.documentId));

    const expanded = await aiService.expandTicketDescription(
      suggestion.title,
      suggestion.description,
      doc?.title ?? '',
      doc?.content?.slice(0, 6000) ?? '',
    );

    // Update the suggestion with the expanded description
    const [updated] = await db
      .update(ticketSuggestions)
      .set({ description: expanded, updatedAt: new Date() })
      .where(eq(ticketSuggestions.id, suggestionId))
      .returning();

    return updated;
  },

  async generateBulkSuggestions(documentId: string) {
    // Fetch document and GitHub integration in parallel
    const [docResult, integrationResult] = await Promise.all([
      db.select().from(documents).where(eq(documents.id, documentId)),
      db.select().from(integrations).where(eq(integrations.type, 'github')).then(
        (rows) => rows,
        () => [] as typeof integrations.$inferSelect[],
      ),
    ]);

    const [doc] = docResult;
    if (!doc) throw new Error('Document not found');

    // Fetch GitHub file tree (with 5s timeout to avoid blocking on slow repos)
    let codeContextStr: string | undefined;
    const integration = integrationResult.find((i) => i.teamId === doc.teamId);
    if (integration) {
      try {
        const cfg = integration.config as {
          accessToken?: string;
          selectedRepos?: Array<{ owner: string; name: string }>;
          owner?: string;
          repo?: string;
        };
        const accessToken = cfg.accessToken;
        const owner = cfg.selectedRepos?.[0]?.owner ?? cfg.owner;
        const repo = cfg.selectedRepos?.[0]?.name ?? cfg.repo;

        if (accessToken && owner && repo) {
          const treePromise = githubService.getFileTree(accessToken, owner, repo);
          const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
          const tree = await Promise.race([treePromise, timeoutPromise]);
          if (tree) {
            // Only send file paths, not full metadata — much smaller payload
            const paths = tree.map((f: { path: string }) => f.path).slice(0, 500);
            codeContextStr = paths.join('\n');
          }
        }
      } catch {
        // Proceed without code context
      }
    }

    // Generate suggestions via AI
    const aiResults = await aiService.generateBulkTicketSuggestions(
      doc.content ?? '',
      doc.title,
      doc.stage ?? null,
      codeContextStr,
    );

    // Insert all suggestions into the database
    const created = await db
      .insert(ticketSuggestions)
      .values(
        aiResults.map((item) => ({
          documentId,
          title: item.title,
          description: item.description,
          labels: item.labels,
          status: 'pending' as const,
        })),
      )
      .returning();

    return created;
  },

  async bulkApprove(
    suggestionIds: string[],
    userId: string,
    provider: 'github' | 'jira',
    repo?: { owner: string; name: string },
  ) {
    // Fetch all suggestions by IDs
    const suggestions = await db
      .select()
      .from(ticketSuggestions)
      .where(inArray(ticketSuggestions.id, suggestionIds));

    // Validate all are pending
    const nonPending = suggestions.filter((s) => s.status !== 'pending');
    if (nonPending.length > 0) {
      throw new Error(`${nonPending.length} suggestion(s) are not in pending status`);
    }

    const results: Array<{ suggestionId: string; success: boolean; ticket?: unknown; error?: string }> = [];

    for (const suggestion of suggestions) {
      try {
        const ticket = await ticketService.createFromDocument(
          suggestion.documentId,
          provider,
          suggestion.title,
          suggestion.description,
          userId,
          repo,
        );

        // Mark as approved
        await db
          .update(ticketSuggestions)
          .set({ status: 'approved', reviewedById: userId, updatedAt: new Date() })
          .where(eq(ticketSuggestions.id, suggestion.id));

        results.push({ suggestionId: suggestion.id, success: true, ticket });
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Unknown error';
        results.push({ suggestionId: suggestion.id, success: false, error });
      }

      // Rate-limit between calls
      await new Promise((r) => setTimeout(r, 500));
    }

    return results;
  },

  async generateFolderSuggestions(teamId: string, folderPath: string) {
    // Get all documents in this folder (and subfolders)
    const prefix = folderPath === '/' ? '/' : `${folderPath}/`;
    const folderDocs = await db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.teamId, teamId),
          isNull(documents.deletedAt),
        ),
      );

    // Filter to docs in this folder or subfolders (path equals folderPath or starts with prefix)
    const matchingDocs = folderDocs.filter((doc) => {
      const docPath = doc.path || '/';
      return docPath === folderPath || docPath.startsWith(prefix);
    });

    if (matchingDocs.length === 0) {
      throw new Error('No documents found in this folder');
    }

    // Build a combined summary of all documents for AI analysis
    const docSummaries = matchingDocs.map((doc) => {
      const truncatedContent = (doc.content ?? '').slice(0, 3000);
      return `## ${doc.title} (${doc.stage ?? 'no stage'})\n${truncatedContent}`;
    }).join('\n\n---\n\n');

    const folderName = folderPath === '/' ? 'root' : folderPath.split('/').filter(Boolean).pop() ?? folderPath;

    // Use AI to generate suggestions across all folder documents
    const aiResults = await aiService.generateBulkTicketSuggestions(
      docSummaries,
      `Folder: ${folderName} (${matchingDocs.length} documents)`,
      null,
    );

    // Insert all suggestions, linking each to the first document in the folder
    // (since ticket_suggestions requires a documentId)
    const primaryDocId = matchingDocs[0].id;
    const created = await db
      .insert(ticketSuggestions)
      .values(
        aiResults.map((item) => ({
          documentId: primaryDocId,
          title: item.title,
          description: item.description,
          labels: item.labels,
          status: 'pending' as const,
        })),
      )
      .returning();

    return created;
  },

  async updateSuggestion(suggestionId: string, updates: { title?: string; description?: string; labels?: string[] }) {
    const [suggestion] = await db
      .select()
      .from(ticketSuggestions)
      .where(eq(ticketSuggestions.id, suggestionId));

    if (!suggestion) throw new Error('Suggestion not found');
    if (suggestion.status !== 'pending') throw new Error('Suggestion already reviewed');

    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.title !== undefined) setValues.title = updates.title;
    if (updates.description !== undefined) setValues.description = updates.description;
    if (updates.labels !== undefined) setValues.labels = updates.labels;

    const [updated] = await db
      .update(ticketSuggestions)
      .set(setValues)
      .where(eq(ticketSuggestions.id, suggestionId))
      .returning();

    return updated;
  },
};
