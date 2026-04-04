import { Command } from 'commander';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { NyxClient, resolveTeamId } from '../client.js';
import { renderMarkdown } from '../utils/markdown.js';

interface ChatOptions {
  docId?: string;
  teamId?: string;
}

async function streamAgentResponse(
  message: string,
  opts: ChatOptions,
  client: NyxClient,
): Promise<void> {
  const url = `${client.apiUrl}/api/agent`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${client.apiKey}`,
  };

  const teamId = resolveTeamId(opts.teamId);
  const body: Record<string, unknown> = { prompt: message, teamId };
  if (opts.docId) body.documentId = opts.docId;

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
    let fullResponse = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            const text =
              (parsed.text as string) ??
              (parsed.content as string) ??
              (parsed.delta as string) ??
              '';
            if (text) fullResponse += text;
          } catch {
            fullResponse += data;
          }
        }
      }
    }

    if (fullResponse) {
      console.log(renderMarkdown(fullResponse));
    }
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

function startRepl(opts: ChatOptions, client: NyxClient): void {
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
      await streamAgentResponse(trimmed, opts, client);
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
      const client = new NyxClient();
      startRepl(opts, client);
    });
}
