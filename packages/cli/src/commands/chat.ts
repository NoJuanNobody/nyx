import { Command } from 'commander';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NyxClient, resolveTeamId } from '../client.js';
import { renderMarkdown } from '../utils/markdown.js';

interface ChatOptions {
  docId?: string;
  teamId?: string;
  resume?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_FILE_SIZE = 100 * 1024; // 100 KB limit for inlined files

/**
 * Expand @file references in a message into inline file content.
 * Supports @path/to/file and @"path with spaces/file.ts".
 */
function expandFileReferences(message: string): string {
  // Match @"quoted/path" or @unquoted/path (no spaces)
  return message.replace(/@"([^"]+)"|@(\S+)/g, (_match, quoted, unquoted) => {
    const filePath = quoted || unquoted;
    const resolved = path.resolve(filePath);

    try {
      const stats = fs.statSync(resolved);
      if (stats.size > MAX_FILE_SIZE) {
        return `[File too large: ${resolved} (${Math.round(stats.size / 1024)} KB, max 100 KB)]`;
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      const ext = path.extname(resolved).slice(1) || 'txt';
      return `\n<file path="${resolved}">\n\`\`\`${ext}\n${content}\n\`\`\`\n</file>\n`;
    } catch {
      return `[File not found: ${resolved}]`;
    }
  });
}

/**
 * Handle /read <path> command — read a local file and return its content as context.
 */
