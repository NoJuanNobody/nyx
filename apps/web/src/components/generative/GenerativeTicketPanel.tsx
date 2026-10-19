/**
 * GenerativeTicketPanel — uses Hashbrown's useUiChat to stream TicketStagingWidget
 * instances from the model when document changes are staged for ticketing.
 *
 * Usage: mount in the Tickets page GeneratedTab alongside the static list.
 * Pass the document diff / change summary; the model streams proposed tickets
 * as editable TicketStagingWidget components.
 */
import { useEffect } from 'react';
import { useUiChat, exposeComponent } from '@hashbrownai/react';
import { s } from '@hashbrownai/core';
import { TicketStagingWidget } from './TicketStagingWidget';
import type { TicketPriority } from './TicketStagingWidget';

// ── Component schema ─────────────────────────────────────────────────────────

const exposedTicketWidget = exposeComponent(TicketStagingWidget, {
  name: 'TicketStagingWidget',
  description:
    'Shows a single proposed ticket that the user can edit and approve before dispatching to GitHub or Jira.',
  props: {
    title: s.streaming.string('Concise ticket title').optional(),
    description: s.streaming.string('Full ticket description in Markdown').optional(),
    priority: s
      .enum(['low', 'medium', 'high', 'critical'], 'Ticket priority')
      .optional(),
    labels: s.array(s.string('A label or tag'), 'Labels for the ticket').optional(),
    targetRepo: s.string('GitHub owner/repo target, if applicable').optional(),
  },
});

// ── Panel ────────────────────────────────────────────────────────────────────

export interface GenerativeTicketPanelProps {
  /** Raw document diff or summary of changes to convert to tickets */
  changeSummary: string;
  /** Called when user approves a ticket for dispatch */
  onDispatch?: (ticket: {
    title: string;
    description: string;
    priority: TicketPriority;
    labels: string[];
  }) => void;
}

export function GenerativeTicketPanel({ changeSummary, onDispatch }: GenerativeTicketPanelProps) {
  const chat = useUiChat({
    system: `You are a Nyx ticket writer. You receive a summary of documentation changes made by a non-technical stakeholder.
Break the changes into logical, well-scoped tickets that a developer can act on.
Render each ticket as a TicketStagingWidget with a clear title, description, priority, and labels.
- Keep titles short (< 60 chars).
- Descriptions should include acceptance criteria.
- Group related small changes into one ticket; split large changes.
- Default priority: medium; use high for breaking changes, low for cosmetic ones.`,
    components: [exposedTicketWidget],
  });

  useEffect(() => {
    if (chat.messages.length === 0) {
      chat.sendMessage({
        role: 'user',
        content: `Please propose tickets for the following documentation changes:\n\n${changeSummary}`,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (chat.isLoading && chat.messages.length <= 1) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-slate-500" data-testid="ticket-panel-loading">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
        Generating ticket proposals…
      </div>
    );
  }

  if (chat.error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" data-testid="ticket-panel-error">
        Failed to generate tickets: {chat.error.message}
      </div>
    );
  }

  const assistantMessages = chat.messages.filter((m) => m.role === 'assistant');
  if (assistantMessages.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="generative-ticket-panel">
      {assistantMessages.map((message, i) =>
        message.role === 'assistant' ? (
          <div key={i} data-testid={`generative-ticket-message-${i}`}>
            {typeof message.ui !== 'undefined'
              ? message.ui
              : message.content && (
                  <p className="text-sm text-slate-600">{String(message.content)}</p>
                )}
          </div>
        ) : null,
      )}
    </div>
  );
}
