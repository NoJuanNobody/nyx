#!/usr/bin/env node
import { Command } from 'commander';
// -- command imports --
import { registerWatchCommand, registerChangesCommand } from './commands/watch.js';
// -- end command imports --

const program = new Command();

program
  .name('nyx')
  .description('Nyx CLI — interact with the Nyx platform')
  .version('0.1.0');

// -- command registrations --
registerWatchCommand(program);
registerChangesCommand(program);
// -- end command registrations --

program.parse();