function handleReadCommand(args: string): string | null {
  const filePath = args.trim().replace(/^["']|["']$/g, '');
  if (!filePath) return null;

  const resolved = path.resolve(filePath);
  try {
    const stats = fs.statSync(resolved);
    if (stats.isDirectory()) {
      const entries = fs.readdirSync(resolved);
      return `Directory ${resolved}:\n${entries.join('\n')}`;
    }
    if (stats.size > MAX_FILE_SIZE) {
      return `File too large: ${resolved} (${Math.round(stats.size / 1024)} KB, max 100 KB)`;
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    const ext = path.extname(resolved).slice(1) || 'txt';
    return `\`\`\`${ext}\n${content}\n\`\`\``;
  } catch {
    return `File not found: ${resolved}`;
  }
}

const SLASH_COMMANDS = ['/quit', '/read ', '/connect '];

const SUPPORTED_PROVIDERS = ['github', 'gitlab', 'bitbucket', 'jira', 'confluence'];

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function createSpinner(message: string) {
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1b[2m\x1b[38;5;141m${SPINNER_FRAMES[i]} ${message}\x1b[0m`);
    i = (i + 1) % SPINNER_FRAMES.length;
  }, 80);

  return {
    stop() {
      clearInterval(timer);
      process.stdout.write('\r\x1b[2K'); // clear the spinner line
    },
  };
}

/**
 * Tab-completion for slash commands and file paths.
 */
function completer(line: string): [string[], string] {
  // Slash command completion
  if (line.startsWith('/')) {
    // /connect <provider> completion
    const connectMatch = line.match(/^\/connect\s+(.*)$/);
    if (connectMatch) {
      const partial = connectMatch[1];
      const matches = SUPPORTED_PROVIDERS
        .filter(p => p.startsWith(partial))
        .map(p => `/connect ${p}`);
      return [matches, line];
    }

    const matches = SLASH_COMMANDS.filter(c => c.startsWith(line));
    return [matches.length ? matches : SLASH_COMMANDS, line];
  }

  // File path completion after @, /read , or standalone path-like input
  let prefix = '';
  let partial = '';

  const readMatch = line.match(/^\/read\s+(.*)$/);
  const atMatch = line.match(/@"([^"]*)$|@(\S*)$/);

  if (readMatch) {
    prefix = line.slice(0, line.length - readMatch[1].length);
    partial = readMatch[1];
  } else if (atMatch) {
    const raw = atMatch[1] ?? atMatch[2];
    prefix = line.slice(0, line.length - raw.length);
    partial = raw;
  } else {
    return [[], line];
  }

  try {
    const resolved = path.resolve(partial);
    let dir: string;
    let base: string;

    // Check if partial points to an existing directory
    try {
      const stats = fs.statSync(resolved);
      if (stats.isDirectory()) {
        dir = resolved;
        base = '';
      } else {
        dir = path.dirname(resolved);
        base = path.basename(resolved);
      }
    } catch {
      dir = path.dirname(resolved);
      base = path.basename(resolved);
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const matching = entries
      .filter(e => e.name.startsWith(base) && !e.name.startsWith('.'))
      .map(e => {
        const rel = path.relative(process.cwd(), path.join(dir, e.name));
        return e.isDirectory() ? `${rel}/` : rel;
      });

    const completions = matching.map(m => `${prefix}${m}`);
    return [completions, line];
  } catch {
    return [[], line];
  }
}

interface StreamResult {
  response: string;
  conversationId?: string;
}

async function streamAgentResponse(
  message: string,
  opts: ChatOptions,
  client: NyxClient,
  history: ChatMessage[],
  conversationId?: string,
): Promise<StreamResult> {
  const url = `${client.apiUrl}/api/agent`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${client.apiKey}`,
  };

  const teamId = resolveTeamId(opts.teamId);
  const body: Record<string, unknown> = { prompt: message, teamId };
  if (opts.docId) body.documentId = opts.docId;
  // When a conversationId exists, server reconstructs history from DB — skip sending it
  if (history.length > 0 && !conversationId) body.history = history;
  if (conversationId) body.conversationId = conversationId;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API request failed (${res.status}): ${text}`);
  }

  const resConversationId = res.headers.get('X-Conversation-Id') ?? undefined;
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
            if (text) {
              // Separate consecutive text blocks (agent emits text between tool calls)
              if (fullResponse && !fullResponse.endsWith('\n\n')) {
                fullResponse += fullResponse.endsWith('\n') ? '\n' : '\n\n';
              }
              fullResponse += text;
            }
          } catch {
            fullResponse += data;
          }
        }
      }
    }

    return { response: fullResponse, conversationId: resConversationId };
  } else {
    // Non-SSE JSON response
    const json = (await res.json()) as Record<string, unknown>;
    const text =
      (json.text as string) ??
      (json.content as string) ??
      (json.response as string) ??
      JSON.stringify(json, null, 2);

    return { response: text, conversationId: resConversationId };
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
    completer,
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
  console.log(`  ${dim}Use @path/to/file to include file contents, /read <path> to preview${reset}`);
  console.log('');

  const conversationHistory: ChatMessage[] = [];
  let activeConversationId: string | undefined = opts.resume;

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

    // /read <path> — display a local file without sending to the agent
    if (trimmed.startsWith('/read ')) {
      const output = handleReadCommand(trimmed.slice(6));
      if (output) {
        console.log(`\n${dim}${cyan}${renderMarkdown(output)}${reset}\n`);
      }
      rl.prompt();
      return;
    }

    // /connect <provider> — show OAuth URL for integrations
    if (trimmed.startsWith('/connect')) {
      const provider = trimmed.slice(8).trim().toLowerCase();
      if (!provider || !SUPPORTED_PROVIDERS.includes(provider)) {
        console.log(`\n${dim}Usage: /connect <provider>${reset}`);
        console.log(`${dim}Supported: ${SUPPORTED_PROVIDERS.join(', ')}${reset}\n`);
      } else {
        const teamId = resolveTeamId(opts.teamId);
        if (['github', 'gitlab', 'bitbucket'].includes(provider)) {
          const connectUrl = `${client.apiUrl}/api/integrations/${provider}/connect?teamId=${encodeURIComponent(teamId)}`;
          console.log(`\n${dim}Open this URL to connect ${provider}:${reset}\n`);
          console.log(`  ${cyan}${connectUrl}${reset}\n`);
        } else if (provider === 'jira' || provider === 'confluence') {
          console.log(`\n${dim}Connect ${provider} via the CLI:${reset}\n`);
          console.log(`  ${cyan}nyx integrations connect ${provider}${reset}\n`);
        }
      }
      rl.prompt();
      return;
    }

    // Expand @file references in the message
    const expanded = expandFileReferences(trimmed);

    const spinner = createSpinner('Thinking...');
    try {
      const result = await streamAgentResponse(expanded, opts, client, conversationHistory, activeConversationId);
      spinner.stop();
      console.log('');
      process.stdout.write(`${dim}${cyan}`);
      if (result.response) {
        console.log(renderMarkdown(result.response));
      }
      process.stdout.write(reset);

      // Accumulate conversation history for multi-turn context
      conversationHistory.push({ role: 'user', content: expanded });
      if (result.response) {
        conversationHistory.push({ role: 'assistant', content: result.response });
      }

      // Track conversation ID for session continuity
      if (result.conversationId) {
        activeConversationId = result.conversationId;
      }
    } catch (err) {
      spinner.stop();
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
    .option('--resume <conversationId>', 'Resume a previous conversation')
    .action((opts: ChatOptions) => {
      const client = new NyxClient();
      startRepl(opts, client);
    });
}
