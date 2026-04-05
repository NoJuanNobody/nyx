import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { apiRequest } from './auth.js';
import { performWebSearch } from './search/search.service.js';

const MAX_FILE_SIZE = 100 * 1024; // 100 KB

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
    name: 'nyx_generate_podcast',
    description:
      'Generate a podcast script from one or more Nyx documents. Returns a two-host conversational script with quality score.',
    inputSchema: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'Team UUID' },
        document_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of document UUIDs to generate the podcast from',
        },
        title: { type: 'string', description: 'Optional podcast title' },
      },
      required: ['team_id', 'document_ids'],
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
      'Read a local file from the user\'s filesystem. Returns file contents. Useful for comparing code against specs, checking compliance, or importing content into Nyx documents. Max 100 KB.',
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
      'List files and directories at a given path on the user\'s filesystem. Useful for exploring project structure before reading specific files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list (defaults to current working directory)' },
      },
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
    case 'nyx_join_meeting': {
      return apiRequest('/api/voice/join', {
        method: 'POST',
        body: JSON.stringify({
          platform: args.platform,
          meetingUrl: args.meeting_url,
        }),
      });
    }
    case 'nyx_leave_meeting': {
      return apiRequest('/api/voice/leave', {
        method: 'POST',
        body: JSON.stringify({ sessionId: args.session_id }),
      });
    }
    case 'nyx_meeting_status': {
      return apiRequest(`/api/voice/status/${args.session_id}`);
    }
    case 'nyx_generate_meeting_doc': {
      return apiRequest('/api/voice/documents/from-meeting', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: args.session_id,
          teamId: args.team_id,
        }),
      });
    }
    case 'nyx_list_teams': {
      return apiRequest('/api/teams');
    }
    case 'nyx_get_team': {
      return apiRequest(`/api/teams/${args.team_id}`);
    }
    case 'nyx_create_team': {
      return apiRequest('/api/teams', {
        method: 'POST',
        body: JSON.stringify({
          name: args.name,
          slug: args.slug,
        }),
      });
    }
    case 'nyx_delete_doc': {
      return apiRequest(`/api/documents/${args.document_id}`, {
        method: 'DELETE',
      });
    }
    case 'nyx_list_versions': {
      return apiRequest(`/api/documents/${args.document_id}/versions`);
    }
    case 'nyx_generate_podcast': {
      return apiRequest('/api/podcast/generate', {
        method: 'POST',
        body: JSON.stringify({
          teamId: args.team_id,
          documentIds: args.document_ids,
          title: args.title,
        }),
      });
    }
    case 'nyx_web_search': {
      const query = args.query as string;
      const searchType = (args.search_type as string) ?? 'general';
      const maxResults = Math.min(Math.max((args.max_results as number) ?? 5, 1), 10);

      const results = await performWebSearch(query, searchType, maxResults);
      return results;
    }
    case 'nyx_read_file': {
      const filePath = nodePath.resolve(args.path as string);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        throw new Error(`Path is a directory, not a file: ${filePath}. Use nyx_list_files instead.`);
      }
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${Math.round(stats.size / 1024)} KB (max 100 KB)`);
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const ext = nodePath.extname(filePath).slice(1) || 'txt';
      return { path: filePath, extension: ext, content };
    }
    case 'nyx_list_files': {
      const dirPath = nodePath.resolve((args.path as string) ?? '.');
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      }));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
