import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, error, type OutputFormat } from '../utils/output.js';

export function registerAiCommand(program: Command): void {
  const ai = program.command('ai').description('AI generation and analysis commands');

  // nyx ai generate --prompt "..."
  ai
    .command('generate')
    .description('Generate a new document from a prompt')
    .requiredOption('--prompt <prompt>', 'Generation prompt')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (opts: {
      prompt: string;
      format: string;
    }) => {
      const client = new NyxClient();

      try {
        process.stderr.write('  Generating document...\n');
        const result = await client.post<{ title: string; content: string }>('/api/ai/generate-document', {
          prompt: opts.prompt,
        });

        if (opts.format === 'json') {
          console.log(formatOutput(result, 'json'));
        } else {
          const lines: string[] = [];
          if (result.title) {
            lines.push(`  Title: ${result.title}`);
            lines.push('');
          }
          lines.push(result.content);
          console.log(lines.join('\n'));
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // nyx ai edit <doc-id> --instruction "..."
  ai
    .command('edit <doc-id>')
    .description('Edit a document with AI using an instruction')
    .requiredOption('--instruction <text>', 'Edit instruction for the AI')
    .option('--apply', 'Apply the edited content back to the document')
    .option('--format <format>', 'Output format (json|readable)', 'readable')
    .action(async (docId: string, opts: {
      instruction: string;
      apply?: boolean;
      format: string;
    }) => {
      const client = new NyxClient();

      try {
        // Fetch current document content
        process.stderr.write('  Fetching document...\n');
        const doc = await client.get<{ content: string; title: string }>(`/api/documents/${docId}`);

        process.stderr.write('  Applying AI edit...\n');
        const result = await client.post<{ content: string }>('/api/ai/edit-document', {
          content: doc.content,
          instruction: opts.instruction,
        });

        if (opts.apply) {
          await client.put(`/api/documents/${docId}`, {
            content: result.content,
          });
          process.stderr.write(`  Document updated: ${docId}\n`);
        }

        if (opts.format === 'json') {
          console.log(formatOutput(result, 'json'));
        } else {
          console.log(result.content);
          if (!opts.apply) {
            console.log(`\n  ─────────────────────────────────`);
            console.log(`  Preview only. Use --apply to save.`);
          }
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // nyx ai drift <doc-id> --code <file>
  ai
    .command('drift <doc-id>')
    .description('Detect drift between a document spec and code')
    .requiredOption('--code <file>', 'Path to code file to compare against the spec')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(async (docId: string, opts: {
      code: string;
      format: string;
    }) => {
      const client = new NyxClient();

      try {
        // Read local code file
        let codeContent: string;
        try {
          codeContent = readFileSync(opts.code, 'utf-8');
        } catch {
          error(`Cannot read code file: ${opts.code}`);
        }

        // Fetch document spec
        process.stderr.write('  Fetching document...\n');
        const doc = await client.get<{ content: string; title: string }>(`/api/documents/${docId}`);

        process.stderr.write('  Detecting drift...\n');
        const result = await client.post<{
          hasDrift: boolean;
          driftScore?: number;
          summary?: string;
          details?: string[];
          [key: string]: unknown;
        }>('/api/ai/detect-drift', {
          specContent: doc.content,
          codeContent,
        });

        if (opts.format === 'json') {
          console.log(formatOutput(result, 'json'));
        } else {
          const lines: string[] = [];
          lines.push(`  Drift Detected: ${result.hasDrift ? 'Yes' : 'No'}`);
          if (result.driftScore !== undefined) {
            lines.push(`  Drift Score:    ${result.driftScore}/10`);
          }
          if (result.summary) {
            lines.push('');
            lines.push(`  Summary: ${result.summary}`);
          }
          if (result.details && result.details.length > 0) {
            lines.push('');
            lines.push('  Details:');
            result.details.forEach((d, i) => {
              lines.push(`    ${i + 1}. ${d}`);
            });
          }
          console.log(lines.join('\n'));
        }

        // Exit with code 1 if drift is detected (useful for CI)
        if (result.hasDrift) {
          process.exit(1);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // nyx ai missing-sections <doc-id>
  ai
    .command('missing-sections <doc-id>')
    .description('Analyze a document for missing sections')
    .option('--stage <stage>', 'Lifecycle stage for context')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(async (docId: string, opts: {
      stage?: string;
      format: string;
    }) => {
      const client = new NyxClient();

      try {
        // Fetch document content and stage
        process.stderr.write('  Fetching document...\n');
        const doc = await client.get<{ content: string; title: string; stage?: string }>(`/api/documents/${docId}`);

        const stage = opts.stage ?? doc.stage;

        process.stderr.write('  Analyzing missing sections...\n');
        const result = await client.post<{
          missingSections?: string[];
          suggestions?: string[];
          [key: string]: unknown;
        }>('/api/ai/missing-sections', {
          content: doc.content,
          stage,
        });

        if (opts.format === 'json') {
          console.log(formatOutput(result, 'json'));
        } else {
          const sections = result.missingSections ?? result.suggestions ?? [];
          if (sections.length === 0) {
            console.log('  No missing sections detected.');
          } else {
            console.log('  Missing Sections:');
            sections.forEach((s, i) => {
              console.log(`    ${i + 1}. ${s}`);
            });
            console.log(`\n  ${sections.length} section(s) missing`);
          }
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
