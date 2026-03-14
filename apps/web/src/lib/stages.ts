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
    hex: '#F59E0B',
    who: 'Product Managers, Founders',
    description: 'Capture the initial idea, problem space, and vision',
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
    hex: '#14B8A6',
    who: 'Product Managers, Designers',
    description: 'Translate the idea into a complete product specification',
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
    hex: '#6366F1',
    who: 'Tech Leads, Senior Engineers',
    description: 'Design the system that implements the specification',
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
    hex: '#8B5CF6',
    who: 'Engineers, QA',
    description: 'Create developer-ready specifications for AI coding agents',
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
    hex: '#10B981',
    who: 'Engineers, DevOps',
    description: 'Track the living codebase and keep docs in sync',
  },
];

export const CONNECTORS: string[] = [
  'Concept brief seeds the PRD',
  'PRD requirements drive architecture',
  'Architecture shapes implementation specs',
  'Specs generate code via AI agents',
];

export const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.id, s])) as Record<DocumentStage, StageInfo>;

export const STAGE_ORDER: DocumentStage[] = ['conception', 'definition', 'architecture', 'implementation', 'execution'];

export function getNextStage(current: DocumentStage): DocumentStage | null {
  const idx = STAGE_ORDER.indexOf(current);
  if (idx === -1 || idx >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

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
