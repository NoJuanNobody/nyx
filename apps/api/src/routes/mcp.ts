import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { generateClerkProtectedResourceMetadata } from '@clerk/mcp-tools/server';
import { TOOL_DEFINITIONS, executeTool, NyxClient } from '@nyx/harness-core';
import { verifyClerkOAuthToken } from '../lib/clerk.js';
import { resolveClerkUser } from '../middleware/auth.js';
import { randomUUID } from 'node:crypto';
import {
  CREDIT_COSTS,
  LedgerError,
  getCreditsService,
  normalizeAgentId,
  userWorkspace,
} from '../services/credits.service.js';
import { config } from '../lib/config.js';

// These tools depend on the local filesystem or a local search provider; they
// have no meaning on a remote server and are omitted from the hosted toolset.
const LOCAL_ONLY_TOOLS = new Set(['nyx_read_file', 'nyx_list_files', 'nyx_web_search']);

const REMOTE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(
  (t) => !LOCAL_ONLY_TOOLS.has(t.name),
);

// Tools that consume account credits, mapped to their credit-cost task type.
// Anything not listed (reads, metadata, meeting control) is free.
const TOOL_TASK_TYPE: Record<string, string> = {
  nyx_check_quality: 'spec_analysis',
  nyx_detect_drift: 'drift_detection',
  nyx_create_doc: 'document_generation',
  nyx_update_doc: 'document_generation',
  nyx_generate_meeting_doc: 'document_generation',
  nyx_create_ticket: 'ticket_generation',
};

// ── Internal helpers ──────────────────────────────────────

/**
 * The public base URL of this API, used to build RFC 9728 metadata. Prefers an
 * explicit WEBHOOK_BASE_URL, then the client-facing host from the incoming
 * request (correct behind a proxy), and only falls back to localhost when
 * neither is available — never advertising localhost in a real deployment.
 */
function getApiBase(request: FastifyRequest): string {
  if (config.WEBHOOK_BASE_URL) return config.WEBHOOK_BASE_URL;

  const proto = String(request.headers['x-forwarded-proto'] ?? request.protocol)
    .split(',')[0]
    .trim();
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '')
    .split(',')[0]
    .trim();

  return host ? `${proto}://${host}` : `http://localhost:${config.PORT}`;
}

/**
 * Build a stateless MCP server bound to one authenticated user. Tools execute
 * by self-calling the Nyx REST API with the caller's OAuth token (the global
 * auth middleware accepts it), and AI/generation tools are metered against the
 * calling agent's credit budget (reserve, then commit or release).
 */
