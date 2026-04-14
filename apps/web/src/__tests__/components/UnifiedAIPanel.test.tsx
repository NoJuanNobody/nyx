import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UnifiedAIPanel } from '../../components/UnifiedAIPanel';
import { useAIChatStore } from '../../stores/aiChat.store';

// jsdom doesn't implement scrollIntoView; the panel calls it in an effect.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('../../lib/api', () => ({
  generateDocument: vi.fn(),
  editDocumentAI: vi.fn(),
  fetchWorkflows: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../lib/agent-stream', () => ({
  startAgentStream: vi.fn().mockReturnValue({ abort: vi.fn() }),
}));

vi.mock('../../components/MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

function renderPanel(props: { documentId: string; teamId?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UnifiedAIPanel
        content="existing doc body"
        onProposedEdit={() => {}}
        isNewDocument={false}
        onGenerate={() => {}}
        isReviewMode={false}
        documentId={props.documentId}
        teamId={props.teamId ?? 'team-1'}
      />
    </QueryClientProvider>,
  );
}

describe('UnifiedAIPanel — store-backed session persistence', () => {
  beforeEach(() => {
    useAIChatStore.setState({ sessions: {} });
  });

  it('persists messages across remount on the same documentId', () => {
    // Seed the conversation in the store first (simulates a chat that
    // happened in a previous mount of the panel).
    useAIChatStore
      .getState()
      .appendMessage(
        'doc-A',
        { kind: 'user', content: 'remember me across remount', timestamp: new Date() },
        1,
      );
    useAIChatStore
      .getState()
      .appendMessage(
        'doc-A',
        { kind: 'assistant', content: 'sure thing', timestamp: new Date() },
        2,
      );

    // Mount on doc A — the panel should pick up the seeded messages.
    const { unmount } = renderPanel({ documentId: 'doc-A' });
    expect(screen.getByText('remember me across remount')).toBeInTheDocument();
    expect(screen.getByText('sure thing')).toBeInTheDocument();

    unmount();

    // Remount on the same doc — messages should still be there.
    renderPanel({ documentId: 'doc-A' });
    expect(screen.getByText('remember me across remount')).toBeInTheDocument();
    expect(screen.getByText('sure thing')).toBeInTheDocument();
  });

  it('cross-document isolation: switching to doc B shows empty, returning to A restores history', () => {
    // Seed a conversation on doc A.
    useAIChatStore
      .getState()
      .appendMessage(
        'doc-A',
        { kind: 'user', content: 'A only message', timestamp: new Date() },
        1,
      );

    const { unmount: unmountA } = renderPanel({ documentId: 'doc-A' });
    expect(screen.getByText('A only message')).toBeInTheDocument();
    unmountA();

    // Mount on doc B — should not show A's messages.
    const { unmount: unmountB } = renderPanel({ documentId: 'doc-B' });
    expect(screen.queryByText('A only message')).not.toBeInTheDocument();
    unmountB();

    // Mount on A again — message restored.
    renderPanel({ documentId: 'doc-A' });
    expect(screen.getByText('A only message')).toBeInTheDocument();
  });

  it('unmounting while status is running resets status to idle so a remount does not show a stale running indicator', () => {
    // Seed a message to make the chat non-empty (so the status bar logic exists),
    // and set status to running.
    useAIChatStore
      .getState()
      .appendMessage(
        'doc-C',
        { kind: 'user', content: 'in flight', timestamp: new Date() },
        1,
      );
    useAIChatStore.getState().setStatus('doc-C', 'running');

    const { unmount } = renderPanel({ documentId: 'doc-C' });
    unmount();

    // After unmount, the cleanup effect should have reset the status to idle.
    expect(useAIChatStore.getState().sessions['doc-C'].status).toBe('idle');
    // History is preserved.
    expect(useAIChatStore.getState().sessions['doc-C'].messages).toHaveLength(1);
  });
});
