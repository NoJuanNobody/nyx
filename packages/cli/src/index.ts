#!/usr/bin/env node
import { Command } from 'commander';

// -- sentinel:import --
import { registerGovernanceCommand } from './commands/governance.js';
// -- sentinel:import:end --

const program = new Command();

program
  .name('nyx')
  .description('Nyx CLI — product versioning platform')
  .version('0.1.0');

// -- sentinel:register --
registerGovernanceCommand(program);
// -- sentinel:register:end --

program.parse();
