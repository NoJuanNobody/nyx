import { Command } from 'commander';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { getBaseUrl } from '../lib/api.js';

interface ChatOptions {
  docId?: string;
  teamId?: string;
}

async function streamAgentResponse(
  message: string,
  opts: ChatOptions,
): Promise<void> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/api/agent`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  const apiKey = process.env.NYX_API_KEY;
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const body: Record<string, unknown> = { message };
  if (opts.docId) body.docId = opts.docId;
  if (opts.teamId) body.teamId = opts.teamId;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API request failed (${res.status}): ${text}`);
  }

  const contentType = res.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    // Stream SSE chunks to stdout
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            process.stdout.write('\n');
            return;
          }
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const text =
              (parsed.text as string) ??
              (parsed.content as string) ??
              (parsed.delta as string) ??
              '';
            if (text) {
              process.stdout.write(text);
            }
          } catch {
            // If it's not JSON, write raw data
            process.stdout.write(data);
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.startsWith('data: ')) {
      const data = buffer.slice(6);
      if (data !== '[DONE]') {
        process.stdout.write(data);
      }
    }

    process.stdout.write('\n');
  } else {
    // Non-SSE JSON response - print the content
    const json = (await res.json()) as Record<string, unknown>;
    const text =
      (json.text as string) ??
      (json.content as string) ??
      (json.response as string) ??
      JSON.stringify(json, null, 2);
    console.log(text);
  }
}

function startRepl(opts: ChatOptions): void {
  const rl: ReadlineInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'nyx> ',
  });

  const scope: string[] = [];
  if (opts.docId) scope.push(`doc:${opts.docId}`);
  if (opts.teamId) scope.push(`team:${opts.teamId}`);

  console.log('');
  console.log('  Nyx interactive REPL');
  if (scope.length > 0) {
    console.log(`  Scope: ${scope.join(', ')}`);
  }
  console.log('  Type /quit or press Ctrl+C to exit');
  console.log('');

  rl.prompt();

  rl.on('line', async (input: string) => {
    const trimmed = input.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed === '/quit') {
      console.log('Goodbye.');
      rl.close();
      process.exit(0);
    }

    try {
      await streamAgentResponse(trimmed, opts);
    } catch (err) {
      console.error(
        'Error:',
        err instanceof Error ? err.message : String(err),
      );
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nGoodbye.');
    process.exit(0);
  });
}

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Start an interactive REPL session with the Nyx agent')
    .option('--doc-id <docId>', 'Scope the conversation to a specific document')
    .option('--team-id <teamId>', 'Scope the conversation to a specific team')
    .action((opts: ChatOptions) => {
      startRepl(opts);
    });
}
