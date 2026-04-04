import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { NyxClient } from '../client.js';

/**
 * A slash command definition for the CLI REPL.
 */
interface SlashCommand {
  name: string;
  description: string;
  usage: string;
  handler: (args: string, client: NyxClient, teamId: string) => Promise<string>;
}

/**
 * Registry of built-in slash commands available in the REPL.
 */
const commands: SlashCommand[] = [
  {
    name: 'help',
    description: 'Show available slash commands',
    usage: '/help',
    handler: async () => {
      const lines = ['Available commands:', ''];
      for (const cmd of commands) {
        lines.push(`  ${cmd.usage.padEnd(24)} ${cmd.description}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'docs',
    description: 'List documents for the current team',
    usage: '/docs',
    handler: async (_args, client, teamId) => {
      const params = new URLSearchParams({ teamId });
      const docs = await client.get<
        { id: string; title: string; status?: string; stage?: string }[]
      >(`/api/documents?${params}`);

      if (docs.length === 0) {
        return '(no documents found)';
      }

      const lines = [`${docs.length} document(s):`, ''];
      for (const doc of docs) {
        const status = doc.stage ?? doc.status ?? '';
        lines.push(`  ${doc.title}  [${status}]  ${doc.id}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'quality',
    description: 'Run AI quality check on a document',
    usage: '/quality <doc-id>',
    handler: async (args, client) => {
      const docId = args.trim();
      if (!docId) {
        return 'Usage: /quality <doc-id>';
      }

      const doc = await client.get<{ content: string }>(`/api/documents/${docId}`);
      const result = await client.post<{
        score: number;
        suggestions?: string[];
      }>('/api/ai/analyze', { content: doc.content });

      const lines = [`Quality Score: ${result.score}/10`];
      if (result.suggestions && result.suggestions.length > 0) {
        lines.push('');
        lines.push('Suggestions:');
        result.suggestions.forEach((s, i) => {
          lines.push(`  ${i + 1}. ${s}`);
        });
      }
      return lines.join('\n');
    },
  },
  {
    name: 'intake',
    description: 'Transform raw text into a structured spec',
    usage: '/intake <text>',
    handler: async (args, client, teamId) => {
      const rawInput = args.trim();
      if (!rawInput) {
        return 'Usage: /intake <text>';
      }

      const data = await client.post<{
        session: { id: string };
        spec: {
          title: string;
          confidence: string;
          userStory: string;
          acceptanceCriteria: string[];
        };
      }>('/api/intake/process', { rawInput, teamId });

      const spec = data.spec;
      const lines = [
        `Title:       ${spec.title}`,
        `Confidence:  ${spec.confidence}`,
        `Session:     ${data.session.id}`,
        '',
        'User Story:',
        `  ${spec.userStory}`,
        '',
        'Acceptance Criteria:',
      ];
      spec.acceptanceCriteria.forEach((c) => lines.push(`  ${c}`));
      return lines.join('\n');
    },
  },
  {
    name: 'status',
    description: 'Check Nyx platform health',
    usage: '/status',
    handler: async () => {
      const configPath = join(homedir(), '.nyx', 'config.json');
      let apiUrl = process.env.NYX_API_URL ?? 'unknown';
      if (existsSync(configPath)) {
        try {
          const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
          apiUrl = raw.apiUrl ?? apiUrl;
        } catch {
          // ignore
        }
      }

      let healthy = false;
      let errorMsg: string | undefined;
      try {
        const res = await fetch(`${apiUrl}/health`);
        healthy = res.ok;
        if (!res.ok) {
          errorMsg = `HTTP ${res.status}`;
        }
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
      }

      const mark = healthy ? '\u2713' : '\u2717';
      const lines = [
        'Nyx Status',
        `  API: ${mark} ${healthy ? 'healthy' : 'unreachable'} (${apiUrl})`,
      ];
      if (errorMsg) {
        lines.push(`       ${errorMsg}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'quit',
    description: 'Exit the REPL',
    usage: '/quit',
    handler: async () => {
      return '__QUIT__';
    },
  },
];

const commandMap = new Map<string, SlashCommand>(
  commands.map((cmd) => [cmd.name, cmd]),
);

/**
 * Returns true if the input string looks like a slash command.
 */
export function isSlashCommand(input: string): boolean {
  return input.trimStart().startsWith('/');
}

/**
 * Handle a slash command from the REPL.
 *
 * @param input - The raw user input (e.g. "/quality abc-123")
 * @param client - An authenticated NyxClient instance
 * @param teamId - The current team ID
 * @returns The output string for the REPL to display
 */
export async function handleSlashCommand(
  input: string,
  client: NyxClient,
  teamId: string,
): Promise<string> {
  const trimmed = input.trimStart();
  const spaceIdx = trimmed.indexOf(' ');
  const name = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx))
    .slice(1) // strip leading '/'
    .toLowerCase();
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);

  const cmd = commandMap.get(name);
  if (!cmd) {
    return `Unknown command: /${name}. Type /help to see available commands.`;
  }

  try {
    return await cmd.handler(args, client, teamId);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
