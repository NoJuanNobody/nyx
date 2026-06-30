import type { NyxClient } from './client.js';

/**
 * Protocol-agnostic tool definition interface.
 * Compatible with MCP, OpenAI function calling, and other AI tool protocols.
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

/**
 * All Nyx tool definitions — usable by any agent integration
 * (MCP, OpenAI, Cursor, Copilot, etc.) without modification.
 */
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
    name: 'nyx_list_teams',
    description:
      'List all teams the authenticated user belongs to. Returns team IDs, names, slugs, and roles.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'nyx_get_team',
    description: 'Get details for a specific team by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'UUID of the team' },
      },
      required: ['team_id'],
    },
  },
  {
    name: 'nyx_create_team',
    description: 'Create a new team in Nyx.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Team display name' },
        slug: { type: 'string', description: 'URL-friendly team slug' },
      },
      required: ['name', 'slug'],
    },
  },
  {
    name: 'nyx_delete_doc',
    description: 'Delete a document from Nyx by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to delete' },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'nyx_list_versions',
    description: 'List version history for a document. Returns version numbers, messages, and timestamps.',
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
  {
    name: 'nyx_join_meeting',
    description:
      'Join a live meeting (Zoom, Google Meet, or Teams) with the Nyx voice agent. The agent joins as a participant and captures the transcript in real time.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['zoom', 'google_meet', 'teams'],
          description: 'Meeting platform',
        },
        meeting_url: { type: 'string', description: 'The meeting invite URL' },
      },
      required: ['platform', 'meeting_url'],
    },
  },
  {
    name: 'nyx_leave_meeting',
    description: 'Remove the Nyx voice agent from an active meeting session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID returned by nyx_join_meeting' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'nyx_meeting_status',
    description:
      'Check the current status of a voice agent meeting session. Returns state (idle, connecting, in_call, ended, error), platform, and timing info.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID to check' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'nyx_generate_meeting_doc',
    description:
      'Generate a Nyx document from a completed meeting session. Extracts decisions, action items, code references, and open questions from the transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The meeting session ID' },
        team_id: { type: 'string', description: 'Team UUID to create the document under' },
      },
      required: ['session_id', 'team_id'],
    },
  },
  {
    name: 'nyx_read_file',
    description:
      "Read a local file from the user's filesystem. Returns file contents. Useful for comparing code against specs, checking compliance, or importing content into Nyx documents. Max 100 KB.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'nyx_list_files',
    description:
      "List files and directories at a given path on the user's filesystem. Useful for exploring project structure before reading specific files.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list (defaults to current working directory)' },
      },
    },
  },
];

/**
 * Execute an API-backed tool call via a NyxClient instance.
 *
 * Note: nyx_web_search, nyx_read_file, and nyx_list_files are NOT handled here —
 * those tools depend on runtime capabilities (web search providers, local filesystem)
 * that are environment-specific. Callers should handle those tool names before
 * passing to this function, or pass a `localHandler` for them.
 *
 * @throws {Error} for unknown tool names
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  client: NyxClient,
): Promise<unknown> {
  switch (name) {
    case 'nyx_search_docs': {
      return client.get(`/api/documents?teamId=${args.team_id}`);
    }
    case 'nyx_read_doc': {
      return client.get(`/api/documents/${args.document_id}`);
    }
    case 'nyx_check_quality': {
      return client.post('/api/ai/analyze', { content: args.content });
    }
    case 'nyx_detect_drift': {
      return client.post('/api/ai/detect-drift', {
        specContent: args.spec_content,
        codeContent: args.code_content,
      });
    }
    case 'nyx_create_doc': {
      return client.post('/api/documents', {
        teamId: args.team_id,
        title: args.title,
        content: args.content,
        path: args.path ?? '/',
      });
    }
    case 'nyx_update_doc': {
      const body: Record<string, unknown> = {};
      if (args.title) body.title = args.title;
      if (args.content) body.content = args.content;
      return client.put(`/api/documents/${args.document_id}`, body);
    }
    case 'nyx_create_ticket': {
      return client.post(`/api/documents/${args.document_id}/tickets`, {
        provider: args.provider,
        title: args.title,
        body: args.body,
      });
    }
    case 'nyx_get_timeline': {
      return client.get(`/api/documents/${args.document_id}/timeline`);
    }
    case 'nyx_join_meeting': {
      return client.post('/api/voice/join', {
        platform: args.platform,
        meetingUrl: args.meeting_url,
      });
    }
    case 'nyx_leave_meeting': {
      return client.post('/api/voice/leave', { sessionId: args.session_id });
    }
    case 'nyx_meeting_status': {
      return client.get(`/api/voice/status/${args.session_id}`);
    }
    case 'nyx_generate_meeting_doc': {
      return client.post('/api/voice/documents/from-meeting', {
        sessionId: args.session_id,
        teamId: args.team_id,
      });
    }
    case 'nyx_list_teams': {
      return client.get('/api/teams');
    }
    case 'nyx_get_team': {
      return client.get(`/api/teams/${args.team_id}`);
    }
    case 'nyx_create_team': {
      return client.post('/api/teams', {
        name: args.name,
        slug: args.slug,
      });
    }
    case 'nyx_delete_doc': {
      return client.delete(`/api/documents/${args.document_id}`);
    }
    case 'nyx_list_versions': {
      return client.get(`/api/documents/${args.document_id}/versions`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