function buildMcpServer(bearerToken: string, userId: string): Server {
  // Self-call: the MCP tools call the Nyx REST API, which is this same process.
  // We use 127.0.0.1:PORT to avoid going through the public load balancer.
  const selfUrl = config.MCP_SELF_URL ?? `http://127.0.0.1:${config.PORT}`;
  const client = new NyxClient({ apiKey: bearerToken, apiUrl: selfUrl });

  const server = new Server(
    { name: 'nyx', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: REMOTE_TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (LOCAL_ONLY_TOOLS.has(name)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Tool '${name}' is only available in local (stdio) mode.`,
          },
        ],
        isError: true,
      };
    }

    // ── Credit metering: reserve before, commit/release after ──────────
    // The calling agent is identified by its MCP client name (e.g. claude-code).
    const taskType = TOOL_TASK_TYPE[name];
    const cost = taskType ? CREDIT_COSTS[taskType] ?? 0 : 0;
    const agentId = normalizeAgentId(server.getClientVersion()?.name);
    const callKey = `mcp:${userId}:${randomUUID()}`;
    const ws = userWorkspace(userId);
    let reservationId: string | null = null;
    const credits = cost > 0 ? await getCreditsService() : null;
    if (credits) {
      try {
        const r = await credits.reserve(ws, {
          agentId,
          amount: cost,
          idempotencyKey: `${callKey}:reserve`,
          taskType,
          memo: `MCP tool ${name}`,
        });
        reservationId = r.entry.id;
      } catch (err) {
        if (err instanceof LedgerError && err.code === 'INSUFFICIENT_CREDITS') {
          const bal = await credits.getBalance(ws, agentId);
          const available = bal.agents.find((a) => a.agentId === agentId)?.available ?? 0;
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'insufficient_credits',
                  message: `'${name}' costs ${cost} credit(s) but agent '${agentId}' has ${available}. Ask the workspace owner to allocate more credits to this agent.`,
                  available,
                  required: cost,
                  agentId,
                }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    }

    try {
      const result = await executeTool(
        name,
        (args ?? {}) as Record<string, unknown>,
        client,
      );

      if (credits && reservationId) {
        await credits.commit(agentId, {
          reservationId,
          actualAmount: cost,
          idempotencyKey: `${callKey}:commit`,
          memo: `MCP tool ${name}`,
        });
      }

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      // Failed work is not charged: hand the hold back to the agent.
      if (credits && reservationId) {
        await credits
          .release(agentId, { reservationId, idempotencyKey: `${callKey}:release`, memo: 'tool failed' })
          .catch(() => {}); // an expired/closed hold is already settled by the ledger
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

function resourceMetadataUrl(base: string): string {
  return `${base}/.well-known/oauth-protected-resource`;
}

function wwwAuthenticate(metadataUrl: string, extra?: string): string {
  return `Bearer realm="Nyx MCP", resource_metadata="${metadataUrl}"${extra ? `, ${extra}` : ''}`;
}

// ── Route plugin ──────────────────────────────────────────

export const mcpRoutes: FastifyPluginAsync = async (fastify) => {
  // Protected Resource Metadata (RFC 9728) — lets an MCP client discover Clerk
  // as the authorization server from the MCP URL alone and begin the OAuth
  // login flow. Built by @clerk/mcp-tools so the advertised endpoints match
  // Clerk's actual authorization server (no hand-guessed domains).
  fastify.get('/.well-known/oauth-protected-resource', async (request, reply) => {
    const apiBase = getApiBase(request);
    reply.header('Cache-Control', 'public, max-age=3600');

    if (config.CLERK_PUBLISHABLE_KEY) {
      return generateClerkProtectedResourceMetadata({
        publishableKey: config.CLERK_PUBLISHABLE_KEY,
        resourceUrl: `${apiBase}/api/mcp`,
        properties: {
          resource_documentation: `${config.APP_URL ?? 'https://nyx-creative.com'}/docs/mcp`,
        },
      });
    }

    // Clerk not configured (local dev): minimal, valid metadata.
    return {
      resource: `${apiBase}/api/mcp`,
      authorization_servers: [],
      bearer_methods_supported: ['header'],
    };
  });

  // MCP Streamable HTTP endpoint — handles POST (JSON-RPC), GET (SSE stream),
  // and DELETE (session teardown) as per the 2025-06-18 MCP spec.
  fastify.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/mcp',
    handler: async (request, reply) => {
      const metaUrl = resourceMetadataUrl(getApiBase(request));

      // ── Auth: Clerk OAuth token (browser login), no API key ──
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        reply.header('WWW-Authenticate', wwwAuthenticate(metaUrl));
        return reply.code(401).send({
          error: 'Authentication required',
          hint: 'Connect with `claude mcp add --transport http nyx <url>` and log in.',
          resource_metadata: metaUrl,
        });
      }

      const oauth = await verifyClerkOAuthToken(authHeader).catch(() => null);
      const authUser = oauth ? await resolveClerkUser(oauth.clerkUserId) : null;
      if (!authUser) {
        reply.header(
          'WWW-Authenticate',
          wwwAuthenticate(metaUrl, 'error="invalid_token"'),
        );
        return reply.code(401).send({
          error: 'Invalid or expired token — log in again to reconnect.',
          resource_metadata: metaUrl,
        });
      }

      // ── MCP transport ───────────────────────────────────
      const token = authHeader.slice(7);
      const server = buildMcpServer(token, authUser.id);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless: one transport per request
      });

      await server.connect(transport);

      // handleRequest writes directly to the raw Node.js ServerResponse,
      // so we hijack Fastify's response lifecycle to prevent double-writes.
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } finally {
        reply.hijack();
        setImmediate(() => server.close().catch(() => {}));
      }
    },
  });
};
