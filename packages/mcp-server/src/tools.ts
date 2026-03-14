import { apiRequest } from './auth.js';
import { performWebSearch } from './search/search.service.js';

/**
 * MCP tool definitions and handlers.
 * Each tool calls the Nyx REST API via authenticated requests.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'nyx_search_docs',
    description: 'Search/list documents in Nyx. Returns document IDs, titles, paths, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'Team UUID to scope the search' },
      },
      required: ['team_id'],
    },
  },
  {
    name: 'nyx_read_doc',
    description: 'Read a specific document from Nyx by ID. Returns full content, title, and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to read' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'nyx_check_quality',
    description: 'Run AI quality analysis on spec content. Returns a quality score (1-10) and improvement suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The spec content to analyze' },
      },
      required: ['content'],
    },
  },
  {
    name: 'nyx_detect_drift',
    description: 'Detect drift between a specification and code. Returns drift score and details.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_content: { type: 'string', description: 'The specification document content' },
        code_content: { type: 'string', description: 'The code to compare against' },
      },
      required: ['spec_content', 'code_content'],
    },
  },
  {
    name: 'nyx_create_doc',
    description: 'Create a new document in Nyx.',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'Team UUID for the document' },
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Document content (markdown)' },
        path: { type: 'string', description: 'Document path (e.g. /api/auth)' },
      },
      required: ['team_id', 'title', 'content'],
    },
  },
  {
    name: 'nyx_update_doc',
    description: 'Update an existing document in Nyx.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to update' },
        title: { type: 'string', description: 'New title (optional)' },
        content: { type: 'string', description: 'New content (optional)' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'nyx_create_ticket',
    description: 'Create a ticket (GitHub issue or Jira) linked to a Nyx document.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the linked document' },
        provider: { type: 'string', enum: ['github', 'jira'], description: 'Ticket provider' },
        title: { type: 'string', description: 'Ticket title' },
        body: { type: 'string', description: 'Ticket description body (markdown)' },
      },
      required: ['document_id', 'provider', 'title', 'body'],
    },
  },
  {
    name: 'nyx_get_timeline',
    description: 'Get the timeline of events for a Nyx document.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the document' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'nyx_web_search',
    description:
      'Search the web for information relevant to documentation. Returns search results with titles, URLs, and snippets. Useful for finding API references, library documentation, changelogs, and technical articles.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        search_type: {
          type: 'string',
          enum: ['general', 'api_reference', 'changelog', 'documentation'],
          description: 'Type of search to optimize results (default: general)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (1-10, default: 5)',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * Execute a tool call by routing to the appropriate Nyx API endpoint.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'nyx_search_docs': {
      return apiRequest(`/api/documents?teamId=${args.team_id}`);
    }
    case 'nyx_read_doc': {
      return apiRequest(`/api/documents/${args.document_id}`);
    }
    case 'nyx_check_quality': {
      return apiRequest('/api/ai/analyze', {
        method: 'POST',
        body: JSON.stringify({ content: args.content }),
      });
    }
    case 'nyx_detect_drift': {
      return apiRequest('/api/ai/detect-drift', {
        method: 'POST',
        body: JSON.stringify({
          specContent: args.spec_content,
          codeContent: args.code_content,
        }),
      });
    }
    case 'nyx_create_doc': {
      return apiRequest('/api/documents', {
        method: 'POST',
        body: JSON.stringify({
          teamId: args.team_id,
          title: args.title,
          content: args.content,
          path: args.path ?? '/',
        }),
      });
    }
    case 'nyx_update_doc': {
      const body: Record<string, unknown> = {};
      if (args.title) body.title = args.title;
      if (args.content) body.content = args.content;
      return apiRequest(`/api/documents/${args.document_id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    }
    case 'nyx_create_ticket': {
      return apiRequest(`/api/documents/${args.document_id}/tickets`, {
        method: 'POST',
        body: JSON.stringify({
          provider: args.provider,
          title: args.title,
          body: args.body,
        }),
      });
    }
    case 'nyx_get_timeline': {
      return apiRequest(`/api/documents/${args.document_id}/timeline`);
    }
    case 'nyx_web_search': {
      const query = args.query as string;
      const searchType = (args.search_type as string) ?? 'general';
      const maxResults = Math.min(Math.max((args.max_results as number) ?? 5, 1), 10);

      const results = await performWebSearch(query, searchType, maxResults);
      return results;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
