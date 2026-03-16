import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

export function registerA2ACommand(program: Command): void {
  const a2a = program.command('a2a').description('Agent-to-Agent protocol commands');

  // ── nyx a2a register ────────────────────────────────────────────

  a2a
    .command('register')
    .description('Register this CLI as an A2A agent')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .requiredOption('--name <name>', 'Agent name')
    .requiredOption('--platform <platform>', 'Agent platform (claude-code|cursor|copilot|mcp|custom)')
    .option('--capabilities <caps...>', 'Agent capabilities (e.g., read_doc edit_doc review generate)')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId: string;
      name: string;
      platform: string;
      capabilities?: string[];
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      try {
        const data = await client.post('/api/a2a/agents', {
          teamId: opts.teamId,
          name: opts.name,
          platform: opts.platform,
          capabilities: opts.capabilities ?? [],
        });
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx a2a agents ──────────────────────────────────────────────

  a2a
    .command('agents')
    .description('List registered agents')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--platform <platform>', 'Filter by platform')
    .option('--status <status>', 'Filter by status')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId: string;
      platform?: string;
      status?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      const params = new URLSearchParams({ teamId: opts.teamId });
      if (opts.platform) params.set('platform', opts.platform);
      if (opts.status) params.set('status', opts.status);

      try {
        const data = await client.get(`/api/a2a/agents?${params}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx a2a channels ────────────────────────────────────────────

  a2a
    .command('channels')
    .description('List channels')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(`/api/a2a/channels?teamId=${opts.teamId}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx a2a channel create ──────────────────────────────────────

  const channel = a2a.command('channel').description('Channel operations');

  channel
    .command('create')
    .description('Create a new channel')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .requiredOption('--name <name>', 'Channel name')
    .option('--agents <ids>', 'Comma-separated agent IDs')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId: string;
      name: string;
      agents?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      try {
        const data = await client.post('/api/a2a/channels', {
          teamId: opts.teamId,
          name: opts.name,
          agentIds: opts.agents ? opts.agents.split(',') : [],
        });
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx a2a send ────────────────────────────────────────────────

  a2a
    .command('send <channelId>')
    .description('Send a message to a channel')
    .requiredOption('--from <agentId>', 'Sender agent ID')
    .requiredOption('--type <type>', 'Message type (request|response|event|handoff)')
    .requiredOption('--payload <json>', 'Message payload as JSON')
    .option('--to <agentId>', 'Target agent ID (omit for broadcast)')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (channelId: string, opts: {
      from: string;
      type: string;
      payload: string;
      to?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(opts.payload);
      } catch {
        error('Invalid JSON in --payload');
      }

      try {
        const data = await client.post(`/api/a2a/channels/${channelId}/messages`, {
          fromAgentId: opts.from,
          toAgentId: opts.to,
          type: opts.type,
          payload,
        });
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx a2a messages ────────────────────────────────────────────

  a2a
    .command('messages <channelId>')
    .description('Read messages from a channel')
    .option('--since <iso>', 'Only messages after this ISO timestamp')
    .option('--limit <n>', 'Limit number of messages')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (channelId: string, opts: {
      since?: string;
      limit?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      const params = new URLSearchParams();
      if (opts.since) params.set('since', opts.since);
      if (opts.limit) params.set('limit', opts.limit);
      const qs = params.toString();

      try {
        const data = await client.get(`/api/a2a/channels/${channelId}/messages${qs ? `?${qs}` : ''}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx a2a handoff ─────────────────────────────────────────────

  a2a
    .command('handoff <channelId>')
    .description('Initiate a work handoff between agents')
    .requiredOption('--from <agentId>', 'Source agent ID')
    .requiredOption('--to <agentId>', 'Target agent ID')
    .requiredOption('--doc-id <docId>', 'Document ID to hand off')
    .option('--context <json>', 'Additional context as JSON', '{}')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (channelId: string, opts: {
      from: string;
      to: string;
      docId: string;
      context: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      let context: Record<string, unknown>;
      try {
        context = JSON.parse(opts.context);
      } catch {
        error('Invalid JSON in --context');
      }

      try {
        const data = await client.post('/api/a2a/handoff', {
          channelId,
          fromAgentId: opts.from,
          toAgentId: opts.to,
          documentId: opts.docId,
          context,
        });
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
