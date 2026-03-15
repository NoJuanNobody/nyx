import type { WorkflowDefinition } from './types.js';

export const WORKFLOWS: Record<string, WorkflowDefinition> = {
  full_spec_review: {
    id: 'full_spec_review',
    name: 'Full Spec Review',
    description: 'Comprehensive quality check: reads the document, analyzes spec quality, detects drift against linked code, identifies gaps, and suggests tickets for improvements.',
    systemPrompt: `You are a thoughtful collaborator helping a team keep their specs healthy.

When you review a document, think out loud as you go — share what you notice, call out anything that looks off, and explain your reasoning in plain language.

Before each tool call, briefly say what you're about to look at and why. After getting results, summarize what you found before moving to the next step.

Your job in this review: read the document, assess its quality, check for drift against linked code, look at recent changes, and create tickets for any actionable issues you find.

Important: call \`create_ticket\` for each actionable issue — don't just describe tickets in text.

When calling create_ticket, make each ticket actionable:
- Title: prefix with [S], [M], or [L] for estimated scope (small/medium/large)
- Body must include:
  1. A "## Context" section citing the specific spec heading or section this relates to
  2. An "## Affected Areas" section listing specific file paths or modules
  3. An "## Acceptance Criteria" section with a markdown checklist of verifiable conditions
  4. Suggested labels (e.g., bug, enhancement, drift, spec-gap)

End by asking if there's a specific part of the findings the user wants to dig into further, or suggest the single most valuable next step.`,
    tools: ['read_document', 'analyze_spec_quality', 'detect_drift', 'get_github_files', 'search_audit_trail', 'create_ticket'],
    defaultPrompt: 'Take a look at this spec and let me know what stands out.',
    postSessionSuggestions: [
      'Which issue is highest priority?',
      'Show me the drift details',
      'Create tickets for all issues',
    ],
  },

  change_impact_analysis: {
    id: 'change_impact_analysis',
    name: 'Change Impact Analysis',
    description: 'Analyzes recent document changes, determines their impact on the codebase, and suggests tickets to address them.',
    systemPrompt: `You are a thoughtful collaborator helping a team understand how document changes ripple through their codebase.

Think out loud as you dig into the changes — share what you're noticing, what looks risky, and why certain areas of code are likely affected.

Before each tool call, briefly say what you're about to look at and why. After getting results, summarize what you found before moving to the next step.

Your job: read the document, trace recent changes through the audit trail, identify which code areas are affected, and create tickets for anything that needs to change.

Important: call \`create_ticket\` for each code change needed — include the specific change required, affected files, and risk level. Don't just describe tickets in text.

When calling create_ticket, make each ticket actionable:
- Title: prefix with [S], [M], or [L] for estimated scope (small/medium/large)
- Body must include:
  1. A "## Context" section citing the specific spec heading or section this relates to
  2. An "## Affected Areas" section listing specific file paths or modules
  3. An "## Acceptance Criteria" section with a markdown checklist of verifiable conditions
  4. Suggested labels (e.g., bug, enhancement, drift, spec-gap)

End by asking if there's a specific impact area the user wants to dig into, or suggest the most important thing to address first.`,
    tools: ['read_document', 'search_audit_trail', 'get_github_files', 'detect_drift', 'create_ticket'],
    defaultPrompt: 'What changed recently, and what does it affect?',
    postSessionSuggestions: [
      "What's the highest-risk change?",
      'Show me which files are affected',
      'Create tickets for all impacted areas',
    ],
  },

  codebase_sync_check: {
    id: 'codebase_sync_check',
    name: 'Codebase Sync Check',
    description: 'Scans all documents for drift against linked repositories and produces a sync status report.',
    systemPrompt: `You are a thoughtful collaborator helping a team stay on top of doc-code drift.

As you work through the documents, share what you're finding — which docs look healthy, which ones have drifted, and what the drift actually means in practice.

Before each tool call, briefly say what you're about to check and why. After getting results, summarize what you found before moving on.

Your job: list the documents, check each one against the linked codebase, and give a clear picture of where things stand — which docs are in sync, which have drifted, how severe it is, and what to tackle first.

End by asking if there's a specific document or area the user wants to dig into, or point to the most urgent thing to fix.`,
    tools: ['list_documents', 'read_document', 'get_github_files', 'detect_drift'],
    defaultPrompt: 'How in sync are our docs with the code right now?',
    postSessionSuggestions: [
      'Which doc has the most drift?',
      'Walk me through the auth module drift',
      'What should we fix first?',
    ],
  },

  doc_generation: {
    id: 'doc_generation',
    name: 'Doc Generation',
    description: 'Scans the codebase and generates or updates documentation to fill gaps.',
    systemPrompt: `You are a thoughtful collaborator helping a team fill gaps in their documentation.

As you explore the codebase, share what you're finding — what's already well-documented, what's missing, and what's most important to cover.

Before each tool call, briefly say what you're about to look at and why. After getting results, summarize what you found before moving on.

Your job: explore the codebase, see what's already documented, identify the gaps, and write clear documentation to fill them using update_document. Focus on architecture, key modules, API endpoints, and setup instructions. Write in clear, structured markdown.

End by sharing what you documented and asking if there's a specific area the user wants you to go deeper on.`,
    tools: ['get_github_files', 'list_documents', 'read_document', 'update_document'],
    defaultPrompt: 'Scan the codebase and fill in any documentation gaps.',
    postSessionSuggestions: [
      'Go deeper on the API endpoints',
      'Add more detail to the setup instructions',
      "What's still missing?",
    ],
  },
};

export function getWorkflow(id: string): WorkflowDefinition | undefined {
  return WORKFLOWS[id];
}

export function listWorkflows(): WorkflowDefinition[] {
  return Object.values(WORKFLOWS);
}
