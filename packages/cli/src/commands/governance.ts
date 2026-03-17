import { Command } from 'commander';
import fs from 'node:fs';

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
  /(?:secret|token|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /(?:sk|pk)[-_](?:live|test)[-_][A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36,}/,
  /xoxb-[A-Za-z0-9\-]+/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
];

function detectSecretsLocally(content: string): string[] {
  const violations: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(`Matches secret pattern: ${pattern.source}`);
    }
  }
  return violations;
}

function getApiBaseUrl(): string {
  return process.env.NYX_API_URL || 'http://localhost:3001';
}

async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${getApiBaseUrl()}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function formatOutput(
  data: unknown,
  format: string,
): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  // Table format
  if (typeof data === 'object' && data !== null) {
    const result = data as Record<string, unknown>;

    if ('allowed' in result) {
      const lines: string[] = [];
      lines.push(`Allowed: ${result.allowed ? 'YES' : 'NO'}`);

      const violations = result.violations as string[];
      if (violations?.length) {
        lines.push('');
        lines.push('Violations:');
        violations.forEach((v: string) => lines.push(`  - ${v}`));
      }

      const warnings = result.warnings as string[];
      if (warnings?.length) {
        lines.push('');
        lines.push('Warnings:');
        warnings.forEach((w: string) => lines.push(`  - ${w}`));
      }

      return lines.join('\n');
    }

    return JSON.stringify(data, null, 2);
  }

  return String(data);
}

export function registerGovernanceCommand(program: Command): void {
  const governance = program
    .command('governance')
    .description('AI governance runtime — validate actions and check policies');

  governance
    .command('validate')
    .description('Validate an action against governance rules')
    .requiredOption('--action <action>', 'Action to validate (publish, edit, create, delete)')
    .requiredOption('--team-id <id>', 'Team ID')
    .option('--doc-id <id>', 'Document ID')
    .option('--content <content>', 'Content to validate')
    .option('--stage <stage>', 'Document lifecycle stage')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (options) => {
      try {
        const body: Record<string, string> = {
          action: options.action,
          teamId: options.teamId,
        };
        if (options.docId) body.documentId = options.docId;
        if (options.content) body.content = options.content;
        if (options.stage) body.stage = options.stage;

        const result = await apiRequest('POST', '/api/governance/validate', body);
        const output = formatOutput(result, options.format);
        console.log(output);

        const typedResult = result as { allowed: boolean };
        if (!typedResult.allowed) {
          process.exit(1);
        }
      } catch (err) {
        console.error(
          `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
        process.exit(1);
      }
    });

  governance
    .command('rules')
    .description('Display governance rules from .agentpolicy/')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (options) => {
      try {
        const result = await apiRequest('GET', '/api/governance/rules');
        const output = formatOutput(result, options.format);
        console.log(output);
      } catch (err) {
        console.error(
          `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
        process.exit(1);
      }
    });

  governance
    .command('check-file')
    .description('Check a local file for secrets (no API call needed)')
    .argument('<file>', 'Path to the file to check')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action((file, options) => {
      try {
        if (!fs.existsSync(file)) {
          console.error(`Error: File not found: ${file}`);
          process.exit(1);
        }

        const content = fs.readFileSync(file, 'utf-8');
        const violations = detectSecretsLocally(content);

        const result = {
          file,
          allowed: violations.length === 0,
          violations,
        };

        const output = formatOutput(result, options.format);
        console.log(output);

        if (violations.length > 0) {
          process.exit(1);
        }
      } catch (err) {
        console.error(
          `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
        process.exit(1);
      }
    });
}
