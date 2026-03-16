// ── Agent Registry Types ──────────────────────────────────────────

export type AgentType =
  | 'spec_review'
  | 'change_impact'
  | 'codebase_sync'
  | 'doc_generation'
  | 'voice_agent';

export type AgentState =
  | 'idle'
  | 'joining'
  | 'in_call'
  | 'processing'
  | 'complete'
  | 'error';

export interface AgentRegistration {
  type: AgentType;
  name: string;
  description: string;
  capabilities: string[];
  currentState: AgentState;
  config?: Record<string, unknown>;
  enabledWorkspaces?: string[];
}

/** Valid state transitions: maps each state to the set of states it can transition to. */
export type AgentStateTransition = Record<AgentState, AgentState[]>;

/** UI-ready shape for the agent map. */
export interface AgentMapEntry {
  type: AgentType;
  name: string;
  description: string;
  capabilities: string[];
  currentState: AgentState;
  config: Record<string, unknown>;
  enabledWorkspaces: string[];
}
