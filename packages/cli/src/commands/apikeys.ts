import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, formatTable, error, timeAgo, type OutputFormat } from '../utils/output.js';

interface ApiKeyListItem {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}

interface ApiKeyCreateResult {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
}

export function registerApikeysCommand(program: Command): void {
  const apikeys = program
    .command('apikeys')
    .description('Manage API keys for the team');

  apikeys
    .command('list')
    .description('List API keys for the team')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { teamId?: string; format: OutputFormat }) => {
      const teamId = resolveTeamId(opts.teamId);
      const client = new NyxClient();
      const params = new URLSearchParams({ teamId });

      try {
        const data = await client.get<ApiKeyListItem[]>(`/api/api-keys?${params}`);

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(
            formatTable(data, [
              { key: 'id', label: 'ID', width: 36 },
              { key: 'name', label: 'Name', width: 30 },
              { key: 'keyPrefix', label: 'Prefix', width: 12 },
              {
                key: 'scopes',
                label: 'Scopes',
                width: 20,
                transform: (val) => (Array.isArray(val) ? val.join(', ') : String(val ?? '')),
              },
              {
                key: 'revoked',
                label: 'Status',
                width: 10,
                transform: (val) => (val ? 'revoked' : 'active'),
              },
              {
                key: 'lastUsedAt',
                label: 'Last Used',
                width: 14,
                transform: (val) => (val ? timeAgo(String(val)) : 'never'),
              },
              {
                key: 'createdAt',
                label: 'Created',
                width: 14,
                transform: (val) => (val ? timeAgo(String(val)) : ''),
              },
            ]),
          );
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  apikeys
    .command('create')
    .description('Create a new API key')
    .requiredOption('--name <name>', 'Name for the API key')
    .option('--team-id <teamId>', 'Team ID')
    .option('--scopes <scopes>', 'Comma-separated scopes (default: read,write)')
    .option('--expires-in-days <days>', 'Key expiration in days')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(
      async (opts: {
        name: string;
        teamId?: string;
        scopes?: string;
        expiresInDays?: string;
        format: OutputFormat;
      }) => {
        const teamId = resolveTeamId(opts.teamId);
        const client = new NyxClient();

        const body: Record<string, unknown> = { teamId, name: opts.name };
        if (opts.scopes) {
          body.scopes = opts.scopes.split(',').map((s) => s.trim());
        }
        if (opts.expiresInDays) {
          body.expiresInDays = parseInt(opts.expiresInDays, 10);
        }

        try {
          const data = await client.post<ApiKeyCreateResult>('/api/api-keys', body);

          if (opts.format === 'json') {
            console.log(formatOutput(data, 'json'));
          } else {
            console.log('API key created successfully.\n');
            console.log(`  ID:       ${data.id}`);
            console.log(`  Name:     ${data.name}`);
            console.log(`  Key:      ${data.key}`);
            console.log(`  Prefix:   ${data.keyPrefix}`);
            console.log(`  Scopes:   ${(data.scopes ?? []).join(', ')}`);
            console.log(
              `  Expires:  ${data.expiresAt ? new Date(data.expiresAt).toLocaleDateString() : 'never'}`,
            );
            console.log('\n  Save this key now -- it will not be shown again.');
          }
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );

  apikeys
    .command('revoke <key-id>')
    .description('Revoke an API key')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (keyId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const data = await client.delete<{ revoked: boolean }>(`/api/api-keys/${keyId}`);

        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(`API key ${keyId} has been revoked.`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
