import { Command } from 'commander';
import { NyxClient } from '../client.js';
import { formatOutput, formatTable, timeAgo, error, type OutputFormat } from '../utils/output.js';

interface Notification {
  id: string;
  eventType: string;
  title?: string;
  message?: string;
  readAt: string | null;
  createdAt: string;
  [key: string]: unknown;
}

interface NotificationListResponse {
  items: Notification[];
  nextCursor: string | null;
  unreadCount: number;
}

interface NotificationPreference {
  id: string;
  eventType: string;
  inApp: boolean;
  emailEnabled: boolean;
  emailMode: string;
  [key: string]: unknown;
}

export function registerNotificationsCommand(program: Command): void {
  const notifications = program
    .command('notifications')
    .description('Manage notifications and preferences');

  notifications
    .command('list')
    .description('List notifications')
    .option('--read <read>', 'Filter by read status (true|false)')
    .option('--event-type <type>', 'Filter by event type')
    .option('--limit <n>', 'Limit results (max 50)')
    .option('--cursor <cursor>', 'Pagination cursor (ISO date)')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(
      async (opts: {
        read?: string;
        eventType?: string;
        limit?: string;
        cursor?: string;
        format: OutputFormat;
      }) => {
        const client = new NyxClient();
        const params = new URLSearchParams();
        if (opts.read) params.set('read', opts.read);
        if (opts.eventType) params.set('event_type', opts.eventType);
        if (opts.limit) params.set('limit', opts.limit);
        if (opts.cursor) params.set('cursor', opts.cursor);

        const qs = params.toString();
        const path = `/api/notifications${qs ? `?${qs}` : ''}`;

        try {
          const data = await client.get<NotificationListResponse>(path);
          if (opts.format === 'json') {
            console.log(formatOutput(data, 'json'));
          } else {
            console.log(
              formatTable(data.items as unknown as Record<string, unknown>[], [
                {
                  key: 'readAt',
                  label: '',
                  width: 2,
                  transform: (v) => (v ? ' ' : '*'),
                },
                { key: 'eventType', label: 'Event', width: 28 },
                { key: 'title', label: 'Title', width: 40 },
                {
                  key: 'createdAt',
                  label: 'When',
                  transform: (v) => timeAgo(String(v)),
                },
                { key: 'id', label: 'ID', width: 36 },
              ]),
            );
            console.log(`\n${data.items.length} notification(s), ${data.unreadCount} unread`);
          }
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );

  notifications
    .command('read <id>')
    .description('Mark a notification as read')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (id: string, opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.patch<Record<string, unknown>>(
          `/api/notifications/${id}/read`,
        );
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  notifications
    .command('read-all')
    .description('Mark all notifications as read')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(async (opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.patch<Record<string, unknown>>(
          '/api/notifications/read-all',
        );
        console.log(formatOutput(data, opts.format));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  notifications
    .command('preferences')
    .description('View notification preferences')
    .option('--format <format>', 'Output format (json|table)', 'table')
    .action(async (opts: { format: OutputFormat }) => {
      const client = new NyxClient();
      try {
        const data = await client.get<NotificationPreference[]>('/api/notifications/preferences');
        if (opts.format === 'json') {
          console.log(formatOutput(data, 'json'));
        } else {
          console.log(
            formatTable(data as unknown as Record<string, unknown>[], [
              { key: 'eventType', label: 'Event Type', width: 30 },
              {
                key: 'inApp',
                label: 'In-App',
                width: 8,
                transform: (v) => (v ? 'on' : 'off'),
              },
              {
                key: 'emailEnabled',
                label: 'Email',
                width: 8,
                transform: (v) => (v ? 'on' : 'off'),
              },
              { key: 'emailMode', label: 'Email Mode', width: 10 },
            ]),
          );
          console.log(`\n${data.length} preference(s)`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    });

  notifications
    .command('set <eventType>')
    .description('Update preference for an event type')
    .option('--in-app <enabled>', 'Enable in-app notifications (true|false)')
    .option('--email <enabled>', 'Enable email notifications (true|false)')
    .option('--email-mode <mode>', 'Email mode (instant|daily|weekly|off)')
    .option('--format <format>', 'Output format (json|table)', 'json')
    .action(
      async (
        eventType: string,
        opts: {
          inApp?: string;
          email?: string;
          emailMode?: string;
          format: OutputFormat;
        },
      ) => {
        const client = new NyxClient();
        const body: Record<string, unknown> = {};
        if (opts.inApp !== undefined) body.inApp = opts.inApp === 'true';
        if (opts.email !== undefined) body.emailEnabled = opts.email === 'true';
        if (opts.emailMode) body.emailMode = opts.emailMode;

        try {
          const data = await client.patch<Record<string, unknown>>(
            `/api/notifications/preferences/${eventType}`,
            body,
          );
          console.log(formatOutput(data, opts.format));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
        }
      },
    );
}
