import { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { formatOutput, type OutputFormat } from '../utils/output.js';

const CONFIG_DIR = join(homedir(), '.nyx');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function readConfig(): Record<string, string> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, string>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Manage CLI configuration');

  config
    .command('set <key> <value>')
    .description('Set a configuration value (e.g., apiKey, apiUrl)')
    .action((key: string, value: string) => {
      const cfg = readConfig();
      cfg[key] = value;
      writeConfig(cfg);
      console.log(`Set ${key}`);
    });

  config
    .command('show')
    .description('Show current configuration')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action((opts: { format: OutputFormat }) => {
      const cfg = readConfig();
      // Mask the API key for display
      const display = { ...cfg };
      if (display.apiKey) {
        display.apiKey = display.apiKey.slice(0, 8) + '...' + display.apiKey.slice(-4);
      }
      console.log(formatOutput(display, opts.format));
    });
}
