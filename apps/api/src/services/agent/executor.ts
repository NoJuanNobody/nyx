import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { documents, documentVersions, integrations } from '../../db/schema.js';
import { aiService } from '../ai.service.js';
import { ticketService } from '../ticket.service.js';
import { auditService } from '../audit.service.js';
import { githubService } from '../github.service.js';
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

      const ghConfig = integration.config as { accessToken: string; owner: string; repo: string };
      if (!ghConfig.accessToken || !ghConfig.owner || !ghConfig.repo) {
        throw new Error('GitHub integration is missing required configuration');
      }

      if (filePath) {
        const content = await githubService.getFileContent(ghConfig.accessToken, ghConfig.owner, ghConfig.repo, filePath);
        return { path: filePath, content };
      }
      const tree = await githubService.getFileTree(ghConfig.accessToken, ghConfig.owner, ghConfig.repo);
      return tree;
    }

    case 'create_ticket': {
      assertCanWrite(ctx);
      const ticket = await ticketService.createFromDocument(
        input.document_id as string,
        input.provider as 'github' | 'jira',
        input.title as string,
        input.body as string,
        ctx.userId,
      );
      return { id: ticket.id, title: ticket.title, externalUrl: ticket.externalUrl };
    }

    case 'search_audit_trail': {
      const events = await auditService.getTrailForDocument(input.document_id as string);
      return events.slice(0, 50); // Limit to prevent massive payloads
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
