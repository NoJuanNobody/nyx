import { eq, and, desc, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { documents, documentVersions, integrations, notifications } from '../../db/schema.js';
import { aiService } from '../ai.service.js';
import { ticketService } from '../ticket.service.js';
import { auditService } from '../audit.service.js';
import { githubService } from '../github.service.js';
import { webSearch } from '../search.service.js';
import { intakeService } from '../intake.service.js';
import { suggestionService } from '../suggestion.service.js';
import { changeProposalService } from '../change-proposal.service.js';
import { exportService } from '../export.service.js';
import { retrieveChunks } from '../retrieval.service.js';
import { checkCompliance } from '../compliance.service.js';
import { ttsService } from '../tts.service.js';
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
      return { id: doc.id, title: doc.title, content: doc.content, status: doc.status, path: doc.path };
    }

    case 'list_documents': {
      const teamId = (input.team_id as string) || ctx.teamId;
      const docs = await db
        .select({ id: documents.id, title: documents.title, status: documents.status, path: documents.path })
        .from(documents)
        .where(eq(documents.teamId, teamId));
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
      return { id: updated.id, title: updated.title, status: updated.status };
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
        const content = await githubService.getFileContent(ghConfig.accessToken, owner, repo, filePath);
        return { path: filePath, content };
      }
      const tree = await githubService.getFileTree(ghConfig.accessToken, owner, repo);
      return tree;
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

      return { id: created.id, title: created.title, status: created.status, stage: created.stage };
    }

    case 'delete_document': {
      assertCanWrite(ctx);
      const docId = input.document_id as string;
      if (!docId) throw new Error('delete_document requires document_id');

      const [updated] = await db
        .update(documents)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(documents.id, docId))
        .returning();
      if (!updated) throw new Error('Document not found');

      return { id: updated.id, title: updated.title, status: updated.status };
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

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
