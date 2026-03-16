#!/usr/bin/env node
import { Command } from 'commander';

// === COMMAND IMPORTS ===
import { registerDocsCommand } from './commands/docs.js';
import { registerConfigCommand } from './commands/config.js';
import { registerAuditCommand, registerActivityCommand } from './commands/audit.js';
// === END COMMAND IMPORTS ===

const program = new Command();

program
  .name('nyx')
  .description('CLI wrapper for the Nyx API')
  .version('0.1.0');

// === COMMAND REGISTRATION ===
registerDocsCommand(program);
registerConfigCommand(program);
registerAuditCommand(program);
registerActivityCommand(program);
// === END COMMAND REGISTRATION ===

program.parse();
