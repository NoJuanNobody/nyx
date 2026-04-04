import type { FastifyPluginAsync } from 'fastify';
import type { AgentType, AgentState } from '../services/agent/registry.types.js';
import {
  listAgents,
  getAgent,
  registerAgent,
  updateState,
  updateConfig,
  enableForWorkspace,
  disableForWorkspace,
} from '../services/agent/registry.js';

export const agentRegistryRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List all registered agents ──────────────────────────
  fastify.get('/', async () => {
    return listAgents();
  });

  // ── Get agent details + current state ───────────────────
  fastify.get<{ Params: { type: string } }>('/:type', async (request, reply) => {
    const agent = getAgent(request.params.type as AgentType);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    return agent;
  });

  // ── Register a new agent ──────────────────────────────
  fastify.post<{
    Body: {
      type: string;
      name: string;
      url?: string;
      description?: string;
      capabilities?: string[];
    };
  }>('/', async (request, reply) => {
    try {
      const { type, name, url, description, capabilities } = request.body;
      const entry = registerAgent({
        type: type as AgentType,
        name,
        description: description ?? `Agent at ${url ?? 'unknown'}`,
        capabilities: capabilities ?? [],
        currentState: 'idle',
        config: url ? { url } : {},
        enabledWorkspaces: [],
      });
      return reply.status(201).send(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });

  // ── Update agent state ─────────────────────────────────
  fastify.put<{ Params: { type: string }; Body: { state: string } }>(
    '/:type/state',
    async (request, reply) => {
      try {
        const entry = updateState(
          request.params.type as AgentType,
          request.body.state as AgentState,
        );
        return entry;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.status(400).send({ error: message });
      }
    },
  );

  // ── Update agent config ────────────────────────────────
  fastify.put<{ Params: { type: string }; Body: Record<string, unknown> }>(
    '/:type/config',
    async (request, reply) => {
      try {
        const entry = updateConfig(request.params.type as AgentType, request.body);
        return entry;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.status(400).send({ error: message });
      }
    },
  );

  // ── Enable agent for workspace ─────────────────────────
  fastify.post<{ Params: { type: string }; Body: { workspaceId: string } }>(
    '/:type/enable',
    async (request, reply) => {
      try {
        const entry = enableForWorkspace(
          request.params.type as AgentType,
          request.body.workspaceId,
        );
        return entry;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.status(400).send({ error: message });
      }
    },
  );

  // ── Disable agent for workspace ────────────────────────
  fastify.post<{ Params: { type: string }; Body: { workspaceId: string } }>(
    '/:type/disable',
    async (request, reply) => {
      try {
        const entry = disableForWorkspace(
          request.params.type as AgentType,
          request.body.workspaceId,
        );
        return entry;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.status(400).send({ error: message });
      }
    },
  );
};
