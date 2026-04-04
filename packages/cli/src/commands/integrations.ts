import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { getBaseUrl } from '../lib/api.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

const SUPPORTED_PROVIDERS = ['github', 'gitlab', 'bitbucket', 'jira', 'confluence'] as const;
type Provider = (typeof SUPPORTED_PROVIDERS)[number];

function validateProvider(provider: string): Provider {
  const lower = provider.toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(lower as Provider)) {
    error(`Unknown provider "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`);
  }
  return lower as Provider;
}

export function registerIntegrationsCommand(program: Command): void {
  const integrations = program
    .command('integrations')
    .description('Manage integrations (GitHub, GitLab, Bitbucket, Jira, Confluence)');

  integrations
    .command('list')
    .description('List connected integrations for a team')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { teamId?: string; format: OutputFormat }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      const params = new URLSearchParams({ teamId });

      try {
        const data = await client.get<Record<string, unknown>[]>(`/api/integrations?${params}`);
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          if (data.length === 0) {
            console.log('No integrations connected. Use `nyx integrations connect <provider>` to add one.');
            return;
          }
          console.log(formatTable(data, [
            { key: 'type', label: 'Provider', width: 14 },
            { key: 'id', label: 'ID', width: 36 },
            { key: 'createdAt', label: 'Connected', transform: (v) => v ? timeAgo(String(v)) : '' },
            { key: 'updatedAt', label: 'Updated', transform: (v) => v ? timeAgo(String(v)) : '' },
          ]));
          console.log(`\n${data.length} integration(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  integrations
    .command('connect <provider>')
    .description('Show connection URL/instructions for a provider')
    .option('--team-id <teamId>', 'Team ID')
    .action(async (provider: string, opts: { teamId?: string }) => {
      const validated = validateProvider(provider);
      const teamId = resolveTeamId(opts.teamId);

      try {
        const apiUrl = getBaseUrl();

        if (['github', 'gitlab', 'bitbucket'].includes(validated)) {
          const connectUrl = `${apiUrl}/api/integrations/${validated}/connect?teamId=${encodeURIComponent(teamId)}`;
          console.log(`To connect ${validated}, open the following URL in your browser:\n`);
          console.log(`  ${connectUrl}\n`);
          console.log('This will start the OAuth flow and connect the integration to your team.');
        } else if (validated === 'jira') {
          console.log('To connect Jira, provide your Jira credentials via the API:\n');
          console.log(`  nyx integrations create --team-id ${teamId} --type jira --config '{"baseUrl":"https://your-org.atlassian.net","email":"you@example.com","apiToken":"YOUR_TOKEN"}'\n`);
          console.log('You can generate an API token at: https://id.atlassian.com/manage-profile/security/api-tokens');
        } else if (validated === 'confluence') {
          console.log('To connect Confluence, provide your Confluence credentials via the API:\n');
          console.log(`  nyx integrations create --team-id ${teamId} --type confluence --config '{"baseUrl":"https://your-org.atlassian.net/wiki","email":"you@example.com","apiToken":"YOUR_TOKEN"}'\n`);
          console.log('You can generate an API token at: https://id.atlassian.com/manage-profile/security/api-tokens');
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  integrations
    .command('remove <provider>')
    .description('Disconnect an integration by provider')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (provider: string, opts: { teamId?: string; format: OutputFormat }) => {
      const validated = validateProvider(provider);
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      const params = new URLSearchParams({ teamId });

      try {
        // First list integrations to find the one matching the provider
        const all = await client.get<Record<string, unknown>[]>(`/api/integrations?${params}`);
        const match = all.find((i) => i.type === validated);

        if (!match) {
          error(`No ${validated} integration found for this team.`);
        }

        const deleted = await client.delete<Record<string, unknown>>(`/api/integrations/${match.id}`);
        if (opts.format === 'json') {
          console.log(formatOutput(deleted, 'json'));
        } else {
          console.log(`Disconnected ${validated} integration (${match.id}).`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
