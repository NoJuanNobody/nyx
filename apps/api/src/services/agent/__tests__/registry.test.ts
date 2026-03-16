import { describe, it, expect, beforeEach } from 'vitest';
import {
  initRegistry,
  registerAgent,
  getAgent,
  listAgents,
  updateState,
  updateConfig,
  enableForWorkspace,
  disableForWorkspace,
  VALID_TRANSITIONS,
} from '../registry.js';
import type { AgentRegistration, AgentState, AgentType } from '../registry.types.js';

beforeEach(() => {
  initRegistry();
});

describe('Agent Registry', () => {
  // ── Pre-registered agents ─────────────────────────────────────
  describe('initialization', () => {
    it('pre-registers all default agent types', () => {
      const agents = listAgents();
      const types = agents.map((a) => a.type);
      expect(types).toContain('spec_review');
      expect(types).toContain('change_impact');
      expect(types).toContain('codebase_sync');
      expect(types).toContain('doc_generation');
      expect(types).toContain('voice_agent');
      expect(agents).toHaveLength(5);
    });

    it('all default agents start in idle state', () => {
      const agents = listAgents();
      for (const agent of agents) {
        expect(agent.currentState).toBe('idle');
      }
    });

    it('voice_agent has correct metadata', () => {
      const voice = getAgent('voice_agent');
      expect(voice).toBeDefined();
      expect(voice!.name).toBe('PersonaPlex Voice Agent');
      expect(voice!.capabilities).toEqual(
        expect.arrayContaining(['join_meeting', 'transcribe_audio']),
      );
      expect(voice!.config).toMatchObject({
        meetingPlatform: 'any',
        triggerConditions: ['scheduled', 'manual'],
        outputDocumentType: 'meeting_notes',
      });
    });
  });

  // ── Registration ──────────────────────────────────────────────
  describe('registerAgent', () => {
    it('registers a new agent and returns a map entry', () => {
      const custom: AgentRegistration = {
        type: 'voice_agent' as AgentType,
        name: 'Custom Voice',
        description: 'Overridden voice agent',
        capabilities: ['custom_cap'],
        currentState: 'idle',
      };
      const entry = registerAgent(custom);
      expect(entry.name).toBe('Custom Voice');
      expect(entry.config).toEqual({});
      expect(entry.enabledWorkspaces).toEqual([]);
    });

    it('overwrites an existing agent with same type', () => {
      const original = getAgent('spec_review');
      expect(original!.name).toBe('Spec Review');

      registerAgent({
        type: 'spec_review',
        name: 'Updated Spec Review',
        description: 'Updated',
        capabilities: [],
        currentState: 'idle',
      });

      const updated = getAgent('spec_review');
      expect(updated!.name).toBe('Updated Spec Review');
    });
  });

  // ── getAgent ──────────────────────────────────────────────────
  describe('getAgent', () => {
    it('returns agent by type', () => {
      const agent = getAgent('doc_generation');
      expect(agent).toBeDefined();
      expect(agent!.type).toBe('doc_generation');
    });

    it('returns undefined for unknown type', () => {
      const agent = getAgent('nonexistent' as AgentType);
      expect(agent).toBeUndefined();
    });

    it('returns a copy (not a reference)', () => {
      const a = getAgent('spec_review');
      const b = getAgent('spec_review');
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      expect(a!.capabilities).not.toBe(b!.capabilities);
    });
  });

  // ── listAgents ────────────────────────────────────────────────
  describe('listAgents', () => {
    it('returns all registered agents', () => {
      const agents = listAgents();
      expect(agents.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ── State machine transitions ─────────────────────────────────
  describe('updateState', () => {
    it('allows valid transition idle -> joining', () => {
      const result = updateState('voice_agent', 'joining');
      expect(result.currentState).toBe('joining');
    });

    it('allows valid transition joining -> in_call', () => {
      updateState('voice_agent', 'joining');
      const result = updateState('voice_agent', 'in_call');
      expect(result.currentState).toBe('in_call');
    });

    it('allows valid transition in_call -> processing', () => {
      updateState('voice_agent', 'joining');
      updateState('voice_agent', 'in_call');
      const result = updateState('voice_agent', 'processing');
      expect(result.currentState).toBe('processing');
    });

    it('allows valid transition processing -> complete', () => {
      updateState('voice_agent', 'joining');
      updateState('voice_agent', 'in_call');
      updateState('voice_agent', 'processing');
      const result = updateState('voice_agent', 'complete');
      expect(result.currentState).toBe('complete');
    });

    it('allows complete -> idle (reset)', () => {
      updateState('voice_agent', 'joining');
      updateState('voice_agent', 'in_call');
      updateState('voice_agent', 'processing');
      updateState('voice_agent', 'complete');
      const result = updateState('voice_agent', 'idle');
      expect(result.currentState).toBe('idle');
    });

    it('allows error -> idle (recovery)', () => {
      updateState('voice_agent', 'joining');
      updateState('voice_agent', 'error');
      const result = updateState('voice_agent', 'idle');
      expect(result.currentState).toBe('idle');
    });

    it('allows joining -> error', () => {
      updateState('voice_agent', 'joining');
      const result = updateState('voice_agent', 'error');
      expect(result.currentState).toBe('error');
    });

    it('allows in_call -> error', () => {
      updateState('voice_agent', 'joining');
      updateState('voice_agent', 'in_call');
      const result = updateState('voice_agent', 'error');
      expect(result.currentState).toBe('error');
    });

    it('allows processing -> error', () => {
      updateState('voice_agent', 'joining');
      updateState('voice_agent', 'in_call');
      updateState('voice_agent', 'processing');
      const result = updateState('voice_agent', 'error');
      expect(result.currentState).toBe('error');
    });

    it('rejects invalid transition idle -> in_call', () => {
      expect(() => updateState('voice_agent', 'in_call')).toThrow('Invalid state transition');
    });

    it('rejects invalid transition idle -> processing', () => {
      expect(() => updateState('voice_agent', 'processing')).toThrow('Invalid state transition');
    });

    it('rejects invalid transition idle -> complete', () => {
      expect(() => updateState('voice_agent', 'complete')).toThrow('Invalid state transition');
    });

    it('rejects invalid transition idle -> error', () => {
      expect(() => updateState('voice_agent', 'error')).toThrow('Invalid state transition');
    });

    it('rejects invalid transition complete -> joining', () => {
      updateState('voice_agent', 'joining');
      updateState('voice_agent', 'in_call');
      updateState('voice_agent', 'processing');
      updateState('voice_agent', 'complete');
      expect(() => updateState('voice_agent', 'joining')).toThrow('Invalid state transition');
    });

    it('throws for unknown agent type', () => {
      expect(() => updateState('nonexistent' as AgentType, 'idle')).toThrow('Agent not found');
    });
  });

  // ── VALID_TRANSITIONS completeness ────────────────────────────
  describe('VALID_TRANSITIONS', () => {
    const allStates: AgentState[] = ['idle', 'joining', 'in_call', 'processing', 'complete', 'error'];

    it('has entries for all states', () => {
      for (const state of allStates) {
        expect(VALID_TRANSITIONS[state]).toBeDefined();
        expect(Array.isArray(VALID_TRANSITIONS[state])).toBe(true);
      }
    });

    it('only references valid states in transitions', () => {
      for (const [, targets] of Object.entries(VALID_TRANSITIONS)) {
        for (const target of targets) {
          expect(allStates).toContain(target);
        }
      }
    });
  });

  // ── Config updates ────────────────────────────────────────────
  describe('updateConfig', () => {
    it('merges config on existing agent', () => {
      const result = updateConfig('voice_agent', { meetingPlatform: 'zoom' });
      expect(result.config.meetingPlatform).toBe('zoom');
      // Original fields preserved
      expect(result.config.outputDocumentType).toBe('meeting_notes');
    });

    it('throws for unknown agent type', () => {
      expect(() => updateConfig('nonexistent' as AgentType, {})).toThrow('Agent not found');
    });
  });

  // ── Workspace enable/disable ──────────────────────────────────
  describe('enableForWorkspace / disableForWorkspace', () => {
    it('enables agent for a workspace', () => {
      const result = enableForWorkspace('voice_agent', 'ws-1');
      expect(result.enabledWorkspaces).toContain('ws-1');
    });

    it('does not duplicate workspace id', () => {
      enableForWorkspace('voice_agent', 'ws-1');
      const result = enableForWorkspace('voice_agent', 'ws-1');
      expect(result.enabledWorkspaces.filter((id) => id === 'ws-1')).toHaveLength(1);
    });

    it('enables for multiple workspaces', () => {
      enableForWorkspace('voice_agent', 'ws-1');
      const result = enableForWorkspace('voice_agent', 'ws-2');
      expect(result.enabledWorkspaces).toContain('ws-1');
      expect(result.enabledWorkspaces).toContain('ws-2');
    });

    it('disables agent for a workspace', () => {
      enableForWorkspace('voice_agent', 'ws-1');
      enableForWorkspace('voice_agent', 'ws-2');
      const result = disableForWorkspace('voice_agent', 'ws-1');
      expect(result.enabledWorkspaces).not.toContain('ws-1');
      expect(result.enabledWorkspaces).toContain('ws-2');
    });

    it('disabling a non-enabled workspace is a no-op', () => {
      const result = disableForWorkspace('voice_agent', 'ws-nonexistent');
      expect(result.enabledWorkspaces).toEqual([]);
    });

    it('throws for unknown agent type on enable', () => {
      expect(() => enableForWorkspace('nonexistent' as AgentType, 'ws-1')).toThrow(
        'Agent not found',
      );
    });

    it('throws for unknown agent type on disable', () => {
      expect(() => disableForWorkspace('nonexistent' as AgentType, 'ws-1')).toThrow(
        'Agent not found',
      );
    });
  });
});
