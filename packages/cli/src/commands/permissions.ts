import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

export function registerPermissionsCommand(program: Command): void {
  const permissions = program
    .command('permissions')
    .description('Check agent permissions and roles');

  permissions
    .command('check')
    .description('Check if the authenticated user can perform an action')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .requiredOption('--action <action>', 'Action to check (read|edit|create|deploy|merge|delete|manage|transfer)')
    .option('--resource-type <type>', 'Resource type')
    .option('--resource-id <id>', 'Resource ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: {
      teamId: string;
      action: string;
      resourceType?: string;
      resourceId?: string;
      format: OutputFormat;
    }) => {
      const client = new NyxClient();
      const params = new URLSearchParams({
        teamId: opts.teamId,
        action: opts.action,
      });
      if (opts.resourceType) params.set('resourceType', opts.resourceType);
      if (opts.resourceId) params.set('resourceId', opts.resourceId);

      try {
        const data = await client.get<{ allowed: boolean; role: string; requiredRole: string; reason?: string }>(
          `/api/permissions/check?${params}`,
        );
        console.log(formatOutput(data, opts.format));

        if (!data.allowed) {
          process.exit(1);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  permissions
    .command('roles')
    .description('Show current role and available actions')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: { teamId: string; format: OutputFormat }) => {
      const client = new NyxClient();
      const params = new URLSearchParams({ teamId: opts.teamId });

      try {
        const data = await client.get(`/api/permissions/roles?${params}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
