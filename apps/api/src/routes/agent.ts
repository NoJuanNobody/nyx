import type { FastifyPluginAsync } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { agentSessions, agentToolCalls } from '../db/schema.js';
import { runAgentLoop } from '../services/agent/loop.js';
import { getWorkflow, listWorkflows } from '../services/agent/workflows.js';
import { auditService } from '../services/audit.service.js';
import type { AgentContext, AgentEvent } from '../services/agent/types.js';

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
    };
  }>('/', async (request, reply) => {
    const { prompt, workflowId, documentId, teamId } = request.body;
    const user = request.user;

    // Create session record
    const [session] = await db.insert(agentSessions).values({
      teamId,
      userId: user.id,
      documentId: documentId ?? null,
      prompt,
      status: 'running',
    }).returning();

    // Determine system prompt and tools
    const workflow = workflowId ? getWorkflow(workflowId) : undefined;
    const systemPrompt = workflow?.systemPrompt ??
      'You are a helpful AI assistant for Nyx, a documentation platform. Use the available tools to help the user with their request. Be thorough and provide clear, actionable results.\n\nIMPORTANT: Use `update_document` only when the user wants to improve or edit document content. Use `create_ticket` when the user wants to track action items, bugs, or tasks — do not describe tickets in text, call the tool instead. Never substitute one for the other.';
    const toolNames = workflow?.tools;

    // Build user prompt with document context
    let fullPrompt = prompt;
    if (documentId && workflow?.defaultPrompt && prompt === workflow.defaultPrompt) {
      fullPrompt = `${prompt}\n\nDocument ID: ${documentId}`;
    } else if (documentId) {
      fullPrompt = `${prompt}\n\nContext: The user is working with document ID ${documentId}.`;
    }

    // Set up SSE response
    let cancelled = false;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Session-Id': session.id,
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
