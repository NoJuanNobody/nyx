#!/usr/bin/env node
import { Command } from 'commander';

// === COMMAND IMPORTS ===
import { registerPermissionsCommand } from './commands/permissions.js';
// === END COMMAND IMPORTS ===

const program = new Command();

program
  .name('nyx')
  .description('CLI wrapper for the Nyx API')
  .version('0.1.0');

// === COMMAND REGISTRATION ===
registerPermissionsCommand(program);
// === END COMMAND REGISTRATION ===

program.parse();
