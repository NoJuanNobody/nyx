// Agent-to-Agent (A2A) protocol service: in-memory message bus for
// cross-platform agent communication (Claude Code, Cursor, Copilot, MCP, etc.).
//
// Implements agent registration, channel-based messaging, and work handoff.
// See tickets #127 and #129 for full context.

import { randomUUID } from 'node:crypto';

// ── Types ───────────────────────────────────────────────────────────

export interface A2AAgent {
  id: string;
  name: string;
  platform: string; // 'claude-code' | 'cursor' | 'copilot' | 'mcp' | 'custom'
  capabilities: string[]; // e.g., ['read_doc', 'edit_doc', 'review', 'generate']
  teamId: string;
  status: 'online' | 'busy' | 'offline';
  registeredAt: string;
  lastSeenAt: string;
}

export interface A2AMessage {
  id: string;
  channelId: string;
  fromAgentId: string;
  toAgentId?: string; // null = broadcast to channel
  type: 'request' | 'response' | 'event' | 'handoff';
  payload: Record<string, unknown>;
  createdAt: string;
  acknowledged: boolean;
}

export interface A2AChannel {
  id: string;
  teamId: string;
  name: string;
  agentIds: string[];
  createdAt: string;
}

// ── In-memory stores ────────────────────────────────────────────────

const agents = new Map<string, A2AAgent>();
const channels = new Map<string, A2AChannel>();
const messages = new Map<string, A2AMessage>();
// channelId -> messageId[] for fast lookup
const channelMessages = new Map<string, string[]>();

// ── Service ─────────────────────────────────────────────────────────

export const a2aService = {
  // ── Agent registration ──────────────────────────────────────────

  registerAgent(params: {
    name: string;
    platform: string;
    capabilities: string[];
    teamId: string;
  }): A2AAgent {
    const now = new Date().toISOString();
    const agent: A2AAgent = {
      id: randomUUID(),
      name: params.name,
      platform: params.platform,
      capabilities: params.capabilities,
      teamId: params.teamId,
      status: 'online',
      registeredAt: now,
      lastSeenAt: now,
    };
    agents.set(agent.id, agent);
    return agent;
  },

  unregisterAgent(agentId: string): boolean {
    return agents.delete(agentId);
  },

  listAgents(
    teamId: string,
    opts?: { platform?: string; status?: string },
  ): A2AAgent[] {
    let result = Array.from(agents.values()).filter((a) => a.teamId === teamId);
    if (opts?.platform) {
      result = result.filter((a) => a.platform === opts.platform);
    }
    if (opts?.status) {
      result = result.filter((a) => a.status === opts.status);
    }
    return result;
  },

  heartbeat(agentId: string): void {
    const agent = agents.get(agentId);
    if (agent) {
      agent.lastSeenAt = new Date().toISOString();
      agent.status = 'online';
    }
  },

  // ── Channels ────────────────────────────────────────────────────

  createChannel(params: {
    teamId: string;
    name: string;
    agentIds: string[];
  }): A2AChannel {
    const channel: A2AChannel = {
      id: randomUUID(),
      teamId: params.teamId,
      name: params.name,
      agentIds: [...params.agentIds],
      createdAt: new Date().toISOString(),
    };
    channels.set(channel.id, channel);
    channelMessages.set(channel.id, []);
    return channel;
  },

  listChannels(teamId: string): A2AChannel[] {
    return Array.from(channels.values()).filter((c) => c.teamId === teamId);
  },

  joinChannel(channelId: string, agentId: string): boolean {
    const channel = channels.get(channelId);
    if (!channel) return false;
    if (!channel.agentIds.includes(agentId)) {
      channel.agentIds.push(agentId);
    }
    return true;
  },

  // ── Messaging ───────────────────────────────────────────────────

  sendMessage(params: {
    channelId: string;
    fromAgentId: string;
    toAgentId?: string;
    type: string;
    payload: Record<string, unknown>;
  }): A2AMessage {
    const message: A2AMessage = {
      id: randomUUID(),
      channelId: params.channelId,
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      type: params.type as A2AMessage['type'],
      payload: params.payload,
      createdAt: new Date().toISOString(),
      acknowledged: false,
    };
    messages.set(message.id, message);

    const msgList = channelMessages.get(params.channelId) ?? [];
    msgList.push(message.id);
    channelMessages.set(params.channelId, msgList);

    return message;
  },

  getMessages(
    channelId: string,
    opts?: { since?: string; limit?: number },
  ): A2AMessage[] {
    const msgIds = channelMessages.get(channelId) ?? [];
    let result = msgIds
      .map((id) => messages.get(id)!)
      .filter(Boolean);

    if (opts?.since) {
      const sinceDate = new Date(opts.since).getTime();
      result = result.filter(
        (m) => new Date(m.createdAt).getTime() > sinceDate,
      );
    }

    if (opts?.limit && opts.limit > 0) {
      result = result.slice(-opts.limit);
    }

    return result;
  },

  acknowledgeMessage(messageId: string): boolean {
    const message = messages.get(messageId);
    if (!message) return false;
    message.acknowledged = true;
    return true;
  },

  // ── Handoff ─────────────────────────────────────────────────────

  initiateHandoff(params: {
    channelId: string;
    fromAgentId: string;
    toAgentId: string;
    documentId: string;
    context: Record<string, unknown>;
  }): A2AMessage {
    return this.sendMessage({
      channelId: params.channelId,
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      type: 'handoff',
      payload: {
        documentId: params.documentId,
        context: params.context,
      },
    });
  },

  // ── Testing helpers ─────────────────────────────────────────────

  _reset(): void {
    agents.clear();
    channels.clear();
    messages.clear();
    channelMessages.clear();
  },
};
