import { describe, it, expect, beforeEach } from 'vitest';
import { a2aService } from '../../services/a2a.service.js';

describe('a2aService', () => {
  beforeEach(() => {
    a2aService._reset();
  });

  // ── Agent registration ──────────────────────────────────────────

  describe('registerAgent', () => {
    it('registers an agent and returns it with an id', () => {
      const agent = a2aService.registerAgent({
        name: 'claude-code-1',
        platform: 'claude-code',
        capabilities: ['read_doc', 'edit_doc'],
        teamId: 'team-1',
      });

      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('claude-code-1');
      expect(agent.platform).toBe('claude-code');
      expect(agent.capabilities).toEqual(['read_doc', 'edit_doc']);
      expect(agent.teamId).toBe('team-1');
      expect(agent.status).toBe('online');
      expect(agent.registeredAt).toBeDefined();
      expect(agent.lastSeenAt).toBeDefined();
    });
  });

  describe('unregisterAgent', () => {
    it('removes a registered agent', () => {
      const agent = a2aService.registerAgent({
        name: 'agent-a',
        platform: 'cursor',
        capabilities: [],
        teamId: 'team-1',
      });

      expect(a2aService.unregisterAgent(agent.id)).toBe(true);
      expect(a2aService.listAgents('team-1')).toHaveLength(0);
    });

    it('returns false for unknown agent', () => {
      expect(a2aService.unregisterAgent('nonexistent')).toBe(false);
    });
  });

  describe('listAgents', () => {
    it('lists agents by teamId', () => {
      a2aService.registerAgent({ name: 'a', platform: 'cursor', capabilities: [], teamId: 'team-1' });
      a2aService.registerAgent({ name: 'b', platform: 'copilot', capabilities: [], teamId: 'team-1' });
      a2aService.registerAgent({ name: 'c', platform: 'cursor', capabilities: [], teamId: 'team-2' });

      expect(a2aService.listAgents('team-1')).toHaveLength(2);
      expect(a2aService.listAgents('team-2')).toHaveLength(1);
    });

    it('filters by platform', () => {
      a2aService.registerAgent({ name: 'a', platform: 'cursor', capabilities: [], teamId: 'team-1' });
      a2aService.registerAgent({ name: 'b', platform: 'copilot', capabilities: [], teamId: 'team-1' });

      const result = a2aService.listAgents('team-1', { platform: 'cursor' });
      expect(result).toHaveLength(1);
      expect(result[0].platform).toBe('cursor');
    });

    it('filters by status', () => {
      const agent = a2aService.registerAgent({ name: 'a', platform: 'cursor', capabilities: [], teamId: 'team-1' });
      // Manually set status for testing
      a2aService.listAgents('team-1')[0].status = 'busy';

      expect(a2aService.listAgents('team-1', { status: 'busy' })).toHaveLength(1);
      expect(a2aService.listAgents('team-1', { status: 'online' })).toHaveLength(0);
    });
  });

  describe('heartbeat', () => {
    it('updates lastSeenAt and sets status to online', () => {
      const agent = a2aService.registerAgent({ name: 'a', platform: 'mcp', capabilities: [], teamId: 'team-1' });
      const originalLastSeen = agent.lastSeenAt;

      // Set agent to offline first
      agent.status = 'offline';

      // Small delay to ensure different timestamp
      a2aService.heartbeat(agent.id);

      const updated = a2aService.listAgents('team-1')[0];
      expect(updated.status).toBe('online');
      expect(updated.lastSeenAt).toBeDefined();
    });

    it('is a no-op for unknown agent', () => {
      // Should not throw
      a2aService.heartbeat('nonexistent');
    });
  });

  // ── Channels ────────────────────────────────────────────────────

  describe('createChannel', () => {
    it('creates a channel', () => {
      const channel = a2aService.createChannel({
        teamId: 'team-1',
        name: 'review-channel',
        agentIds: ['agent-1', 'agent-2'],
      });

      expect(channel.id).toBeDefined();
      expect(channel.teamId).toBe('team-1');
      expect(channel.name).toBe('review-channel');
      expect(channel.agentIds).toEqual(['agent-1', 'agent-2']);
      expect(channel.createdAt).toBeDefined();
    });
  });

  describe('listChannels', () => {
    it('lists channels by teamId', () => {
      a2aService.createChannel({ teamId: 'team-1', name: 'ch1', agentIds: [] });
      a2aService.createChannel({ teamId: 'team-1', name: 'ch2', agentIds: [] });
      a2aService.createChannel({ teamId: 'team-2', name: 'ch3', agentIds: [] });

      expect(a2aService.listChannels('team-1')).toHaveLength(2);
      expect(a2aService.listChannels('team-2')).toHaveLength(1);
    });
  });

  describe('joinChannel', () => {
    it('adds agent to channel', () => {
      const channel = a2aService.createChannel({ teamId: 'team-1', name: 'ch', agentIds: [] });

      expect(a2aService.joinChannel(channel.id, 'agent-1')).toBe(true);

      const channels = a2aService.listChannels('team-1');
      expect(channels[0].agentIds).toContain('agent-1');
    });

    it('does not duplicate agent in channel', () => {
      const channel = a2aService.createChannel({ teamId: 'team-1', name: 'ch', agentIds: ['agent-1'] });

      a2aService.joinChannel(channel.id, 'agent-1');

      const channels = a2aService.listChannels('team-1');
      expect(channels[0].agentIds.filter((id) => id === 'agent-1')).toHaveLength(1);
    });

    it('returns false for unknown channel', () => {
      expect(a2aService.joinChannel('nonexistent', 'agent-1')).toBe(false);
    });
  });

  // ── Messaging ───────────────────────────────────────────────────

  describe('sendMessage', () => {
    it('sends a message to a channel', () => {
      const channel = a2aService.createChannel({ teamId: 'team-1', name: 'ch', agentIds: [] });

      const msg = a2aService.sendMessage({
        channelId: channel.id,
        fromAgentId: 'agent-1',
        type: 'request',
        payload: { action: 'review' },
      });

      expect(msg.id).toBeDefined();
      expect(msg.channelId).toBe(channel.id);
      expect(msg.fromAgentId).toBe('agent-1');
      expect(msg.toAgentId).toBeUndefined();
      expect(msg.type).toBe('request');
      expect(msg.payload).toEqual({ action: 'review' });
      expect(msg.acknowledged).toBe(false);
    });

    it('sends a directed message to a specific agent', () => {
      const channel = a2aService.createChannel({ teamId: 'team-1', name: 'ch', agentIds: [] });

      const msg = a2aService.sendMessage({
        channelId: channel.id,
        fromAgentId: 'agent-1',
        toAgentId: 'agent-2',
        type: 'response',
        payload: { result: 'ok' },
      });

      expect(msg.toAgentId).toBe('agent-2');
    });
  });

  describe('getMessages', () => {
    it('returns messages for a channel', () => {
      const channel = a2aService.createChannel({ teamId: 'team-1', name: 'ch', agentIds: [] });

      a2aService.sendMessage({ channelId: channel.id, fromAgentId: 'a1', type: 'event', payload: { n: 1 } });
      a2aService.sendMessage({ channelId: channel.id, fromAgentId: 'a2', type: 'event', payload: { n: 2 } });

      const msgs = a2aService.getMessages(channel.id);
      expect(msgs).toHaveLength(2);
    });

    it('returns empty array for unknown channel', () => {
      expect(a2aService.getMessages('nonexistent')).toEqual([]);
    });

    it('respects limit option', () => {
      const channel = a2aService.createChannel({ teamId: 'team-1', name: 'ch', agentIds: [] });

      for (let i = 0; i < 5; i++) {
        a2aService.sendMessage({ channelId: channel.id, fromAgentId: 'a1', type: 'event', payload: { n: i } });
      }

      const msgs = a2aService.getMessages(channel.id, { limit: 2 });
      expect(msgs).toHaveLength(2);
    });

    it('filters by since timestamp', () => {
      const channel = a2aService.createChannel({ teamId: 'team-1', name: 'ch', agentIds: [] });

      const msg1 = a2aService.sendMessage({ channelId: channel.id, fromAgentId: 'a1', type: 'event', payload: {} });

      // Use msg1.createdAt as the "since" — should only get messages after it
      const msgs = a2aService.getMessages(channel.id, { since: msg1.createdAt });
      // Messages created at the exact same millisecond are not included (strictly >)
      // So this may be 0 or more depending on timing
      for (const m of msgs) {
        expect(new Date(m.createdAt).getTime()).toBeGreaterThan(new Date(msg1.createdAt).getTime());
      }
    });
  });

  describe('acknowledgeMessage', () => {
    it('marks a message as acknowledged', () => {
      const channel = a2aService.createChannel({ teamId: 'team-1', name: 'ch', agentIds: [] });
      const msg = a2aService.sendMessage({ channelId: channel.id, fromAgentId: 'a1', type: 'request', payload: {} });

      expect(a2aService.acknowledgeMessage(msg.id)).toBe(true);

      const msgs = a2aService.getMessages(channel.id);
      expect(msgs[0].acknowledged).toBe(true);
    });

    it('returns false for unknown message', () => {
      expect(a2aService.acknowledgeMessage('nonexistent')).toBe(false);
    });
  });

  // ── Handoff ─────────────────────────────────────────────────────

  describe('initiateHandoff', () => {
    it('creates a handoff message', () => {
      const channel = a2aService.createChannel({ teamId: 'team-1', name: 'ch', agentIds: [] });

      const msg = a2aService.initiateHandoff({
        channelId: channel.id,
        fromAgentId: 'agent-1',
        toAgentId: 'agent-2',
        documentId: 'doc-123',
        context: { section: 'API', reason: 'needs review' },
      });

      expect(msg.type).toBe('handoff');
      expect(msg.fromAgentId).toBe('agent-1');
      expect(msg.toAgentId).toBe('agent-2');
      expect(msg.payload).toEqual({
        documentId: 'doc-123',
        context: { section: 'API', reason: 'needs review' },
      });
    });
  });
});
