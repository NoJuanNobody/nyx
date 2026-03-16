import type { FastifyPluginAsync } from 'fastify';
import { a2aService } from '../services/a2a.service.js';

export const a2aRoutes: FastifyPluginAsync = async (app) => {
  // ── Agent registration ──────────────────────────────────────────

  // POST /api/a2a/agents — register agent
  app.post('/agents', async (request, reply) => {
    const { name, platform, capabilities, teamId } = request.body as {
      name?: string;
      platform?: string;
      capabilities?: string[];
      teamId?: string;
    };

    if (!name || !platform || !teamId) {
      reply.code(400);
      return { error: 'name, platform, and teamId are required' };
    }

    return a2aService.registerAgent({
      name,
      platform,
      capabilities: capabilities ?? [],
      teamId,
    });
  });

  // DELETE /api/a2a/agents/:id — unregister agent
  app.delete('/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = a2aService.unregisterAgent(id);
    if (!removed) {
      reply.code(404);
      return { error: 'Agent not found' };
    }
    return { removed: true };
  });

  // GET /api/a2a/agents?teamId=X — list agents
  app.get('/agents', async (request, reply) => {
    const { teamId, platform, status } = request.query as {
      teamId?: string;
      platform?: string;
      status?: string;
    };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    return a2aService.listAgents(teamId, { platform, status });
  });

  // POST /api/a2a/agents/:id/heartbeat — heartbeat
  app.post('/agents/:id/heartbeat', async (request) => {
    const { id } = request.params as { id: string };
    a2aService.heartbeat(id);
    return { ok: true };
  });

  // ── Channels ────────────────────────────────────────────────────

  // POST /api/a2a/channels — create channel
  app.post('/channels', async (request, reply) => {
    const { teamId, name, agentIds } = request.body as {
      teamId?: string;
      name?: string;
      agentIds?: string[];
    };

    if (!teamId || !name) {
      reply.code(400);
      return { error: 'teamId and name are required' };
    }

    return a2aService.createChannel({
      teamId,
      name,
      agentIds: agentIds ?? [],
    });
  });

  // GET /api/a2a/channels?teamId=X — list channels
  app.get('/channels', async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    return a2aService.listChannels(teamId);
  });

  // POST /api/a2a/channels/:id/join — join channel
  app.post('/channels/:id/join', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { agentId } = request.body as { agentId?: string };

    if (!agentId) {
      reply.code(400);
      return { error: 'agentId is required' };
    }

    const joined = a2aService.joinChannel(id, agentId);
    if (!joined) {
      reply.code(404);
      return { error: 'Channel not found' };
    }

    return { joined: true };
  });

  // ── Messaging ───────────────────────────────────────────────────

  // POST /api/a2a/channels/:id/messages — send message
  app.post('/channels/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { fromAgentId, toAgentId, type, payload } = request.body as {
      fromAgentId?: string;
      toAgentId?: string;
      type?: string;
      payload?: Record<string, unknown>;
    };

    if (!fromAgentId || !type) {
      reply.code(400);
      return { error: 'fromAgentId and type are required' };
    }

    return a2aService.sendMessage({
      channelId: id,
      fromAgentId,
      toAgentId,
      type,
      payload: payload ?? {},
    });
  });

  // GET /api/a2a/channels/:id/messages — get messages
  app.get('/channels/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const { since, limit } = request.query as {
      since?: string;
      limit?: string;
    };

    return a2aService.getMessages(id, {
      since,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  });

  // POST /api/a2a/messages/:id/ack — acknowledge message
  app.post('/messages/:id/ack', async (request, reply) => {
    const { id } = request.params as { id: string };
    const acked = a2aService.acknowledgeMessage(id);
    if (!acked) {
      reply.code(404);
      return { error: 'Message not found' };
    }
    return { acknowledged: true };
  });

  // ── Handoff ─────────────────────────────────────────────────────

  // POST /api/a2a/handoff — initiate handoff
  app.post('/handoff', async (request, reply) => {
    const { channelId, fromAgentId, toAgentId, documentId, context } =
      request.body as {
        channelId?: string;
        fromAgentId?: string;
        toAgentId?: string;
        documentId?: string;
        context?: Record<string, unknown>;
      };

    if (!channelId || !fromAgentId || !toAgentId || !documentId) {
      reply.code(400);
      return {
        error:
          'channelId, fromAgentId, toAgentId, and documentId are required',
      };
    }

    return a2aService.initiateHandoff({
      channelId,
      fromAgentId,
      toAgentId,
      documentId,
      context: context ?? {},
    });
  });
};
