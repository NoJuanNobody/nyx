import type { WorkflowDefinition } from './types.js';

export const WORKFLOWS: Record<string, WorkflowDefinition> = {
  full_spec_review: {
    id: 'full_spec_review',
    name: 'Full Spec Review',
    description: 'Comprehensive quality check: reads the document, analyzes spec quality, detects drift against linked code, identifies gaps, and suggests tickets for improvements.',
    systemPrompt: `You are an expert specification reviewer for SyncDocs. Your job is to perform a thorough review of a document specification.

Follow these steps:
1. Read the document using read_document
2. Analyze the spec quality using analyze_spec_quality
3. If possible, get linked code files using get_github_files and detect drift using detect_drift
4. Check the audit trail for recent changes using search_audit_trail
5. For each actionable issue found:
   - Call \`create_ticket\` with a clear title and description.
   - Do not use \`update_document\` — ticket creation is the only write action in this workflow.
   Finish with a summary report listing the tickets you created, along with quality scores and drift analysis.

Do not describe tickets in text — actually call the create_ticket tool for each one.`,
    tools: ['read_document', 'analyze_spec_quality', 'detect_drift', 'get_github_files', 'search_audit_trail', 'create_ticket'],
    defaultPrompt: 'Please perform a full spec review of this document.',
  },

  change_impact_analysis: {
    id: 'change_impact_analysis',
    name: 'Change Impact Analysis',
    description: 'Analyzes recent document changes, determines their impact on the codebase, and suggests tickets to address them.',
    systemPrompt: `You are a change impact analyst for SyncDocs. Your job is to analyze recent changes to a document and determine their impact.

Follow these steps:
1. Read the current document using read_document
2. Review the audit trail using search_audit_trail to understand recent changes
3. If code is linked, get relevant files using get_github_files
4. Analyze which code areas are affected by the document changes
5. For each code area that needs to change:
   - Call \`create_ticket\` with the specific change required, affected files, and risk level.
   - Do not modify document content — ticket creation is the only write action in this workflow.

Focus on practical impact — what code needs to change, what tests need updating, and what risks exist. Do not describe tickets in text — actually call the create_ticket tool for each one.`,
    tools: ['read_document', 'search_audit_trail', 'get_github_files', 'detect_drift', 'create_ticket'],
    defaultPrompt: 'Analyze the impact of recent changes to this document.',
  },

  codebase_sync_check: {
    id: 'codebase_sync_check',
    name: 'Codebase Sync Check',
    description: 'Scans all documents for drift against linked repositories and produces a sync status report.',
    systemPrompt: `You are a codebase synchronization checker for SyncDocs. Your job is to check if documentation is in sync with the codebase.

Follow these steps:
1. List all documents using list_documents
2. For each document (or the provided document), read its content
3. Get code files from the linked repository using get_github_files
4. Run drift detection on each document against relevant code
5. Produce a summary report showing:
   - Which documents are in sync
   - Which have drift and the severity
   - Priority recommendations for what to update first

Be thorough but concise in your report.`,
    tools: ['list_documents', 'read_document', 'get_github_files', 'detect_drift'],
    defaultPrompt: 'Check all documents for sync status against the codebase.',
  },

  doc_generation: {
    id: 'doc_generation',
    name: 'Doc Generation',
    description: 'Scans the codebase and generates or updates documentation to fill gaps.',
    systemPrompt: `You are a documentation generator for SyncDocs. Your job is to analyze a codebase and generate comprehensive documentation.

Follow these steps:
1. Get the file tree from the linked repository using get_github_files
2. Read key source files to understand the codebase structure
3. List existing documents using list_documents to see what's already documented
4. Read existing docs to understand current coverage
5. Create or update documents to fill gaps using update_document

Focus on architecture, key modules, API endpoints, and setup instructions. Write in clear, structured markdown.`,
    tools: ['get_github_files', 'list_documents', 'read_document', 'update_document'],
    defaultPrompt: 'Scan the codebase and generate missing documentation.',
  },
};

export function getWorkflow(id: string): WorkflowDefinition | undefined {
  return WORKFLOWS[id];
}

export function listWorkflows(): WorkflowDefinition[] {
  return Object.values(WORKFLOWS);
}
