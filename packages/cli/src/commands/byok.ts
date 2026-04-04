import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

interface ByokStatusResponse {
  configured: boolean;
  provider?: string;
  keySuffix?: string;
  isActive?: boolean;
  createdAt?: string;
  rotatedAt?: string | null;
}

interface ByokSetResponse {
  provider: string;
  keySuffix: string;
  isActive: boolean;
  createdAt: string;
}

export function registerByokCommand(program: Command): void {
  const byok = program
    .command('byok')
    .description('Manage BYOK (Bring Your Own Key) AI provider keys');

  // nyx byok set --provider anthropic --key "sk-..."
  byok
    .command('set')
    .description('Set a BYOK API key for an AI provider')
    .requiredOption('--provider <provider>', 'AI provider (e.g., anthropic, openai, gemini)')
    .requiredOption('--key <apiKey>', 'API key for the provider')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (opts: {
      provider: string;
      key: string;
      teamId?: string;
      format: string;
    }) => {
      const client = new NyxClient();
      const teamId = resolveTeamId(opts.teamId);

      try {
        process.stderr.write(`  Setting ${opts.provider} API key...\n`);
        const result = await client.post<ByokSetResponse>(
          `/api/teams/${teamId}/ai-key`,
          { provider: opts.provider, apiKey: opts.key },
        );

        if (opts.format === 'json') {
          console.log(formatOutput(result, 'json'));
        } else {
          console.log(`  Provider:   ${result.provider}`);
          console.log(`  Key suffix: ...${result.keySuffix}`);
          console.log(`  Active:     ${result.isActive}`);
          console.log(`  Created:    ${result.createdAt}`);
          console.log('');
          console.log('  BYOK key configured successfully.');
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // nyx byok status
  byok
    .command('status')
    .description('Show current BYOK key status')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (opts: {
      teamId?: string;
      format: string;
    }) => {
      const client = new NyxClient();
      const teamId = resolveTeamId(opts.teamId);

      try {
        const result = await client.get<ByokStatusResponse>(
          `/api/teams/${teamId}/ai-key`,
        );

        if (opts.format === 'json') {
          console.log(formatOutput(result, 'json'));
        } else {
          if (!result.configured) {
            console.log('  No BYOK key configured. Using Nyx-managed AI.');
            console.log('');
            console.log('  Set one with: nyx byok set --provider <provider> --key <key>');
          } else {
            console.log(`  Provider:   ${result.provider}`);
            console.log(`  Key suffix: ...${result.keySuffix}`);
            console.log(`  Active:     ${result.isActive}`);
            console.log(`  Created:    ${result.createdAt}`);
            if (result.rotatedAt) {
              console.log(`  Rotated:    ${result.rotatedAt}`);
            }
          }
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // nyx byok remove
  byok
    .command('remove')
    .description('Remove BYOK key and revert to Nyx-managed AI')
    .option('--team-id <teamId>', 'Team ID')
    .action(async (opts: {
      teamId?: string;
    }) => {
      const client = new NyxClient();
      const teamId = resolveTeamId(opts.teamId);

      try {
        process.stderr.write('  Removing BYOK key...\n');
        await client.delete(`/api/teams/${teamId}/ai-key`).catch((err: Error) => {
          // DELETE returns 204 No Content — res.json() will throw; that's OK
          if (err.message.includes('Unexpected end of JSON')) return;
          throw err;
        });

        console.log('  BYOK key removed. Reverting to Nyx-managed AI.');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
