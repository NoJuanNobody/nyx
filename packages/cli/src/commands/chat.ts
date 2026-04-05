import { Command } from 'commander';
import * as readline from 'node:readline';
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
  const purple = '\x1b[38;5;141m';
  const dim = '\x1b[2m';
  const cyan = '\x1b[38;5;117m';
  const reset = '\x1b[0m';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${purple}nyx>${reset} `,
  }) as any;

  const scope: string[] = [];
  if (opts.docId) scope.push(`doc:${opts.docId}`);
  if (opts.teamId) scope.push(`team:${opts.teamId}`);

  const deepPurple = '\x1b[38;5;99m';
  const midPurple = '\x1b[38;5;134m';
  const stars = '\x1b[38;5;229m';

  console.log('');
  console.log(`${dim}${deepPurple}              .  ${stars}*${deepPurple}                          ${stars}.${reset}`);
  console.log(`${dim}${deepPurple}        ${stars}*${deepPurple}          ${stars}·${reset}`);
  console.log(`${purple}    ███╗   ██╗██╗   ██╗██╗  ██╗${reset}`);
  console.log(`${purple}    ████╗  ██║╚██╗ ██╔╝╚██╗██╔╝${reset}`);
  console.log(`${midPurple}    ██╔██╗ ██║ ╚████╔╝  ╚███╔╝${reset}`);
  console.log(`${midPurple}    ██║╚██╗██║  ╚██╔╝   ██╔██╗${reset}`);
  console.log(`${deepPurple}    ██║ ╚████║   ██║   ██╔╝ ██╗${reset}`);
  console.log(`${deepPurple}    ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝${reset}`);
  console.log(`${dim}${deepPurple}        ${stars}·${deepPurple}        ${stars}*${deepPurple}       ${dim}${midPurple}goddess of night${reset}`);
  console.log(`${dim}${deepPurple}    ${stars}*${deepPurple}                      ${dim}${midPurple}mother of dreams${reset}`);
  console.log('');
  if (scope.length > 0) {
    console.log(`  ${dim}Scope: ${scope.join(', ')}${reset}`);
  }
  console.log(`  ${dim}Type /quit or press Ctrl+C to exit${reset}`);
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
      process.stdout.write(`\n${dim}${cyan}`);
      await streamAgentResponse(trimmed, opts, client);
      process.stdout.write(reset);
    } catch (err) {
      process.stdout.write(reset);
      console.error(
        '\x1b[31mError:\x1b[0m',
        err instanceof Error ? err.message : String(err),
      );
    }

    console.log('');
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
