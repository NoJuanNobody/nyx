import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

export function registerVersionsCommand(program: Command): void {
  program
    .command('versions <doc-id>')
    .description('List versions for a document')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (docId: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(`/api/documents/${docId}/versions`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}

export function registerDiffCommand(program: Command): void {
  program
    .command('diff <version-a> <version-b>')
    .description('Show diff between two document versions')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (versionA: string, versionB: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get(`/api/versions/${versionA}/diff/${versionB}`);
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
