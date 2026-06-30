#!/usr/bin/env node
import { Command } from 'commander';

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
    sync                  Two-way sync: Nyx docs ↔ local .md files
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

  Codebase:
    scan [doc-id]         Scan repo to fill missing spec sections

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
    deliverables          Export docs (PDF, LaTeX, DOCX, etc.)
    templates             Document templates

  Operations:
    status                Platform health check
    jobs                  Background job status
    agent                 AI agent sessions
    orchestrate           Multi-agent pipelines
    admin                 Super-admin operations
    config                CLI configuration`)
  .version('0.1.0');

// === LAZY COMMAND REGISTRATION ===
// Commands are loaded on-demand to keep CLI startup fast.
// Each entry: [commandName, modulePath, registerFunctionName(s)]
const commands: Array<[string[], string, string[]]> = [
  [['docs'], './commands/docs.js', ['registerDocsCommand']],
  [['config'], './commands/config.js', ['registerConfigCommand']],
  [['audit', 'activity'], './commands/audit.js', ['registerAuditCommand', 'registerActivityCommand']],
  [['quality'], './commands/quality.js', ['registerQualityCommand']],
  [['sprint'], './commands/sprint.js', ['registerSprintCommand']],
  [['agent'], './commands/agent.js', ['registerAgentCommand']],
  [['versions', 'diff'], './commands/versions.js', ['registerVersionsCommand', 'registerDiffCommand']],
  [['bulk'], './commands/bulk.js', ['registerBulkCommand']],
  [['proposals'], './commands/proposals.js', ['registerProposalsCommand']],
  [['governance'], './commands/governance.js', ['registerGovernanceCommand']],
  [['permissions'], './commands/permissions.js', ['registerPermissionsCommand']],
  [['watch', 'changes'], './commands/watch.js', ['registerWatchCommand', 'registerChangesCommand']],
  [['orchestrate'], './commands/orchestrate.js', ['registerOrchestrateCommand']],
  [['intake'], './commands/intake.js', ['registerIntakeCommand']],
  [['tickets'], './commands/tickets.js', ['registerTicketsCommand']],
  [['jobs'], './commands/jobs.js', ['registerJobsCommand']],
  [['status'], './commands/status.js', ['registerStatusCommand']],
  [['ai'], './commands/ai.js', ['registerAiCommand']],
  [['branches'], './commands/branches.js', ['registerBranchesCommand']],
  [['search', 'context'], './commands/search.js', ['registerSearchCommand', 'registerContextCommand']],
  [['templates'], './commands/templates.js', ['registerTemplatesCommand']],
  [['deliverables'], './commands/deliverables.js', ['registerDeliverablesCommand']],
  [['timeline'], './commands/timeline.js', ['registerTimelineCommand']],
  [['snapshot'], './commands/snapshot.js', ['registerSnapshotCommand']],
  [['notifications'], './commands/notifications.js', ['registerNotificationsCommand']],
  [['apikeys'], './commands/apikeys.js', ['registerApikeysCommand']],
  [['integrations'], './commands/integrations.js', ['registerIntegrationsCommand']],
  [['byok'], './commands/byok.js', ['registerByokCommand']],
  [['credits'], './commands/credits.js', ['registerCreditsCommand']],
  [['registry'], './commands/registry.js', ['registerRegistryCommand']],
  [['billing'], './commands/billing.js', ['registerBillingCommand']],
  [['voice'], './commands/voice.js', ['registerVoiceCommand']],
  [['features'], './commands/features.js', ['registerFeaturesCommand']],
  [['admin'], './commands/admin.js', ['registerAdminCommand']],
  [['chat'], './commands/chat.js', ['registerChatCommand']],
  [['query'], './commands/query.js', ['registerQueryCommand']],
  [['check'], './commands/check.js', ['registerCheckCommand']],
  [['scan'], './commands/scan.js', ['registerScanCommand']],
  [['sync'], './commands/sync.js', ['registerSyncCommand']],
];

// Determine which command the user invoked (first non-flag arg)
const requestedCommand = process.argv[2];

async function main() {
  if (requestedCommand && !requestedCommand.startsWith('-')) {
    // Load only the module that provides the requested command
    for (const [names, modulePath, registerFns] of commands) {
      if (names.includes(requestedCommand)) {
        const mod = await import(modulePath);
        for (const fn of registerFns) {
          mod[fn](program);
        }
        break;
      }
    }
  } else {
    // No command or help/version flag — load all commands so help text works
    for (const [, modulePath, registerFns] of commands) {
      const mod = await import(modulePath);
      for (const fn of registerFns) {
        mod[fn](program);
      }
    }
  }

  program.parse();
}

main();
// === END LAZY COMMAND REGISTRATION ===
