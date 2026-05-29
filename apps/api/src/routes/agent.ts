import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { agentSessions, agentToolCalls, teams, documents } from '../db/schema.js';
import { runAgentLoop } from '../services/agent/loop.js';
import { getWorkflow, listWorkflows } from '../services/agent/workflows.js';
import { auditService } from '../services/audit.service.js';
import type { AgentContext, AgentEvent } from '../services/agent/types.js';
import { sseCorsHeaders } from '../lib/cors.js';

// Track running sessions for cancellation
const runningSessions = new Map<string, { cancel: () => void }>();

export const agentRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List available workflows ────────────────────────────
  fastify.get('/workflows', async () => {
    return listWorkflows().map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      defaultPrompt: w.defaultPrompt,
      postSessionSuggestions: w.postSessionSuggestions,
    }));
  });

  // ── Start agent session (SSE) ──────────────────────────
  fastify.post<{
    Body: {
      prompt: string;
      workflowId?: string;
      documentId?: string;
      teamId: string;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
      conversationId?: string;
    };
  }>('/', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { prompt, workflowId, documentId, teamId, conversationId } = request.body;
    let history = request.body.history;
    const user = request.user;

    // If resuming a conversation, reconstruct history from prior sessions
    if (conversationId) {
      try {
        const priorSessions = await db
          .select({ prompt: agentSessions.prompt, result: agentSessions.result })
          .from(agentSessions)
          .where(eq(agentSessions.conversationId, conversationId))
          .orderBy(agentSessions.createdAt);

        const reconstructedHistory = priorSessions
          .filter(s => s.result)
          .flatMap(s => [
            { role: 'user' as const, content: s.prompt },
            { role: 'assistant' as const, content: s.result! },
          ]);

        // Server-reconstructed history takes precedence; ignore client history to avoid duplication
        history = reconstructedHistory;
      } catch {
        // conversationId column may not exist yet (migration pending) — fall through
      }
    }

    // Create session record — conversationId may not exist if migration hasn't run
    let session: { id: string };
    try {
      const [row] = await db.insert(agentSessions).values({
        teamId,
        userId: user.id,
        documentId: documentId ?? null,
        conversationId: conversationId ?? null,
        prompt,
        status: 'running',
      }).returning();
      session = row;
    } catch {
      // Fallback: insert without conversationId if column doesn't exist yet
      const [row] = await db.insert(agentSessions).values({
        teamId,
        userId: user.id,
        documentId: documentId ?? null,
        prompt,
        status: 'running',
      } as typeof agentSessions.$inferInsert).returning();
      session = row;
    }

    // Determine system prompt and tools
    const workflow = workflowId ? getWorkflow(workflowId) : undefined;
    const baseSystemPrompt = workflow?.systemPrompt ??
      'You are a helpful AI assistant for Nyx, a documentation platform. Use the available tools to help the user with their request. Be thorough and provide clear, actionable results.\n\nIMPORTANT: Use `update_document` only when the user wants to improve or edit document content. Use `create_ticket` when the user wants to track action items, bugs, or tasks — do not describe tickets in text, call the tool instead. Never substitute one for the other.\n\nCODEBASE SEARCH: When you need to understand code, ALWAYS use `search_code` first — it returns small, relevant snippets via semantic search and is much cheaper than reading full files. Only fall back to `get_github_files` if search_code returns no results or you need a specific file path you already know. Never read more than 2-3 files per turn with get_github_files.';
    const toolNames = workflow?.tools;

    // Enrich system prompt with team/user/document context
    let systemPrompt = baseSystemPrompt;
    try {
      const [teamRows, recentDocs] = await Promise.all([
        db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId)).limit(1),
        db.select({ id: documents.id, title: documents.title, stage: documents.stage })
          .from(documents).where(and(eq(documents.teamId, teamId), isNull(documents.deletedAt)))
          .orderBy(desc(documents.updatedAt)).limit(5),
      ]);

      const teamName = teamRows[0]?.name ?? 'Unknown';
      const docsContext = recentDocs.length > 0
        ? `Recent documents:\n${recentDocs.map(d => `- "${d.title}" (${d.id}, stage: ${d.stage ?? 'none'})`).join('\n')}`
        : 'No documents in this team yet.';

      systemPrompt = `${baseSystemPrompt}\n\n--- Context ---\nUser: ${user.name} (${user.email}), role: ${user.role}\nTeam: ${teamName} (ID: ${teamId})\nWhen calling tools that accept a team_id parameter, always use "${teamId}".\n${docsContext}\n---`;
    } catch {
      // Context enrichment failed — proceed with base prompt
    }

    // Build user prompt with document context
    let fullPrompt = prompt;
    if (documentId && workflow?.defaultPrompt && prompt === workflow.defaultPrompt) {
      fullPrompt = `${prompt}\n\nDocument ID: ${documentId}`;
    } else if (documentId) {
      fullPrompt = `${prompt}\n\nContext: The user is working with document ID ${documentId}.`;
    }

    // Assign conversation ID: reuse existing or start a new conversation with this session's ID
    const activeConversationId = conversationId ?? session.id;

    // Back-fill the conversation ID on this session if it's a new conversation
    if (!conversationId) {
      try {
        await db.update(agentSessions)
          .set({ conversationId: activeConversationId })
          .where(eq(agentSessions.id, session.id));
      } catch {
        // conversationId column may not exist yet — safe to skip
      }
    }

    // Set up SSE response
    let cancelled = false;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Session-Id': session.id,
      'X-Conversation-Id': activeConversationId,
      // Raw SSE responses bypass the @fastify/cors onSend hook, so set CORS
      // headers explicitly or the browser blocks the cross-origin stream.
      ...sseCorsHeaders(request.headers.origin),
    });

    const sendEvent = (event: AgentEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Register cancellation handler
    runningSessions.set(session.id, {
      cancel: () => { cancelled = true; },
    });

    request.raw.on('close', () => {
      cancelled = true;
    });

    const context: AgentContext = {
      userId: user.id,
      userRole: user.role,
      teamId,
      documentId,
      sessionId: session.id,
      onEvent: sendEvent,
      cancelled: () => cancelled,
    };

    // Run agent loop (async — streams via SSE)
    try {
      await runAgentLoop({
        systemPrompt,
        userPrompt: fullPrompt,
        toolNames,
        workflowId: workflowId ?? undefined,
        context,
        history,
      });

      // Record audit event
      await auditService.recordEvent({
        teamId,
        eventType: 'agent_workflow',
        actorId: user.id,
        documentId,
        metadata: {
          sessionId: session.id,
          workflowId: workflowId ?? 'custom',
          prompt,
        },
      }).catch(() => {});
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      await db.update(agentSessions).set({
        status: 'failed',
        result: errorMsg,
      }).where(eq(agentSessions.id, session.id));

      sendEvent({ type: 'status', status: 'failed' });
      sendEvent({ type: 'text', text: `Error: ${errorMsg}` });
    } finally {
      runningSessions.delete(session.id);
      reply.raw.end();
    }
  });

  // ── Get completed session ───────────────────────────────
  fastify.get<{ Params: { sessionId: string } }>('/:sessionId', async (request) => {
    const { sessionId } = request.params;

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);

    if (!session) {
      throw { statusCode: 404, message: 'Session not found' };
    }

    const toolCallRecords = await db
      .select()
      .from(agentToolCalls)
      .where(eq(agentToolCalls.sessionId, sessionId))
      .orderBy(agentToolCalls.sequence);

    return { session, toolCalls: toolCallRecords };
  });

  // ── Cancel running session ──────────────────────────────
  fastify.post<{ Params: { sessionId: string } }>('/:sessionId/cancel', async (request) => {
    const { sessionId } = request.params;

    const running = runningSessions.get(sessionId);
    if (running) {
      running.cancel();
      return { cancelled: true };
    }

    // Already finished — update status if still 'running'
    await db.update(agentSessions)
      .set({ status: 'cancelled' })
      .where(eq(agentSessions.id, sessionId));

    return { cancelled: true };
  });

  // ── List sessions for team ──────────────────────────────
  fastify.get<{ Querystring: { teamId: string; limit?: string } }>('/sessions', async (request) => {
    const { teamId, limit } = request.query;
    const sessions = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.teamId, teamId))
      .orderBy(desc(agentSessions.createdAt))
      .limit(Number(limit) || 20);

    return sessions;
  });
};
