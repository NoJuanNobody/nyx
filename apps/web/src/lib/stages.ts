export type DocumentStage = 'conception' | 'definition' | 'architecture' | 'implementation' | 'execution';

export interface StageInfo {
  id: DocumentStage;
  label: string;
  abbreviation: string;
  subtitle: string;
  color: string;       // tailwind bg class
  textColor: string;   // tailwind text class
  dotColor: string;    // tailwind bg class for small dots
  borderColor: string; // tailwind border class
  hex: string;         // hex color for custom styling
  who: string;
  description: string;
  icon: string;        // unicode symbol
  ai: string;          // one-line Claude AI role description
  output: string;      // what the phase produces
  docs: string[];      // document type names
}

export const STAGES: StageInfo[] = [
  {
    id: 'conception',
    label: 'Conception',
    abbreviation: 'CO',
    subtitle: 'Idea & Vision',
    color: 'bg-amber-100',
    textColor: 'text-amber-700',
    dotColor: 'bg-amber-400',
    borderColor: 'border-amber-300',
    hex: '#E8C547',
    who: 'Product Managers, Founders',
    description: 'Capture the initial idea, problem space, and vision',
    icon: '◎',
    ai: 'Stress-tests your idea, identifies blind spots, suggests missing angles',
    output: 'Validated concept brief ready for product definition',
    docs: ['Problem Statement', 'Value Proposition', 'Market Opportunity', 'Rough Concept Notes'],
  },
  {
    id: 'definition',
    label: 'Definition',
    abbreviation: 'DF',
    subtitle: 'Product Spec',
    color: 'bg-teal-100',
    textColor: 'text-teal-700',
    dotColor: 'bg-teal-400',
    borderColor: 'border-teal-300',
    hex: '#4EC9B0',
    who: 'Product Managers, Designers',
    description: 'Translate the idea into a complete product specification',
    icon: '◈',
    ai: 'Flags ambiguous requirements, generates user stories from PRD, scores completeness',
    output: 'Structured PRD that engineering can trust',
    docs: ['Product Requirements Doc (PRD)', 'User Stories', 'Personas', 'Feature List', 'Competitive Analysis'],
  },
  {
    id: 'architecture',
    label: 'Architecture',
    abbreviation: 'AR',
    subtitle: 'System Design',
    color: 'bg-indigo-100',
    textColor: 'text-indigo-700',
    dotColor: 'bg-indigo-400',
    borderColor: 'border-indigo-300',
    hex: '#7B9FE0',
    who: 'Tech Leads, Senior Engineers',
    description: 'Design the system that implements the specification',
    icon: '◫',
    ai: 'Reviews architecture for gaps, suggests patterns, links decisions back to PRD intent',
    output: 'Architecture docs linked to every PRD requirement they serve',
    docs: ['System Architecture Doc', 'Data Models', 'API Contracts', 'Component Hierarchy', 'Tech Stack Decisions'],
  },
  {
    id: 'implementation',
    label: 'Implementation',
    abbreviation: 'IM',
    subtitle: 'Dev Specs',
    color: 'bg-violet-100',
    textColor: 'text-violet-700',
    dotColor: 'bg-violet-400',
    borderColor: 'border-violet-300',
    hex: '#C084FC',
    who: 'Engineers, QA',
    description: 'Create developer-ready specifications for AI coding agents',
    icon: '◧',
    ai: 'Scores spec quality for AI code generation, auto-generates tickets, suggests edge cases',
    output: 'Implementation-ready specs optimized for Claude Code & Copilot',
    docs: ['AI-Ready Feature Specs', 'Ticket Breakdowns', 'Acceptance Criteria', 'Edge Cases', 'Test Plans'],
  },
  {
    id: 'execution',
    label: 'Execution',
    abbreviation: 'EX',
    subtitle: 'Code & Sync',
    color: 'bg-emerald-100',
    textColor: 'text-emerald-700',
    dotColor: 'bg-emerald-400',
    borderColor: 'border-emerald-300',
    hex: '#F87171',
    who: 'Engineers, DevOps',
    description: 'Track the living codebase and keep docs in sync',
    icon: '◉',
    ai: 'Watches commits, detects doc-code drift in real time, flags intent violations',
    output: 'Codebase that never diverges silently from its original intent',
    docs: ['Living Codebase', 'Auto-Updated Docs', 'Drift Alerts', 'Change History', 'Rollback Points'],
  },
];

export const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.id, s])) as Record<DocumentStage, StageInfo>;

export const STAGE_ORDER: DocumentStage[] = ['conception', 'definition', 'architecture', 'implementation', 'execution'];

export function getNextStage(current: DocumentStage): DocumentStage | null {
  const idx = STAGE_ORDER.indexOf(current);
  if (idx === -1 || idx >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

export const CONNECTORS: string[] = [
  'Concept brief seeds the PRD',
  'PRD requirements drive architecture',
  'Architecture shapes implementation specs',
  'Specs generate code via AI agents',
];

// Stage-specific AI suggestion prompts for the chat panel
export const STAGE_SUGGESTIONS: Record<DocumentStage, string[]> = {
  conception: [
    'Stress-test this idea',
    'Identify blind spots',
    'Suggest target user personas',
  ],
  definition: [
    'Generate user stories',
    'Flag ambiguous requirements',
    'Suggest success metrics',
  ],
  architecture: [
    'Review for gaps',
    'Link back to PRD',
    'Identify scalability concerns',
  ],
  implementation: [
    'Score AI-readiness',
    'Generate ticket breakdown',
    'Add edge cases',
  ],
  execution: [
    'Check for drift',
    'Summarize changes',
    'Generate release notes',
  ],
};
