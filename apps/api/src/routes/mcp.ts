import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, executeTool, NyxClient } from '@nyx/harness-core';
import { validateApiKey } from '../middleware/auth.js';
import { config } from '../lib/config.js';

// These tools depend on the local filesystem or a local search provider; they
// have no meaning on a remote server and are omitted from the hosted toolset.
const LOCAL_ONLY_TOOLS = new Set(['nyx_read_file', 'nyx_list_files', 'nyx_web_search']);

const REMOTE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter(
  (t) => !LOCAL_ONLY_TOOLS.has(t.name),
);

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

function buildMcpServer(bearerToken: string): Server {
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

    try {
      const result = await executeTool(
        name,
        (args ?? {}) as Record<string, unknown>,
        client,
      );
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
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
  // Protected Resource Metadata (RFC 9728) — allows MCP clients to discover
  // the authorization server (Clerk) from the MCP URL alone.
  fastify.get('/.well-known/oauth-protected-resource', async (request, reply) => {
    const apiBase = getApiBase(request);
    reply.header('Cache-Control', 'public, max-age=3600');
    return {
      resource: `${apiBase}/api/mcp`,
      authorization_servers: config.CLERK_PUBLISHABLE_KEY
        ? [`https://clerk.${new URL(config.APP_URL ?? 'https://nyx-creative.com').hostname}`]
        : [],
      bearer_methods_supported: ['header'],
      resource_documentation: `${config.APP_URL ?? 'https://nyx-creative.com'}/docs/mcp`,
    };
  });

  // MCP Streamable HTTP endpoint — handles POST (JSON-RPC), GET (SSE stream),
  // and DELETE (session teardown) as per the 2025-06-18 MCP spec.
  fastify.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/api/mcp',
    handler: async (request, reply) => {
      const metaUrl = resourceMetadataUrl(getApiBase(request));

      // ── Auth ────────────────────────────────────────────
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        reply.header('WWW-Authenticate', wwwAuthenticate(metaUrl));
        return reply.code(401).send({
          error: 'Authentication required',
          hint: 'Set Authorization: Bearer <sd_key>',
          resource_metadata: metaUrl,
        });
      }

      const token = authHeader.slice(7);
      const validated = await validateApiKey(token);
      if (!validated.ok) {
        reply.header(
          'WWW-Authenticate',
          wwwAuthenticate(metaUrl, 'error="invalid_token"'),
        );
        return reply.code(401).send({
          error: 'Invalid, expired, or revoked API key',
          resource_metadata: metaUrl,
        });
      }

      // ── MCP transport ───────────────────────────────────
      const server = buildMcpServer(token);
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
