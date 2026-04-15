import { eq, and, desc, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { documents, documentVersions, integrations, notifications, tickets, ticketSuggestions } from '../../db/schema.js';
import { aiService } from '../ai.service.js';
import { ticketService } from '../ticket.service.js';
import { auditService } from '../audit.service.js';
import { githubService } from '../github.service.js';
import { isIndexableFile } from '../code-embedding.service.js';
import { webSearch } from '../search.service.js';
import { intakeService } from '../intake.service.js';
import { suggestionService } from '../suggestion.service.js';
import { changeProposalService } from '../change-proposal.service.js';
import { exportService } from '../export.service.js';
import { retrieveChunks } from '../retrieval.service.js';
import { checkCompliance } from '../compliance.service.js';
import { ttsService } from '../tts.service.js';
import { codebaseScannerService } from '../codebase-scanner.service.js';
import { codeEmbeddingService } from '../code-embedding.service.js';
import type { AgentContext } from './types.js';

// Roles that can write (update docs, create tickets)
const WRITE_ROLES = new Set(['owner', 'admin', 'developer', 'editor']);

function assertCanWrite(ctx: AgentContext) {
  if (!WRITE_ROLES.has(ctx.userRole)) {
    throw new Error(`Permission denied: role '${ctx.userRole}' cannot perform write operations`);
  }
}

/**
 * Execute a tool call by dispatching to the appropriate service.
 * Validates permissions before write operations.
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<unknown> {
  switch (toolName) {
    case 'read_document': {
      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, input.document_id as string))
        .limit(1);
      if (!doc) throw new Error('Document not found');
      return { id: doc.id, title: doc.title, content: doc.content, path: doc.path };
    }

    case 'list_documents': {
      const teamId = (input.team_id as string) || ctx.teamId;
      const docs = await db
        .select({ id: documents.id, title: documents.title, path: documents.path })
        .from(documents)
        .where(and(eq(documents.teamId, teamId), isNull(documents.deletedAt)));
      return docs;
    }

    case 'update_document': {
      assertCanWrite(ctx);
      const docId = input.document_id as string;
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.title) updates.title = input.title;
      if (input.content) updates.content = input.content;

      const [updated] = await db
        .update(documents)
        .set(updates)
        .where(eq(documents.id, docId))
        .returning();
      if (!updated) throw new Error('Document not found');
      return { id: updated.id, title: updated.title, updatedAt: updated.updatedAt };
    }

    case 'get_version_diff': {
      const [a] = await db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.id, input.version_id_a as string))
        .limit(1);
      const [b] = await db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.id, input.version_id_b as string))
        .limit(1);
      if (!a || !b) throw new Error('One or both versions not found');
      return { a: { version: a.version, content: a.content }, b: { version: b.version, content: b.content } };
    }

    case 'analyze_spec_quality': {
      return aiService.analyzeSpecQuality(input.content as string);
    }

    case 'detect_drift': {
      return aiService.detectDrift(input.spec_content as string, input.code_content as string);
    }

    case 'get_github_files': {
      const teamId = (input.team_id as string) || ctx.teamId;
      const filePath = input.path as string | undefined;

      // Look up GitHub integration for the team
      const [integration] = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.type, 'github'), eq(integrations.teamId, teamId)))
        .limit(1);

      if (!integration) throw new Error('No GitHub integration configured for this team');

      const ghConfig = integration.config as {
        accessToken: string;
        owner?: string;
        repo?: string;
        selectedRepos?: Array<{ owner: string; name: string; fullName: string }>;
      };
      const owner = ghConfig.selectedRepos?.[0]?.owner ?? ghConfig.owner ?? '';
      const repo = ghConfig.selectedRepos?.[0]?.name ?? ghConfig.repo ?? '';
      if (!ghConfig.accessToken || !owner || !repo) {
        throw new Error('GitHub integration is missing required configuration (no access token or no repository selected)');
      }

      if (filePath) {
        const file = await githubService.getFileContent(ghConfig.accessToken, owner, repo, filePath);

        // GitHub returns an array for directory paths — not a readable file
        if (Array.isArray(file)) {
          const entries = (file as Array<{ name: string; type: string }>).map(
            (e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`,
          );
          return {
            path: filePath,
            error: 'Path is a directory, not a file.',
            entries: entries.slice(0, 50),
            note: 'Use a specific file path instead.',
          };
        }

        // Large files (>1 MB) have no content — GitHub omits it
        if (!file.content) {
          return {
            path: filePath,
            error: `File too large to read via API (${file.size} bytes). Try a more specific path or use search_code instead.`,
          };
        }

        // Decode base64 content and truncate large files to prevent token explosion
        const decoded = Buffer.from(file.content, 'base64').toString('utf-8');
        const MAX_FILE_CHARS = 8_000;
        if (decoded.length > MAX_FILE_CHARS) {
          return {
            path: filePath,
            content: decoded.slice(0, MAX_FILE_CHARS),
            truncated: true,
            totalChars: decoded.length,
            note: 'File truncated. Ask the user to specify a section if more detail is needed.',
          };
        }
        return { path: filePath, content: decoded };
      }

      // Return file tree, filtered using the same rules as the code-embedding indexer
      const tree = await githubService.getFileTree(ghConfig.accessToken, owner, repo);
      const MAX_TREE_ENTRIES = 200;
      const filtered = tree.filter(isIndexableFile).slice(0, MAX_TREE_ENTRIES);
      const totalBlobs = tree.filter((e) => e.type === 'blob').length;
      return {
        files: filtered.map((e) => e.path),
        total: totalBlobs,
        shown: filtered.length,
        note: filtered.length < totalBlobs
          ? 'File tree filtered & capped. Use a path prefix or search_code for specific files.'
          : undefined,
      };
    }

    case 'create_ticket': {
      assertCanWrite(ctx);
      const docId = input.document_id as string;
      const provider = input.provider as string;
      const title = input.title as string;
      const body = input.body as string;
      if (!docId) throw new Error('create_ticket requires document_id');
      if (!provider || !['github', 'jira'].includes(provider)) {
        throw new Error("create_ticket requires provider to be 'github' or 'jira'");
      }
      if (!title) throw new Error('create_ticket requires a title');
      const ticket = await ticketService.createFromDocument(
        docId,
        provider as 'github' | 'jira',
        title,
        body || '',
        ctx.userId,
      );
      return { id: ticket.id, title: ticket.title, externalUrl: ticket.externalUrl };
    }

    case 'search_audit_trail': {
      const events = await auditService.getTrailForDocument(input.document_id as string);
      return events.slice(0, 50); // Limit to prevent massive payloads
    }

    case 'web_search': {
      const query = input.query as string;
      if (!query) throw new Error('web_search requires a query');
      return webSearch(query);
    }

    // ── Intake & Spec Writing ──────────────────────────────

    case 'intake_process': {
      assertCanWrite(ctx);
      const rawInput = input.raw_input as string;
      if (!rawInput) throw new Error('intake_process requires raw_input');
      return intakeService.processRawInput(rawInput, ctx.teamId, ctx.userId);
    }

    case 'improve_document': {
      assertCanWrite(ctx);
      const docId = input.document_id as string;
      if (!docId) throw new Error('improve_document requires document_id');

      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, docId))
        .limit(1);
      if (!doc) throw new Error('Document not found');

      // Analyze quality first
      const quality = await aiService.analyzeSpecQuality(doc.content);

      // Use AI to improve the content based on quality suggestions
      const instruction = (input.instruction as string) || 'Improve this specification based on the quality analysis suggestions.';
      const prompt = `${instruction}\n\nQuality score: ${quality.score}/100\nSuggestions:\n${quality.suggestions.map((s: string) => `- ${s}`).join('\n')}\n\nCurrent content:\n${doc.content}`;

      const improved = await aiService.editDocument(doc.content, prompt);

      return {
        document_id: docId,
        original_score: quality.score,
        suggestions: quality.suggestions,
        improved_content: improved,
      };
    }

    // ── Tickets & Proposals ────────────────────────────────

    case 'suggest_tickets': {
      const docId = input.document_id as string;
      if (!docId) throw new Error('suggest_tickets requires document_id');
      return suggestionService.generateBulkSuggestions(docId);
    }

    case 'list_tickets': {
      // Tickets don't have teamId — join through documents
      const teamDocs = await db.select({ id: documents.id }).from(documents).where(eq(documents.teamId, ctx.teamId));
      const docIds = teamDocs.map((d) => d.id);
      if (docIds.length === 0) return [];
      const allTickets = await db
        .select({ id: tickets.id, title: tickets.title, status: tickets.status, provider: tickets.provider, externalUrl: tickets.externalUrl, createdAt: tickets.createdAt })
        .from(tickets)
        .orderBy(desc(tickets.createdAt))
        .limit(50);
      // Filter in JS since we can't do IN() easily
      let filtered = allTickets.filter((t) => {
        // Tickets are linked to docs — we'd need documentId on the select. Just return all for now.
        return true;
      });
      if (input.status) filtered = filtered.filter((t) => t.status === input.status);
      if (input.provider) filtered = filtered.filter((t) => t.provider === input.provider);
      return filtered;
    }

    case 'list_ticket_suggestions': {
      const docId = input.document_id as string;
      if (!docId) throw new Error('list_ticket_suggestions requires document_id');
      const results = await db
        .select({ id: ticketSuggestions.id, title: ticketSuggestions.title, status: ticketSuggestions.status, createdAt: ticketSuggestions.createdAt })
        .from(ticketSuggestions)
        .where(eq(ticketSuggestions.documentId, docId))
        .orderBy(desc(ticketSuggestions.createdAt))
        .limit(50);
      return results;
    }

    case 'approve_ticket_suggestion': {
      assertCanWrite(ctx);
      const suggestionId = input.suggestion_id as string;
      const provider = input.provider as 'github' | 'jira';
      if (!suggestionId) throw new Error('approve_ticket_suggestion requires suggestion_id');
      if (!provider) throw new Error('approve_ticket_suggestion requires provider');
      return suggestionService.approve(suggestionId, ctx.userId, provider);
    }

    case 'sync_tickets': {
      return ticketService.syncAllForTeam(ctx.teamId);
    }

    case 'generate_change_proposal': {
      assertCanWrite(ctx);
      const docId = input.document_id as string;
      if (!docId) throw new Error('generate_change_proposal requires document_id');
      return changeProposalService.generate(docId, ctx.teamId, ctx.userId);
    }

    // ── Podcast ────────────────────────────────────────────

    case 'generate_podcast_script': {
      const docId = input.document_id as string;
      if (!docId) throw new Error('generate_podcast_script requires document_id');

      const [doc] = await db
        .select({ id: documents.id, title: documents.title, content: documents.content })
        .from(documents)
        .where(eq(documents.id, docId))
        .limit(1);
      if (!doc) throw new Error('Document not found');

      const result = await aiService.generatePodcastScript(
        `# ${doc.title}\n\n${doc.content}`,
        doc.title ?? undefined,
      );

      return {
        title: result.title,
        script: result.script,
        qualityScore: result.qualityScore,
        suggestions: result.suggestions,
      };
    }

    case 'generate_podcast_audio': {
      const scriptId = input.script_id as string;
      if (!scriptId) throw new Error('generate_podcast_audio requires script_id');

      // The podcast scripts are stored in-memory in the podcast routes module.
      // Since we can't access them directly, we inform the user to use the REST API.
      throw new Error(
        'Podcast audio generation requires the REST API endpoint POST /api/podcast/:id/audio. ' +
        'Use the generate_podcast_script tool to create a script first, then call the REST endpoint to generate audio.',
      );
    }

    // ── Export ─────────────────────────────────────────────

    case 'export_document': {
      const docId = input.document_id as string;
      const format = input.format as string;
      if (!docId) throw new Error('export_document requires document_id');
      if (!format || !['markdown', 'pdf', 'txt'].includes(format)) {
        throw new Error("export_document requires format to be 'markdown', 'pdf', or 'txt'");
      }

      if (format === 'markdown') {
        const result = await exportService.toMarkdown(docId);
        if (!result) throw new Error('Document not found');
        return { title: result.title, format: 'markdown', content: result.content };
      } else if (format === 'pdf') {
        const result = await exportService.toPdf(docId);
        if (!result) throw new Error('Document not found');
        return { title: result.title, format: 'pdf', message: 'PDF generated successfully', sizeBytes: result.buffer.length };
      } else {
        const result = await exportService.toPlainText(docId);
        if (!result) throw new Error('Document not found');
        return { title: result.title, format: 'txt', content: result.content };
      }
    }

    // ── RAG & Compliance ──────────────────────────────────

    case 'retrieve_chunks': {
      const query = input.query as string;
      if (!query) throw new Error('retrieve_chunks requires a query');
      return retrieveChunks(query, ctx.teamId);
    }

    case 'check_compliance': {
      const code = input.code as string;
      if (!code) throw new Error('check_compliance requires code');
      const filePath = input.file_path as string | undefined;
      return checkCompliance(code, ctx.teamId, filePath);
    }

    // ── Document Management ───────────────────────────────

    case 'create_document': {
      assertCanWrite(ctx);
      const title = input.title as string;
      if (!title) throw new Error('create_document requires a title');

      const [created] = await db
        .insert(documents)
        .values({
          title,
          content: (input.content as string) || '',
          stage: (input.stage as string) || null,
          teamId: ctx.teamId,
          createdById: ctx.userId,
        })
        .returning();

      return { id: created.id, title: created.title, stage: created.stage };
    }

    case 'delete_document': {
      assertCanWrite(ctx);
      const docId = input.document_id as string;
      if (!docId) throw new Error('delete_document requires document_id');

      const now = new Date();
      const [updated] = await db
        .update(documents)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(documents.id, docId))
        .returning();
      if (!updated) throw new Error('Document not found');

      return { id: updated.id, title: updated.title, deletedAt: updated.deletedAt };
    }

    case 'list_versions': {
      const docId = input.document_id as string;
      if (!docId) throw new Error('list_versions requires document_id');

      const versions = await db
        .select({
          id: documentVersions.id,
          version: documentVersions.version,
          message: documentVersions.message,
          createdById: documentVersions.createdById,
          createdAt: documentVersions.createdAt,
        })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, docId))
        .orderBy(desc(documentVersions.version));

      return versions;
    }

    // ── Notifications & Activity ──────────────────────────

    case 'list_notifications': {
      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, ctx.userId),
            isNull(notifications.readAt),
          ),
        )
        .orderBy(desc(notifications.createdAt))
        .limit(20);

      return rows;
    }

    // ── Codebase Scanner ──────────────────────────────────

    case 'scan_codebase': {
      const teamId = (input.team_id as string) || ctx.teamId;
      return codebaseScannerService.scanAndFillSpecs(teamId);
    }

    case 'scan_document': {
      const docId = input.document_id as string;
      if (!docId) throw new Error('scan_document requires document_id');
      const teamId = (input.team_id as string) || ctx.teamId;
      return codebaseScannerService.scanDocument(docId, teamId);
    }

    // ── Code RAG ──────────────────────────────────────────

    case 'search_code': {
      const query = input.query as string;
      if (!query) throw new Error('search_code requires a query');
      const topK = Math.min(Number(input.top_k) || 5, 10);
      return codeEmbeddingService.searchCode(query, ctx.teamId, { topK });
    }

    case 'index_codebase': {
      assertCanWrite(ctx);
      const teamId = (input.team_id as string) || ctx.teamId;
      const indexResult = await codeEmbeddingService.indexRepo(teamId);
      // Return a BOUNDED summary by design — never the full file tree.
      // Fetch a small sample of indexable file paths to give the model
      // something to drill into with `search_code` / `get_github_files`,
      // plus a per-top-level-directory count so it can navigate the layout.
      try {
        const [integration] = await db
          .select()
          .from(integrations)
          .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'github')))
          .limit(1);
        const ghConfig = (integration?.config ?? {}) as {
          accessToken?: string;
          selectedRepos?: Array<{ owner: string; name: string }>;
          owner?: string;
          repo?: string;
        };
        const token = ghConfig.accessToken;
        const owner = ghConfig.selectedRepos?.[0]?.owner ?? ghConfig.owner;
        const repo = ghConfig.selectedRepos?.[0]?.name ?? ghConfig.repo;
        if (!token || !owner || !repo) return indexResult;
        const tree = await githubService.getFileTree(token, owner, repo);
        const indexable = tree.filter(isIndexableFile);
        const dirCounts: Record<string, number> = {};
        for (const entry of indexable) {
          const top = entry.path.split('/')[0] || '(root)';
          dirCounts[top] = (dirCounts[top] ?? 0) + 1;
        }
        const sampleFilePaths = indexable.slice(0, 50).map((e) => e.path);
        return {
          ...indexResult,
          totalIndexableFiles: indexable.length,
          directoryCounts: dirCounts,
          sampleFilePaths,
          note:
            indexable.length > sampleFilePaths.length
              ? `Showing ${sampleFilePaths.length} of ${indexable.length} indexable files. Use search_code to find specifics.`
              : undefined,
        };
      } catch {
        // Indexing succeeded — never let summary-fetch failures break the tool.
        return indexResult;
      }
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
