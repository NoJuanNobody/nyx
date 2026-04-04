#!/usr/bin/env node
import { Command } from 'commander';

// === COMMAND IMPORTS ===
import { registerDocsCommand } from './commands/docs.js';
import { registerConfigCommand } from './commands/config.js';
import { registerAuditCommand, registerActivityCommand } from './commands/audit.js';
import { registerQualityCommand } from './commands/quality.js';
import { registerSprintCommand } from './commands/sprint.js';
import { registerAgentCommand } from './commands/agent.js';
import { registerVersionsCommand, registerDiffCommand } from './commands/versions.js';
import { registerBulkCommand } from './commands/bulk.js';
import { registerProposalsCommand } from './commands/proposals.js';
import { registerGovernanceCommand } from './commands/governance.js';
import { registerPermissionsCommand } from './commands/permissions.js';
import { registerPodcastCommand } from './commands/podcast.js';
import { registerWatchCommand, registerChangesCommand } from './commands/watch.js';
import { registerOrchestrateCommand } from './commands/orchestrate.js';
import { registerIntakeCommand } from './commands/intake.js';
import { registerTicketsCommand } from './commands/tickets.js';
import { registerJobsCommand } from './commands/jobs.js';
import { registerStatusCommand } from './commands/status.js';
import { registerAiCommand } from './commands/ai.js';
import { registerBranchesCommand } from './commands/branches.js';
import { registerSearchCommand, registerContextCommand } from './commands/search.js';
import { registerTemplatesCommand, registerMarketplaceCommand } from './commands/templates.js';
import { registerDeliverablesCommand } from './commands/deliverables.js';
import { registerTimelineCommand } from './commands/timeline.js';
import { registerSnapshotCommand } from './commands/snapshot.js';
import { registerNotificationsCommand } from './commands/notifications.js';
import { registerApikeysCommand } from './commands/apikeys.js';
import { registerIntegrationsCommand } from './commands/integrations.js';
import { registerByokCommand } from './commands/byok.js';
import { registerCreditsCommand } from './commands/credits.js';
import { registerRegistryCommand } from './commands/registry.js';
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
registerQualityCommand(program);
registerSprintCommand(program);
registerAgentCommand(program);
registerVersionsCommand(program);
registerDiffCommand(program);
registerBulkCommand(program);
registerProposalsCommand(program);
registerGovernanceCommand(program);
registerPermissionsCommand(program);
registerPodcastCommand(program);
registerWatchCommand(program);
registerChangesCommand(program);
registerOrchestrateCommand(program);
registerIntakeCommand(program);
registerTicketsCommand(program);
registerJobsCommand(program);
registerStatusCommand(program);
registerAiCommand(program);
registerBranchesCommand(program);
registerSearchCommand(program);
registerContextCommand(program);
registerTemplatesCommand(program);
registerMarketplaceCommand(program);
registerDeliverablesCommand(program);
registerTimelineCommand(program);
registerSnapshotCommand(program);
registerNotificationsCommand(program);
registerApikeysCommand(program);
registerIntegrationsCommand(program);
registerByokCommand(program);
registerCreditsCommand(program);
registerRegistryCommand(program);
// === END COMMAND REGISTRATION ===

program.parse();
