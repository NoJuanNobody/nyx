import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatTable, formatOutput, error, type OutputFormat } from '../utils/output.js';

interface AdminTeam {
  id: string;
  name: string;
  slug: string;
  memberCount?: number;
  createdAt: string;
  [key: string]: unknown;
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  [key: string]: unknown;
}

interface PlatformStats {
  totalTeams: number;
  totalUsers: number;
  totalDocuments: number;
  [key: string]: unknown;
}

export function registerAdminCommand(program: Command): void {
  const admin = program
    .command('admin')
    .description('Super-admin operations (requires elevated privileges)');

  // ── nyx admin teams ────────────────────────────────────
  admin
    .command('teams')
    .description('List all teams on the platform')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const teams = await client.get<AdminTeam[]>('/api/admin/teams');

        if (opts.format === 'json') {
          console.log(formatOutput(teams, 'json'));
          return;
        }

        const table = formatTable(teams, [
          { key: 'id', label: 'ID', width: 36 },
          { key: 'name', label: 'Name', width: 30 },
          { key: 'slug', label: 'Slug', width: 20 },
          {
            key: 'memberCount',
            label: 'Members',
            width: 8,
            transform: (val) => (val != null ? String(val) : '-'),
          },
          {
            key: 'createdAt',
            label: 'Created',
            width: 12,
            transform: (val) =>
              val ? new Date(String(val)).toLocaleDateString() : '-',
          },
        ]);

        console.log('');
        console.log('  All Teams');
        console.log('');
        console.log(table);
        console.log('');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx admin users ────────────────────────────────────
  admin
    .command('users')
    .description('List all users on the platform')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const users = await client.get<AdminUser[]>('/api/admin/users');

        if (opts.format === 'json') {
          console.log(formatOutput(users, 'json'));
          return;
        }

        const table = formatTable(users, [
          { key: 'id', label: 'ID', width: 36 },
          { key: 'name', label: 'Name', width: 24 },
          { key: 'email', label: 'Email', width: 30 },
          {
            key: 'createdAt',
            label: 'Created',
            width: 12,
            transform: (val) =>
              val ? new Date(String(val)).toLocaleDateString() : '-',
          },
        ]);

        console.log('');
        console.log('  All Users');
        console.log('');
        console.log(table);
        console.log('');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  // ── nyx admin stats ────────────────────────────────────
  admin
    .command('stats')
    .description('Show platform-wide statistics')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { format: OutputFormat }) => {
      const client = new NyxClient();

      try {
        const stats = await client.get<PlatformStats>('/api/admin/stats');

        if (opts.format === 'json') {
          console.log(formatOutput(stats, 'json'));
          return;
        }

        const line = '\u2500'.repeat(30);

        console.log('');
        console.log('  Platform Statistics');
        console.log(`  ${line}`);
        console.log(`  Teams:      ${stats.totalTeams}`);
        console.log(`  Users:      ${stats.totalUsers}`);
        console.log(`  Documents:  ${stats.totalDocuments}`);

        // Show any additional stats returned by the API
        const knownKeys = new Set(['totalTeams', 'totalUsers', 'totalDocuments']);
        for (const [key, value] of Object.entries(stats)) {
          if (!knownKeys.has(key)) {
            const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
            console.log(`  ${label.padEnd(12)}${value}`);
          }
        }

        console.log('');
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });
}
