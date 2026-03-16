import type {
  AgentType,
  AgentState,
  AgentRegistration,
  AgentStateTransition,
  AgentMapEntry,
} from './registry.types.js';

// ── Valid state transitions ──────────────────────────────────────
export const VALID_TRANSITIONS: AgentStateTransition = {
  idle: ['joining'],
  joining: ['in_call', 'error'],
  in_call: ['processing', 'error'],
  processing: ['complete', 'error'],
  complete: ['idle'],
  error: ['idle'],
};

// ── In-memory registry ──────────────────────────────────────────
const registry = new Map<AgentType, AgentRegistration>();

// ── Default agents ──────────────────────────────────────────────
const DEFAULT_AGENTS: AgentRegistration[] = [
  {
    type: 'spec_review',
    name: 'Spec Review',
    description:
      'Comprehensive quality check: reads documents, analyzes spec quality, detects drift, and suggests improvements.',
    capabilities: ['read_document', 'analyze_spec_quality', 'detect_drift', 'create_ticket'],
    currentState: 'idle',
    config: {},
    enabledWorkspaces: [],
  },
  {
    type: 'change_impact',
    name: 'Change Impact Analysis',
    description:
      'Analyzes recent document changes, determines their impact on the codebase, and suggests tickets.',
    capabilities: ['read_document', 'search_audit_trail', 'detect_drift', 'create_ticket'],
    currentState: 'idle',
    config: {},
    enabledWorkspaces: [],
  },
  {
    type: 'codebase_sync',
    name: 'Codebase Sync Check',
    description: 'Scans all documents for drift against linked repositories and produces a sync status report.',
    capabilities: ['list_documents', 'read_document', 'get_github_files', 'detect_drift'],
    currentState: 'idle',
    config: {},
    enabledWorkspaces: [],
  },
  {
    type: 'doc_generation',
    name: 'Doc Generation',
    description: 'Scans the codebase and generates or updates documentation to fill gaps.',
    capabilities: ['get_github_files', 'list_documents', 'read_document', 'update_document'],
    currentState: 'idle',
    config: {},
    enabledWorkspaces: [],
  },
  {
    type: 'voice_agent',
    name: 'PersonaPlex Voice Agent',
    description:
      'Joins meetings to capture decisions, action items, and context, then outputs structured documentation.',
    capabilities: ['join_meeting', 'transcribe_audio', 'extract_decisions', 'generate_doc'],
    currentState: 'idle',
    config: {
      meetingPlatform: 'any',
      triggerConditions: ['scheduled', 'manual'],
      outputDocumentType: 'meeting_notes',
    },
    enabledWorkspaces: [],
  },
];

// ── Initialize registry with defaults ───────────────────────────
export function initRegistry(): void {
  registry.clear();
  for (const agent of DEFAULT_AGENTS) {
    registry.set(agent.type, structuredClone(agent));
  }
}

// Initialize on import
initRegistry();

// ── Registry operations ─────────────────────────────────────────

export function registerAgent(registration: AgentRegistration): AgentMapEntry {
  const entry: AgentRegistration = {
    ...registration,
    config: registration.config ?? {},
    enabledWorkspaces: registration.enabledWorkspaces ?? [],
  };
  registry.set(entry.type, entry);
  return toMapEntry(entry);
}

export function getAgent(type: AgentType): AgentMapEntry | undefined {
  const agent = registry.get(type);
  return agent ? toMapEntry(agent) : undefined;
}

export function listAgents(): AgentMapEntry[] {
  return Array.from(registry.values()).map(toMapEntry);
}

export function updateState(type: AgentType, newState: AgentState): AgentMapEntry {
  const agent = registry.get(type);
  if (!agent) {
    throw new Error(`Agent not found: ${type}`);
  }

  const allowed = VALID_TRANSITIONS[agent.currentState];
  if (!allowed.includes(newState)) {
    throw new Error(
      `Invalid state transition: ${agent.currentState} -> ${newState}. ` +
        `Allowed transitions from ${agent.currentState}: ${allowed.join(', ')}`,
    );
  }

  agent.currentState = newState;
  return toMapEntry(agent);
}

export function updateConfig(
  type: AgentType,
  config: Record<string, unknown>,
): AgentMapEntry {
  const agent = registry.get(type);
  if (!agent) {
    throw new Error(`Agent not found: ${type}`);
  }
  agent.config = { ...agent.config, ...config };
  return toMapEntry(agent);
}

export function enableForWorkspace(type: AgentType, workspaceId: string): AgentMapEntry {
  const agent = registry.get(type);
  if (!agent) {
    throw new Error(`Agent not found: ${type}`);
  }
  if (!agent.enabledWorkspaces) {
    agent.enabledWorkspaces = [];
  }
  if (!agent.enabledWorkspaces.includes(workspaceId)) {
    agent.enabledWorkspaces.push(workspaceId);
  }
  return toMapEntry(agent);
}

export function disableForWorkspace(type: AgentType, workspaceId: string): AgentMapEntry {
  const agent = registry.get(type);
  if (!agent) {
    throw new Error(`Agent not found: ${type}`);
  }
  agent.enabledWorkspaces = (agent.enabledWorkspaces ?? []).filter((id) => id !== workspaceId);
  return toMapEntry(agent);
}

// ── Helpers ─────────────────────────────────────────────────────

function toMapEntry(reg: AgentRegistration): AgentMapEntry {
  return {
    type: reg.type,
    name: reg.name,
    description: reg.description,
    capabilities: [...reg.capabilities],
    currentState: reg.currentState,
    config: { ...reg.config },
    enabledWorkspaces: [...(reg.enabledWorkspaces ?? [])],
  };
}
