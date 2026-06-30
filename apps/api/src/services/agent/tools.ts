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

  web_search: {
    name: 'web_search',
    description: 'Search the web for information. Returns search results with titles, URLs, and snippets. Useful for finding API references, library documentation, technical articles, and general research.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },

  // ── Intake & Spec Writing ──────────────────────────────

  intake_process: {
    name: 'intake_process',
    description: 'Transform raw, unstructured text into a structured product specification with user story, acceptance criteria, edge cases, and open questions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        raw_input: { type: 'string', description: 'Raw text from a founder or PM to convert into a structured spec' },
      },
      required: ['raw_input'],
    },
  },

  improve_document: {
    name: 'improve_document',
    description: 'AI-improve a document\'s content based on quality analysis. Fetches the document, analyzes its quality, and returns improved content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to improve' },
        instruction: { type: 'string', description: 'Optional instruction to guide the improvement' },
      },
      required: ['document_id'],
    },
  },

  // ── Tickets & Proposals ────────────────────────────────

  suggest_tickets: {
    name: 'suggest_tickets',
    description: 'Generate ticket suggestions from a document based on its content and recent changes. Returns suggested tickets with titles and descriptions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to generate ticket suggestions from' },
      },
      required: ['document_id'],
    },
  },

  list_tickets: {
    name: 'list_tickets',
    description: 'List all tickets for the team, optionally filtered by status or provider. Returns ticket IDs, titles, status, and external URLs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'closed'], description: 'Filter by status (optional)' },
        provider: { type: 'string', enum: ['github', 'jira'], description: 'Filter by provider (optional)' },
      },
      required: [],
    },
  },

  list_ticket_suggestions: {
    name: 'list_ticket_suggestions',
    description: 'List pending ticket suggestions for a document. These are AI-generated suggestions that can be approved or dismissed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document' },
      },
      required: ['document_id'],
    },
  },

  approve_ticket_suggestion: {
    name: 'approve_ticket_suggestion',
    description: 'Approve a pending ticket suggestion, creating an actual ticket in GitHub or Jira.',
    input_schema: {
      type: 'object' as const,
      properties: {
        suggestion_id: { type: 'string', description: 'UUID of the ticket suggestion to approve' },
        provider: { type: 'string', enum: ['github', 'jira'], description: 'Where to create the ticket' },
      },
      required: ['suggestion_id', 'provider'],
    },
  },

  sync_tickets: {
    name: 'sync_tickets',
    description: 'Sync all ticket statuses from external providers (GitHub, Jira) back to Nyx. Returns count of synced and errored tickets.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },

  generate_change_proposal: {
    name: 'generate_change_proposal',
    description: 'Generate a change proposal for a document by analyzing its recent version changes. Returns a proposal with suggested tickets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to generate a change proposal for' },
      },
      required: ['document_id'],
    },
  },

  // ── Export ─────────────────────────────────────────────

  export_document: {
    name: 'export_document',
    description: 'Export a document in various formats. Returns the document content in the requested format.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to export' },
        format: { type: 'string', enum: ['markdown', 'pdf', 'txt'], description: 'Export format' },
      },
      required: ['document_id', 'format'],
    },
  },

  // ── RAG & Compliance ──────────────────────────────────

  retrieve_chunks: {
    name: 'retrieve_chunks',
    description: 'Search documents by semantic similarity using vector embeddings. Returns the most relevant document chunks for a given query.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural-language query to search for' },
      },
      required: ['query'],
    },
  },

  check_compliance: {
    name: 'check_compliance',
    description: 'Check whether code complies with the team\'s specs. Returns compliance status and any violations found.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'The code content to check for compliance' },
        file_path: { type: 'string', description: 'Optional file path for context' },
      },
      required: ['code'],
    },
  },

  // ── Document Management ───────────────────────────────

  create_document: {
    name: 'create_document',
    description: 'Create a new document in the team workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Title of the new document' },
        content: { type: 'string', description: 'Initial content (optional)' },
        stage: { type: 'string', description: 'Document stage, e.g. draft, review, approved (optional)' },
      },
      required: ['title'],
    },
  },

  delete_document: {
    name: 'delete_document',
    description: 'Archive (soft-delete) a document by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to archive' },
      },
      required: ['document_id'],
    },
  },

  list_versions: {
    name: 'list_versions',
    description: 'List all versions for a document, ordered by most recent first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document' },
      },
      required: ['document_id'],
    },
  },

  // ── Notifications & Activity ──────────────────────────

  list_notifications: {
    name: 'list_notifications',
    description: 'List the current user\'s recent notifications.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },

  // ── Codebase Scanner ─────────────────────────────────

  scan_codebase: {
    name: 'scan_codebase',
    description: 'Scan all team documents against the connected GitHub repository to find missing or incomplete spec sections. Creates change proposals for PM review.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_id: { type: 'string', description: 'Optional team UUID (defaults to current team)' },
      },
      required: [],
    },
  },

  scan_document: {
    name: 'scan_document',
    description: 'Scan a single document against the connected GitHub repository to find missing or incomplete spec sections based on actual implementation code.',
    input_schema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to scan' },
        team_id: { type: 'string', description: 'Optional team UUID (defaults to current team)' },
      },
      required: ['document_id'],
    },
  },

  // ── Code RAG ─────────────────────────────────────────

  search_code: {
    name: 'search_code',
    description: 'Search the codebase by semantic similarity. Returns the most relevant code snippets for a natural-language query. Much more efficient than reading full files — use this FIRST before get_github_files. The codebase must be indexed first (see index_codebase).',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural-language description of what you are looking for (e.g. "team invitation workflow", "auth middleware")' },
        top_k: { type: 'number', description: 'Number of results to return (default 5, max 10)' },
      },
      required: ['query'],
    },
  },

  index_codebase: {
    name: 'index_codebase',
    description: 'Index (or re-index) the connected GitHub repository for semantic code search. Run this once to enable the search_code tool, or re-run after major code changes. Returns a bounded summary: total indexable file count, per-top-level-directory counts, and up to ~50 representative file paths — not the full enumeration. Use search_code to find specifics afterward.',
    input_schema: {
      type: 'object' as const,
      properties: {
        team_id: { type: 'string', description: 'Optional team UUID (defaults to current team)' },
      },
      required: [],
    },
  },
};

/**
 * Default tool set for custom (no-workflow) sessions.
 * Covers the most common tasks without sending all 35 tool definitions.
 */
const DEFAULT_TOOLS = [
  'read_document', 'list_documents', 'update_document', 'create_document',
  'analyze_spec_quality', 'detect_drift', 'get_github_files',
  'create_ticket', 'list_tickets', 'suggest_tickets',
  'search_code', 'retrieve_chunks', 'web_search',
  'list_versions', 'get_version_diff', 'improve_document',
  'export_document', 'list_notifications',
];

/**
 * Get tool definitions for a given list of tool names.
 * Falls back to DEFAULT_TOOLS (not all tools) when no names specified.
 */
export function getToolDefinitions(toolNames?: string[]): ToolDefinition[] {
  const names = toolNames?.length ? toolNames : DEFAULT_TOOLS;
  return names
    .filter((name) => AGENT_TOOLS[name])
    .map((name) => AGENT_TOOLS[name]);
}
