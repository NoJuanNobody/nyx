import type { ToolDefinition } from './types.js';

/**
 * All tool schemas available to the agent loop.
 * Each maps to a service call dispatched by the executor.
 */
export const AGENT_TOOLS: Record<string, ToolDefinition> = {
  read_document: {
    name: 'read_document',
    description: 'Read a document by its ID. Returns title, content, status, and metadata.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to read' },
      },
      required: ['document_id'],
    },
  },

  list_documents: {
    name: 'list_documents',
    description: 'List all documents the user has access to, optionally filtered by team.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_id: { type: 'string', description: 'Optional team UUID to filter documents' },
      },
      required: [],
    },
  },

  update_document: {
    name: 'update_document',
    description: 'Update a document\'s title or content. Use this only to improve documentation text. Do not use this when the goal is to track action items — use create_ticket instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to update' },
        title: { type: 'string', description: 'New title (optional)' },
        content: { type: 'string', description: 'New content (optional)' },
      },
      required: ['document_id'],
    },
  },

  get_version_diff: {
    name: 'get_version_diff',
    description: 'Get the diff between two document versions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        version_id_a: { type: 'string', description: 'UUID of the first version' },
        version_id_b: { type: 'string', description: 'UUID of the second version' },
      },
      required: ['version_id_a', 'version_id_b'],
    },
  },

  analyze_spec_quality: {
    name: 'analyze_spec_quality',
    description: 'Run AI-powered quality analysis on spec content. Returns a score and improvement suggestions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The spec content to analyze' },
      },
      required: ['content'],
    },
  },

  detect_drift: {
    name: 'detect_drift',
    description: 'Detect drift between a spec document and code. Returns drift score and details.',
    input_schema: {
      type: 'object' as const,
      properties: {
        spec_content: { type: 'string', description: 'The specification document content' },
        code_content: { type: 'string', description: 'The code to compare against' },
      },
      required: ['spec_content', 'code_content'],
    },
  },

  get_github_files: {
    name: 'get_github_files',
    description: 'Get the file tree or contents of files from a linked GitHub repository.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_id: { type: 'string', description: 'Team UUID to look up GitHub integration' },
        path: { type: 'string', description: 'File path to read content from (omit for file tree)' },
      },
      required: ['team_id'],
    },
  },

  create_ticket: {
    name: 'create_ticket',
    description: 'Create a ticket (GitHub issue or Jira) linked to a document. Each ticket MUST include acceptance criteria, affected file paths, and a scope estimate [S/M/L] in the title. Call this for each discrete actionable item found during review or analysis. Do not summarize tickets in text — call this tool instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the linked document' },
        provider: { type: 'string', enum: ['github', 'jira'], description: 'Ticket provider' },
        title: { type: 'string', description: 'Ticket title' },
        body: { type: 'string', description: 'Ticket description body (markdown)' },
      },
      required: ['document_id', 'provider', 'title', 'body'],
    },
  },

  search_audit_trail: {
    name: 'search_audit_trail',
    description: 'Get the audit trail for a document, showing all tracked events.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document' },
      },
      required: ['document_id'],
    },
  },
};

/**
 * Get tool definitions for a given list of tool names.
 * Returns all tools if no names specified.
 */
export function getToolDefinitions(toolNames?: string[]): ToolDefinition[] {
  if (!toolNames || toolNames.length === 0) {
    return Object.values(AGENT_TOOLS);
  }
  return toolNames
    .filter((name) => AGENT_TOOLS[name])
    .map((name) => AGENT_TOOLS[name]);
}
