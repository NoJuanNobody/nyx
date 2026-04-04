import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { NyxClient, resolveTeamId } from '../client.js';
import { error } from '../utils/output.js';

interface HealthResponse {
  status: string;
  [key: string]: unknown;
}

interface TeamInfo {
  id: string;
  name: string;
  role?: string;
  documentCount?: number;
  [key: string]: unknown;
}

interface AgentSession {
  id: string;
  [key: string]: unknown;
}

function loadApiUrl(): string {
  const configPath = join(homedir(), '.nyx', 'config.json');
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return raw.apiUrl ?? process.env.NYX_API_URL ?? 'unknown';
    } catch {
      // fall through
    }
  }
  return process.env.NYX_API_URL ?? 'unknown';
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check Nyx platform health and connection info')
    .option('--format <format>', 'Output format (json|pretty)', 'pretty')
    .action(async (opts: { format: string }) => {
      const apiUrl = loadApiUrl();
      const results: {
        api: { healthy: boolean; url: string; error?: string };
        team?: { name: string; role: string; docs: number; agents: number };
        teamError?: string;
      } = {
        api: { healthy: false, url: apiUrl },
      };

      // 1. Check /health endpoint (unauthenticated)
      try {
        const res = await fetch(`${apiUrl}/health`);
        if (res.ok) {
          const data = (await res.json()) as HealthResponse;
          results.api.healthy = data.status === 'ok' || res.ok;
        } else {
          results.api.error = `HTTP ${res.status}`;
        }
      } catch (err) {
        results.api.error = err instanceof Error ? err.message : String(err);
      }

      // 2. Check team info (authenticated)
      try {
        const client = new NyxClient();
        const teamId = resolveTeamId();
        const teams = await client.get<TeamInfo[]>('/api/teams');
        const team = teams.find((t) => t.id === teamId) ?? teams[0];

        let agentCount = 0;
        try {
          const params = new URLSearchParams({ teamId });
          const sessions = await client.get<AgentSession[]>(`/api/agent/sessions?${params}`);
          agentCount = sessions.length;
        } catch {
          // agent sessions endpoint may not be available
        }

        if (team) {
          results.team = {
            name: team.name,
            role: team.role ?? 'member',
            docs: team.documentCount ?? 0,
            agents: agentCount,
          };
        }
      } catch (err) {
        results.teamError = err instanceof Error ? err.message : String(err);
      }

      // Output
      if (opts.format === 'json') {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      // Pretty output
      const check = '\u2713';
      const cross = '\u2717';
      const line = '\u2500'.repeat(18);

      console.log('');
      console.log('  Nyx Status');
      console.log(`  ${line}`);

      if (results.api.healthy) {
        console.log(`  API:     ${check} healthy (${apiUrl})`);
      } else {
        console.log(`  API:     ${cross} unreachable (${apiUrl})`);
        if (results.api.error) {
          console.log(`           ${results.api.error}`);
        }
      }

      if (results.team) {
        console.log(`  Team:    ${results.team.name} (${results.team.role})`);
        console.log(`  Docs:    ${results.team.docs}`);
        console.log(`  Agents:  ${results.team.agents} sessions`);
      } else if (results.teamError) {
        console.log(`  Team:    ${cross} ${results.teamError}`);
      }

      console.log('');

      if (!results.api.healthy) {
        process.exit(1);
      }
    });
}
