import { Command } from 'commander';
import { resolveTeamId } from '../client.js';
import { getBaseUrl } from '../lib/api.js';
import { error } from '../utils/output.js';

interface QueryOptions {
  teamId?: string;
  format?: 'text' | 'json';
}

/**
 * Stream an SSE response from the /api/query endpoint to stdout.
 */
async function streamQuery(query: string, teamId: string, format: string): Promise<void> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/api/query`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  const apiKey = process.env.NYX_API_KEY;
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, teamId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API request failed (${res.status}): ${text}`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const jsonChunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          if (format === 'json') {
            console.log(JSON.stringify({ answer: jsonChunks.join('') }));
          } else {
            process.stdout.write('\n');
          }
          return;
        }
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (parsed.error) {
            throw new Error(parsed.error as string);
          }
          const text = (parsed.text as string) ?? '';
          if (text) {
            if (format === 'json') {
              jsonChunks.push(text);
            } else {
              process.stdout.write(text);
            }
          }
        } catch (err) {
          if (err instanceof SyntaxError) {
            process.stdout.write(data);
          } else {
            throw err;
          }
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.startsWith('data: ')) {
    const data = buffer.slice(6);
    if (data !== '[DONE]') {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed.text) {
          if (format === 'json') {
            jsonChunks.push(parsed.text as string);
          } else {
            process.stdout.write(parsed.text as string);
          }
        }
      } catch {
        process.stdout.write(data);
      }
    }
  }

  if (format === 'json') {
    console.log(JSON.stringify({ answer: jsonChunks.join('') }));
  } else {
    process.stdout.write('\n');
  }
}

export function registerQueryCommand(program: Command): void {
  program
    .command('query <question>')
    .description('Ask a question about your documentation (RAG-powered)')
    .option('--team-id <teamId>', 'Team ID')
    .option('--format <format>', 'Output format (text|json)', 'text')
    .action(async (question: string, opts: QueryOptions) => {
      try {
        const teamId = resolveTeamId(opts.teamId);
        await streamQuery(question, teamId, opts.format ?? 'text');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
