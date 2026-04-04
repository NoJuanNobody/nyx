import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, formatTable, error, type OutputFormat } from '../utils/output.js';

interface AgentEntry {
  type: string;
  name: string;
  description: string;
  capabilities: string[];
  currentState: string;
  config: Record<string, unknown>;
  enabledWorkspaces: string[];
}

export function registerRegistryCommand(program: Command): void {
  const registry = program.command('registry').description('Agent registry management');

  // ── nyx registry list ─────────────────────────────────
  registry
    .command('list')
    .description('List registered agents')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get<AgentEntry[]>('/api/agent/registry');

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(
            formatTable(data, [
              { key: 'type', label: 'Type', width: 20 },
              { key: 'name', label: 'Name', width: 28 },
              { key: 'currentState', label: 'State', width: 12 },
              {
                key: 'capabilities',
                label: 'Capabilities',
                width: 40,
                transform: (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? '')),
              },
            ]),
          );
          console.log(`\n${data.length} agent(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx registry get <agent-id> ───────────────────────
  registry
    .command('get <agent-id>')
    .description('Show details for a specific agent')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (agentId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get<AgentEntry>(`/api/agent/registry/${agentId}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx registry register ─────────────────────────────
  registry
    .command('register')
    .description('Register a new agent')
    .requiredOption('--name <name>', 'Agent display name')
    .requiredOption('--url <url>', 'Agent endpoint URL')
    .option('--type <type>', 'Agent type identifier (derived from name if omitted)')
    .option('--description <desc>', 'Agent description')
    .option('--capabilities <caps>', 'Comma-separated list of capabilities')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(
      async (opts: {
        name: string;
        url: string;
        type?: string;
        description?: string;
        capabilities?: string;
        format: OutputFormat;
      }) => {
        const client = new NyxClient();
        const agentType = opts.type ?? opts.name.toLowerCase().replace(/\s+/g, '_');
        const capabilities = opts.capabilities
          ? opts.capabilities.split(',').map((c) => c.trim())
          : [];

        try {
          const data = await client.post<AgentEntry>('/api/agent/registry', {
            type: agentType,
            name: opts.name,
            url: opts.url,
            description: opts.description,
            capabilities,
          });
          console.log(formatOutput(data, opts.format));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );
}
