import { apiRequest } from './auth.js';

/**
 * MCP tool definitions and handlers.
 * Each tool calls the SyncDocs REST API via authenticated requests.
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
    name: 'syncdocs_search_docs',
    description: 'Search/list documents in SyncDocs. Returns document IDs, titles, paths, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'Team UUID to scope the search' },
      },
      required: ['team_id'],
    },
  },
  {
    name: 'syncdocs_read_doc',
    description: 'Read a specific document from SyncDocs by ID. Returns full content, title, and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to read' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'syncdocs_check_quality',
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
    name: 'syncdocs_detect_drift',
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
    name: 'syncdocs_create_doc',
    description: 'Create a new document in SyncDocs.',
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
    name: 'syncdocs_update_doc',
    description: 'Update an existing document in SyncDocs.',
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
    name: 'syncdocs_create_ticket',
    description: 'Create a ticket (GitHub issue or Jira) linked to a SyncDocs document.',
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
    name: 'syncdocs_get_timeline',
    description: 'Get the timeline of events for a SyncDocs document.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the document' },
      },
      required: ['document_id'],
    },
  },
];

/**
 * Execute a tool call by routing to the appropriate SyncDocs API endpoint.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'syncdocs_search_docs': {
      return apiRequest(`/api/documents?teamId=${args.team_id}`);
    }
    case 'syncdocs_read_doc': {
      return apiRequest(`/api/documents/${args.document_id}`);
    }
    case 'syncdocs_check_quality': {
      return apiRequest('/api/ai/analyze', {
        method: 'POST',
        body: JSON.stringify({ content: args.content }),
      });
    }
    case 'syncdocs_detect_drift': {
      return apiRequest('/api/ai/detect-drift', {
        method: 'POST',
        body: JSON.stringify({
          specContent: args.spec_content,
          codeContent: args.code_content,
        }),
      });
    }
    case 'syncdocs_create_doc': {
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
    case 'syncdocs_update_doc': {
      const body: Record<string, unknown> = {};
      if (args.title) body.title = args.title;
      if (args.content) body.content = args.content;
      return apiRequest(`/api/documents/${args.document_id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    }
    case 'syncdocs_create_ticket': {
      return apiRequest(`/api/documents/${args.document_id}/tickets`, {
        method: 'POST',
        body: JSON.stringify({
          provider: args.provider,
          title: args.title,
          body: args.body,
        }),
      });
    }
    case 'syncdocs_get_timeline': {
      return apiRequest(`/api/documents/${args.document_id}/timeline`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
