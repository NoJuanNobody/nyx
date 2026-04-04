import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { NyxClient, resolveTeamId } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

export interface ComplianceViolation {
  rule: string;
  severity: 'error' | 'warning';
  description: string;
  specRef: string;
}

export interface ComplianceResult {
  compliant: boolean;
  violations: ComplianceViolation[];
}

const SEVERITY_ICONS: Record<string, string> = {
  error: 'x',
  warning: '!',
};

export function registerCheckCommand(program: Command): void {
  program
    .command('check <file>')
    .description('Check a source file for spec compliance')
    .option('--team-id <id>', 'Team ID (overrides config / env)')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(async (file: string, opts: { teamId?: string; format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const teamId = resolveTeamId(opts.teamId);

        let content: string;
        try {
          content = readFileSync(file, 'utf-8');
        } catch {
          error(`Could not read file: ${file}`);
        }

        if (!content.trim()) {
          error('File is empty');
        }

        const result = await client.post<ComplianceResult>('/api/compliance/check', {
          code: content,
          teamId,
          filePath: file,
        });

        if (opts.format === 'json') {
          console.log(formatOutput(result, 'json'));
        } else {
          if (result.compliant) {
            console.log('  Compliant — no violations found.');
          } else {
            const errors = result.violations.filter((v) => v.severity === 'error');
            const warnings = result.violations.filter((v) => v.severity === 'warning');
            console.log(
              `  ${errors.length} error(s), ${warnings.length} warning(s)\n`,
            );
            for (const v of result.violations) {
              const icon = SEVERITY_ICONS[v.severity] ?? '?';
              console.log(`  [${icon}] ${v.severity.toUpperCase()}: ${v.rule}`);
              console.log(`      ${v.description}`);
              if (v.specRef) {
                console.log(`      ref: ${v.specRef}`);
              }
              console.log('');
            }
          }
        }

        if (result.violations.some((v) => v.severity === 'error')) {
          process.exit(1);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
