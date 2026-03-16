#!/usr/bin/env node
import { Command } from 'commander';

// --- command imports (sentinel: do not remove) ---
import { registerPodcastCommand } from './commands/podcast.js';
// --- end command imports ---

const program = new Command();

program
  .name('nyx')
  .description('Nyx CLI — product versioning platform')
  .version('0.0.1');

// --- command registrations (sentinel: do not remove) ---
registerPodcastCommand(program);
// --- end command registrations ---

program.parse();
