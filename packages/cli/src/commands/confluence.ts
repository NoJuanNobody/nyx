import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

export function registerConfluenceCommand(program: Command): void {
  const confluence = program
    .command('confluence')
    .description('Confluence integration commands');

  confluence
    .command('spaces')
    .description('List available Confluence spaces')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get('/api/confluence/spaces');
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  confluence
    .command('pages <spaceKey>')
    .description('List pages in a Confluence space')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (spaceKey: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(
          `/api/confluence/spaces/${spaceKey}/pages`,
        );
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  confluence
    .command('import <pageId>')
    .description('Import a Confluence page with auto quality check')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(
      async (
        pageId: string,
        opts: { teamId: string; format: OutputFormat },
      ) => {
        const client = new NyxClient();
        try {
          const data = await client.post('/api/confluence/import', {
            pageId,
            teamId: opts.teamId,
          });
          console.log(formatOutput(data, opts.format));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );

  confluence
    .command('import-space <spaceKey>')
    .description('Import all pages in a Confluence space')
    .requiredOption('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(
      async (
        spaceKey: string,
        opts: { teamId: string; format: OutputFormat },
      ) => {
        const client = new NyxClient();
        try {
          const data = await client.post('/api/confluence/import-space', {
            spaceKey,
            teamId: opts.teamId,
          });
          console.log(formatOutput(data, opts.format));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );
}
