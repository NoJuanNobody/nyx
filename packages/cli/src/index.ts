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
import { registerBillingCommand } from './commands/billing.js';
import { registerVoiceCommand } from './commands/voice.js';
import { registerVideoCommand } from './commands/video.js';
import { registerFeaturesCommand } from './commands/features.js';
import { registerAdminCommand } from './commands/admin.js';
import { registerChatCommand } from './commands/chat.js';
import { registerQueryCommand } from './commands/query.js';
import { registerCheckCommand } from './commands/check.js';
// === END COMMAND IMPORTS ===

const program = new Command();

program
  .name('nyx')
  .description(`Nyx — Product Versioning Platform

  Goddess of night, mother of dreams.
  Turn ideas into specs. Keep specs in sync with code.

  Core:
    chat                  Interactive AI REPL
    intake                Raw ideas → structured specs
    docs                  Document CRUD
    quality               AI quality scoring & improvement
    tickets               AI ticket generation, create, sync
    check <file>          Spec compliance gate

  Discovery:
    search <query>        Web search
    context <doc-id>      Find related specs
    query "question"      RAG-powered Q&A over docs

  Lifecycle:
    branches              Document branching & merging
    versions / diff       Version history & diffs
    proposals             Stakeholder change proposals
    timeline / snapshot   Event timeline & snapshots

  Integrations:
    integrations          Connect GitHub, GitLab, Jira, etc.
    apikeys               API key management
    byok                  Bring your own AI key

  Platform:
    sprint                Sprint capacity & gating
    billing / credits     Plans, usage, credits
    notifications         Notification management
    permissions           Role & permission checks
    governance            Policy validation

  Content:
    podcast               Generate podcast scripts & audio
    deliverables          Export docs (PDF, LaTeX, DOCX, etc.)
    templates / marketplace  Templates & marketplace
    video                 Video generation

  Operations:
    status                Platform health check
    jobs                  Background job status
    agent                 AI agent sessions
    orchestrate           Multi-agent pipelines
    admin                 Super-admin operations
    config                CLI configuration`)
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
registerBillingCommand(program);
registerVoiceCommand(program);
registerVideoCommand(program);
registerFeaturesCommand(program);
registerAdminCommand(program);
registerChatCommand(program);
registerQueryCommand(program);
registerCheckCommand(program);
// === END COMMAND REGISTRATION ===

program.parse();
