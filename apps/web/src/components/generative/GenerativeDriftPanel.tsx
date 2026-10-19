/**
 * GenerativeDriftPanel — uses Hashbrown's useUiChat to stream DriftResolutionCard
 * instances from the model when drift is detected.
 *
 * Usage: mount this panel when a drift event is clicked; pass specContent and
 * codeContent. The model will stream one or more DriftResolutionCard components
 * with interactive resolution actions.
 */
import { useEffect } from 'react';
import { useUiChat, exposeComponent } from '@hashbrownai/react';
import { s } from '@hashbrownai/core';
import { DriftResolutionCard } from './DriftResolutionCard';

// ── Component schema exposed to the model ────────────────────────────────────

const exposedDriftCard = exposeComponent(DriftResolutionCard, {
  name: 'DriftResolutionCard',
  description:
    'Renders an interactive drift resolution card showing what drifted between the spec and code, with actionable recommendations for the user.',
  props: {
    summary: s.streaming.string('Brief human-readable explanation of the drift'),
    specSnippet: s.streaming.string('The spec excerpt that is out of sync').optional(),
    codeSnippet: s.streaming.string('The code excerpt that diverged from the spec').optional(),
    severity: s.enum(['low', 'medium', 'high'], 'How severe this drift is').optional(),
    recommendations: s
      .array(s.string('A short action label the user can take'), 'Actions available to resolve this drift')
      .optional(),
  },
});

// ── Panel ────────────────────────────────────────────────────────────────────

export interface GenerativeDriftPanelProps {
  specContent: string;
  codeContent: string;
  documentId?: string;
  /** Called when user picks an action from a card */
  onAction?: (action: string, cardSummary: string) => void;
}

export function GenerativeDriftPanel({
  specContent,
  codeContent,
  documentId,
  onAction,
}: GenerativeDriftPanelProps) {
  const chat = useUiChat({
    system: `You are a Nyx drift analyst. The user has provided a spec document and the corresponding code.
Analyze the differences and render one DriftResolutionCard for each meaningful discrepancy you find.
Focus on semantic drift — where the code's behavior no longer matches the spec's intent.
Be concise: each card's summary should fit in 2 sentences.
Order cards from highest to lowest severity.`,
    components: [exposedDriftCard],
  });

  // Trigger analysis on mount
  useEffect(() => {
    if (chat.messages.length === 0) {
      chat.sendMessage({
        role: 'user',
        content: `Please analyze the following spec and code for drift.${documentId ? ` Document ID: ${documentId}.` : ''}

## Spec
\`\`\`
${specContent}
\`\`\`

## Code
\`\`\`
${codeContent}
\`\`\`

Render a DriftResolutionCard for each discrepancy you find.`,
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (chat.isLoading && chat.messages.length <= 1) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-slate-500" data-testid="drift-panel-loading">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
        Analyzing drift…
      </div>
    );
  }

  if (chat.error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" data-testid="drift-panel-error">
        Failed to analyze drift: {chat.error.message}
      </div>
    );
  }

  const assistantMessages = chat.messages.filter((m) => m.role === 'assistant');
  if (assistantMessages.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="generative-drift-panel">
      {assistantMessages.map((message, i) =>
        message.role === 'assistant' ? (
          <div key={i}>
            {message.ui}
          </div>
        ) : null,
      )}
    </div>
  );
}
