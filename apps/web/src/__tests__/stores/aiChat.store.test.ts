import { describe, it, expect, beforeEach } from 'vitest';
import { useAIChatStore, QUICK_EDIT_VALUE } from '../../stores/aiChat.store.js';

describe('AI Chat Store', () => {
  beforeEach(() => {
    useAIChatStore.setState({ sessions: {} });
  });

  it('ensureSession lazily creates an empty session and returns same reference on subsequent reads', () => {
    const store = useAIChatStore.getState();
    expect(store.sessions['doc-A']).toBeUndefined();

    const sessionA = store.ensureSession('doc-A');
    expect(sessionA.messages).toEqual([]);
    expect(sessionA.prompt).toBe('');
    expect(sessionA.selectedWorkflow).toBe(QUICK_EDIT_VALUE);
    expect(sessionA.streamingContent).toBe('');
    expect(sessionA.status).toBe('idle');
    expect(sessionA.tokenUsage).toBeNull();

    // The reference should be stable across reads as long as no mutation occurred.
    const sessionAgain = useAIChatStore.getState().sessions['doc-A'];
    expect(sessionAgain).toBe(sessionA);
    // messages array reference stable too
    expect(useAIChatStore.getState().sessions['doc-A'].messages).toBe(sessionA.messages);
  });

  it('appendMessage on session A does not bleed into session B', () => {
    const store = useAIChatStore.getState();
    store.ensureSession('doc-A');
    store.ensureSession('doc-B');

    store.appendMessage('doc-A', { kind: 'user', content: 'hello A', timestamp: new Date() }, 1);

    const a = useAIChatStore.getState().sessions['doc-A'];
    const b = useAIChatStore.getState().sessions['doc-B'];
    expect(a.messages).toHaveLength(1);
    expect(b.messages).toHaveLength(0);
    expect(a.messages[0]).toMatchObject({ kind: 'user', content: 'hello A', id: 1 });
  });

  it('reset(documentId) clears only that document and leaves others untouched', () => {
    const store = useAIChatStore.getState();
    store.appendMessage('doc-A', { kind: 'user', content: 'A1', timestamp: new Date() }, 1);
    store.appendMessage('doc-A', { kind: 'assistant', content: 'A2', timestamp: new Date() }, 2);
    store.appendMessage('doc-B', { kind: 'user', content: 'B1', timestamp: new Date() }, 1);
    store.setPrompt('doc-A', 'draft prompt');
    store.setStatus('doc-A', 'completed');

    store.reset('doc-A');

    const a = useAIChatStore.getState().sessions['doc-A'];
    const b = useAIChatStore.getState().sessions['doc-B'];
    expect(a.messages).toEqual([]);
    expect(a.prompt).toBe('');
    expect(a.status).toBe('idle');
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]).toMatchObject({ kind: 'user', content: 'B1' });
  });

  it('setPrompt / setSelectedWorkflow / setStatus / setTokenUsage update only the targeted session', () => {
    const store = useAIChatStore.getState();
    store.setPrompt('doc-A', 'hello');
    store.setSelectedWorkflow('doc-A', 'workflow-x');
    store.setStatus('doc-A', 'running');
    store.setTokenUsage('doc-A', { inputTokens: 10, outputTokens: 5 });

    const a = useAIChatStore.getState().sessions['doc-A'];
    expect(a.prompt).toBe('hello');
    expect(a.selectedWorkflow).toBe('workflow-x');
    expect(a.status).toBe('running');
    expect(a.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });

    expect(useAIChatStore.getState().sessions['doc-B']).toBeUndefined();
  });

  it('updateMessage applies a transform over a session messages array', () => {
    const store = useAIChatStore.getState();
    store.appendMessage('doc-A', { kind: 'user', content: 'first', timestamp: new Date() }, 1);
    store.appendMessage('doc-A', { kind: 'assistant', content: 'reply', timestamp: new Date() }, 2);

    store.updateMessage('doc-A', (prev) =>
      prev.map((m) => (m.kind === 'assistant' ? { ...m, content: 'updated reply' } : m)),
    );

    const messages = useAIChatStore.getState().sessions['doc-A'].messages;
    expect(messages[1]).toMatchObject({ kind: 'assistant', content: 'updated reply' });
  });
});
