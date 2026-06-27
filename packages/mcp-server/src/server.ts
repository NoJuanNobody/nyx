import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { RESOURCE_TEMPLATES, resolveResource } from './resources.js';
import { formatToolResult } from './formatter.js';

export function createMcpServer(): Server {
  const server = new Server(
    { name: 'nyx', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  // ── Tools ────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await executeTool(name, (args ?? {}) as Record<string, unknown>);
      return {
        content: [
          {
            type: 'text' as const,
            text: formatToolResult(name, result),
          },
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

  // ── Resources ────────────────────────────────────────────

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: RESOURCE_TEMPLATES.map((r) => ({
        uriTemplate: r.uriTemplate,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    // Dynamic resource listing — return the static list template
    return { resources: [] };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    try {
      const { content, mimeType } = await resolveResource(uri);
      return {
        contents: [{ uri, text: content, mimeType }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read resource ${uri}: ${message}`);
    }
  });

  return server;
}
